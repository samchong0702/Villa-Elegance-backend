import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { google } from 'googleapis';
import multer from 'multer';
import { Readable } from 'stream';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

// Multer setup for file uploads (memory storage for direct API streaming)
const upload = multer({ storage: multer.memoryStorage() });

// ==========================================
// Google Drive API Configuration
// ==========================================
// We use an OAuth2 Refresh Token instead of a Service Account to bypass 
// the 0-byte storage quota restriction on standard Gmail accounts.
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  'https://developers.google.com/oauthplayground' // Redirect URI
);

oauth2Client.setCredentials({
  refresh_token: process.env.GOOGLE_REFRESH_TOKEN
});

const drive = google.drive({ version: 'v3', auth: oauth2Client });
const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

// ==========================================
// API Routes
// ==========================================

const rawAllowedFolderIds = process.env.ALLOWED_FOLDER_IDS || '';
console.log('--- STARTING SERVER ---');
console.log('RAW ALLOWED_FOLDER_IDS from .env:', rawAllowedFolderIds);

const allowedFolders = rawAllowedFolderIds 
  ? rawAllowedFolderIds.split(',').map(id => id.trim()).filter(id => id) 
  : [];
console.log('Parsed allowedFolders array:', allowedFolders);

/**
 * GET /api/folders
 * Queries the Drive API for items where mimeType is a folder.
 */
app.get('/api/folders', async (req, res) => {
  try {
    if (allowedFolders.length > 0) {
      // 1. Fetch the allowed root folders themselves
      const rootFolderPromises = allowedFolders.map(id => 
        drive.files.get({
          fileId: id,
          fields: 'id, name'
        }).then(response => response.data)
          .catch(err => {
            console.warn(`Warning: Could not fetch allowed folder ID ${id}:`, err.message);
            return null;
          })
      );
      const rootFolders = (await Promise.all(rootFolderPromises)).filter(f => f !== null);

      // 2. Fetch the immediate sub-folders of these root folders
      const parentQueries = allowedFolders.map(id => `'${id}' in parents`).join(' or ');
      const subFoldersResponse = await drive.files.list({
        q: `(${parentQueries}) and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
        fields: 'files(id, name)',
        spaces: 'drive',
      });
      const subFolders = subFoldersResponse.data.files || [];

      // Combine root folders and sub-folders
      return res.json({ folders: [...rootFolders, ...subFolders] });
    }

    // If no restricted folders, just fetch everything
    const response = await drive.files.list({
      q: "mimeType = 'application/vnd.google-apps.folder' and trashed = false",
      fields: 'files(id, name)',
      spaces: 'drive',
    });

    res.json({ folders: response.data.files });
  } catch (error) {
    console.error('Error fetching folders:', error);
    res.status(500).json({ error: error.message || 'Failed to fetch folders from Google Drive' });
  }
});

/**
 * GET /api/search
 * Queries the Drive API for files matching the keyword.
 */
app.get('/api/search', async (req, res) => {
  const { q } = req.query;

  if (!q) {
    return res.status(400).json({ error: 'Search query is required' });
  }

  try {
    // The strict query logic specified in Phase 4
    let searchQuery = `(name contains '${q}' or fullText contains '${q}') and trashed = false and mimeType != 'application/vnd.google-apps.folder'`;

    if (allowedFolders.length > 0) {
      // To search in root folders AND their sub-folders, we first get the sub-folder IDs
      const parentQueries = allowedFolders.map(id => `'${id}' in parents`).join(' or ');
      const subFoldersResponse = await drive.files.list({
        q: `(${parentQueries}) and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
        fields: 'files(id)',
        spaces: 'drive',
      });
      const subFolderIds = (subFoldersResponse.data.files || []).map(f => f.id);
      
      // Combine root folder IDs and sub-folder IDs
      const allAllowedParents = [...allowedFolders, ...subFolderIds];
      const allParentQueries = allAllowedParents.map(id => `'${id}' in parents`).join(' or ');
      
      searchQuery += ` and (${allParentQueries})`;
    }

    const response = await drive.files.list({
      q: searchQuery,
      fields: 'files(id, name, webViewLink, mimeType)',
      spaces: 'drive',
    });

    res.json({ files: response.data.files });
  } catch (error) {
    console.error('Error searching files:', error);
    res.status(500).json({ error: 'Failed to search files in Google Drive' });
  }
});

/**
 * GET /api/download-pdf
 * Fetches a PDF file from Google Drive and streams it to the client.
 */
app.get('/api/download-pdf', async (req, res) => {
  const { fileId } = req.query;

  if (!fileId) {
    return res.status(400).json({ error: 'fileId query parameter is required' });
  }

  try {
    const response = await drive.files.get(
      { fileId, alt: 'media' },
      { responseType: 'stream' }
    );

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="print.pdf"');

    response.data
      .on('error', err => {
        console.error('Error streaming file:', err);
        if (!res.headersSent) {
          res.status(500).json({ error: 'Error streaming file from Google Drive' });
        }
      })
      .pipe(res);
  } catch (error) {
    console.error('Error fetching file from Google Drive:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to fetch file from Google Drive' });
    }
  }
});

/**
 * POST /api/upload
 * Uploads a file to a specific Google Drive folder.
 */
app.post('/api/upload', upload.single('file'), async (req, res) => {
  const { folderId, fileName, description } = req.body;
  const file = req.file;

  if (!file || !folderId || !fileName) {
    return res.status(400).json({ error: 'Missing required fields: file, folderId, fileName' });
  }

  try {
    const fileMetadata = {
      name: fileName,
      parents: [folderId],
      description: description || ''
    };

    const media = {
      mimeType: file.mimetype,
      body: Readable.from(file.buffer)
    };

    const response = await drive.files.create({
      requestBody: fileMetadata,
      media: media,
      fields: 'id, name, webViewLink'
    });

    // Send email notification via Gmail API
    try {
      const from = process.env.GOOGLE_CLIENT_EMAIL || 'app@villaelegance.com';
      const to = process.env.ADMIN_EMAIL || 'samchong0702@gmail.com';
      const subject = `New File Uploaded: ${fileName}`;
      const messageText = `New file "${fileName}" uploaded to folder "${folderId}" with description: ${description || 'No description provided.'}\nView file here: ${response.data.webViewLink}`;

      const utf8Subject = `=?utf-8?B?${Buffer.from(subject).toString('base64')}?=`;
      const messageParts = [
        `From: "Villa Elegance App" <${from}>`,
        `To: ${to}`,
        `Subject: ${utf8Subject}`,
        'Content-Type: text/plain; charset=utf-8',
        'MIME-Version: 1.0',
        '',
        messageText
      ];
      
      const emailMessage = messageParts.join('\r\n');
      const encodedEmail = Buffer.from(emailMessage)
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');

      await gmail.users.messages.send({
        userId: 'me',
        requestBody: {
          raw: encodedEmail
        }
      });
      console.log('Notification email sent via Gmail API!');
    } catch (emailError) {
      console.error('Error sending email notification via Gmail API:', emailError);
    }

    res.json({
      success: true,
      file: response.data
    });
  } catch (error) {
    console.error('Error uploading file to Google Drive:', error);
    res.status(500).json({ error: error.message || 'Failed to upload file to Google Drive' });
  }
});

app.listen(PORT, () => {
  console.log(`Backend server running on http://localhost:${PORT}`);
});
