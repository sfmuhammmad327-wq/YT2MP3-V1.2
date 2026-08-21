const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const youtubedl = require('youtube-dl-exec');
const NodeID3 = require('node-id3');
const fs = require('fs');
const path = require('path');
const os = require('os');

const app = express();
const PORT = 5000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));

process.on('uncaughtException', (err) => {
    console.error(`\n❌ [UNCAUGHT EXCEPTION] ${err && err.message ? err.message : err}`);
});
process.on('unhandledRejection', (reason) => {
    console.error(`\n❌ [UNHANDLED REJECTION] ${reason && reason.message ? reason.message : reason}`);
});

const tasks = {};

const tempDir = path.join(os.tmpdir(), 'yt2mp3_server_temp');
if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

setInterval(() => {
    const now = Date.now();
    for (const [taskId, task] of Object.entries(tasks)) {
        if (now - task.timestamp > 30 * 60 * 1000) { 
            delete tasks[taskId];
        }
    }
    
    fs.readdir(tempDir, (err, files) => {
        if (err) return;
        files.forEach(file => {
            const filePath = path.join(tempDir, file);
            fs.stat(filePath, (err, stats) => {
                if (err) return;
                if (now - stats.mtimeMs > 30 * 60 * 1000) {
                    try { fs.unlinkSync(filePath); } catch (e) {}
                }
            });
        });
    });
}, 15 * 60 * 1000);

function drawProgressBar(percentage, stepName) {
    const width = 30;
    const completed = Math.floor((percentage / 100) * width);
    const empty = width - completed;
    const bar = '█'.repeat(completed) + '░'.repeat(empty);
    process.stdout.write(`\r⏳ ${stepName} [${bar}] ${parseFloat(percentage).toFixed(1)}% `);
}

const YTDLP_CLIENT_FALLBACKS = ['android', 'ios', 'tv', 'web_safari', 'web'];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isPermanentYtError(msg) {
    return /video unavailable|private video|this video is (?:not available|no longer available)|video has been removed|account associated with this video has been terminated|copyright|does not exist|no longer available|members-only|premieres in|this live event will begin/i.test(msg || '');
}

app.post('/convert', async (req, res) => {
    const { url, bitrate, metadata, image } = req.body;
    
    if (!url) return res.status(400).json({ error: 'URL is required' });

    const taskId = uuidv4();
    tasks[taskId] = { status: 'downloading', progress: 0, timestamp: Date.now() };
    
    res.json({ task_id: taskId });

    console.log(`\n==================================================`);
    console.log(`🚀 NEW CONVERSION INITIATED`);
    console.log(`🆔 Task ID: ${taskId}`);
    console.log(`🔗 Target URL: ${url}`);
    console.log(`==================================================`);

    const finalAudioPath = path.join(tempDir, `${taskId}_final.mp3`);

    try {
        let rawTitle = metadata && metadata.title;
        let rawArtist = metadata && metadata.artist;

        if (!rawTitle || !rawArtist) {
            console.log(`\n[1/3] 📡 Retrieving YouTube music data...`);

            let videoInfo = null;
            let lastMetaErr = null;
            for (let mi = 0; mi < YTDLP_CLIENT_FALLBACKS.length; mi++) {
                const client = YTDLP_CLIENT_FALLBACKS[mi];
                try {
                    videoInfo = await youtubedl(url, { dumpJson: true, noWarnings: true, forceIpv4: true, extractorArgs: `youtube:player_client=${client}`, retries: 3 });
                    break;
                } catch (e) {
                    lastMetaErr = e;
                    const isLastAttempt = mi === YTDLP_CLIENT_FALLBACKS.length - 1;
                    if (isPermanentYtError(e.message) || isLastAttempt) throw e;
                    console.log(`⚠️ Metadata lookup via '${client}' client blocked/failed (${(e.message || 'unknown error').slice(0, 80)}), trying next client...`);
                    await sleep(600);
                }
            }
            if (!videoInfo) throw lastMetaErr || new Error('Unable to retrieve video metadata from any client.');
            if (!rawTitle) rawTitle = videoInfo.title;
            if (!rawArtist) rawArtist = videoInfo.artist || videoInfo.uploader || videoInfo.channel || null;
        } else {
            console.log(`\n[1/3] 📡 Using client-supplied title & artist (skipping redundant metadata fetch)...`);
        }

        const safeTitle = (rawTitle || '').replace(/[<>:"\/\\|?*\x00-\x1F]/g, '').trim() || 'Unknown Track'; 
        
        console.log(`✅ Target Locked: "${safeTitle}"`);
        
        tasks[taskId].title = safeTitle;
        tasks[taskId].filename = `${safeTitle}.mp3`;
        tasks[taskId].progress = 10;

        console.log(`\n[2/3] ⬇️ Downloading and 🎵 Encoding to ${bitrate || '320'}kbps MP3...`);

        let downloadSucceeded = false;
        let lastDlErr = null;

        for (let i = 0; i < YTDLP_CLIENT_FALLBACKS.length; i++) {
            const client = YTDLP_CLIENT_FALLBACKS[i];

            if (fs.existsSync(finalAudioPath)) {
                try { fs.unlinkSync(finalAudioPath); } catch (e) {}
            }

            tasks[taskId].progress = 10;
            tasks[taskId].message = i === 0
                ? `Downloading via '${client}' client...`
                : `Retrying via '${client}' client (attempt ${i + 1}/${YTDLP_CLIENT_FALLBACKS.length})...`;
            console.log(`   ↳ Attempt ${i + 1}/${YTDLP_CLIENT_FALLBACKS.length}: player_client=${client}`);

            const dlArgs = {
                extractAudio: true,
                audioFormat: 'mp3',
                audioQuality: `${bitrate || '320'}K`,
                output: finalAudioPath,
                noWarnings: true,
                forceIpv4: true,
                extractorArgs: `youtube:player_client=${client}`,
                retries: 3
            };

            let stderrBuffer = '';
            let extractingStarted = false;
            let heartbeat = null;

            const beginExtractHeartbeat = () => {
                if (extractingStarted) return;
                extractingStarted = true;
                tasks[taskId].message = 'Extracting & encoding audio...';
                let simulated = tasks[taskId].progress || 75;
                heartbeat = setInterval(() => {
                    simulated = Math.min(simulated + 1, 79);
                    tasks[taskId].progress = simulated;
                }, 400);
            };

            try {
                const dlProcess = youtubedl.exec(url, dlArgs);

                dlProcess.stdout.on('data', (data) => {
                    const text = data.toString();
                    const match = text.match(/\[download\]\s+([\d\.]+)%/);
                    if (match) {
                        const pct = parseFloat(match[1]);
                        tasks[taskId].progress = 10 + Math.floor(pct * 0.65);
                        drawProgressBar(pct.toFixed(1), 'Downloading');
                        if (pct >= 100) beginExtractHeartbeat();
                    }
                    if (/\[ExtractAudio\]/.test(text)) beginExtractHeartbeat();
                });

                dlProcess.stderr.on('data', (data) => {
                    stderrBuffer += data.toString();
                });

                await dlProcess;
                if (heartbeat) clearInterval(heartbeat);

                if (!fs.existsSync(finalAudioPath)) {
                    throw new Error('yt-dlp failed to generate the final MP3 file.');
                }

                downloadSucceeded = true;
                console.log(`\n✅ Audio successfully downloaded and encoded via '${client}' client!`);
                break;

            } catch (err) {
                if (heartbeat) clearInterval(heartbeat);
                const combinedMsg = `${err.message || ''} ${stderrBuffer}`.trim();
                lastDlErr = new Error(combinedMsg || (err.message || 'Unknown download error'));

                const isLastAttempt = i === YTDLP_CLIENT_FALLBACKS.length - 1;
                if (isPermanentYtError(combinedMsg) || isLastAttempt) {
                    throw lastDlErr;
                }
                console.log(`\n⚠️ '${client}' client blocked/failed, retrying with next client...`);
                tasks[taskId].message = `'${client}' client blocked — retrying with next client...`;
                await sleep(600);
            }
        }

        if (!downloadSucceeded) throw lastDlErr || new Error('Unable to download from any client.');

        tasks[taskId].progress = 80;
        tasks[taskId].message = null;

        console.log(`\n[3/3] 🏷️ Injecting ID3 tags and Album Art...`);
        let tags = {};
        if (metadata) {
            tags = {
                title: metadata.title || safeTitle,
                artist: metadata.artist || rawArtist || 'Unknown Artist',
                album: metadata.album || 'Unknown Album',
                year: metadata.year || '',
                genre: metadata.genre || ''
            };
        }
        tasks[taskId].progress = 88;

        if (image) {
            try {
                const mimeMatch = image.match(/^data:(image\/[\w.+-]+);base64,/);
                const base64Data = image.replace(/^data:image\/[\w.+-]+;base64,/, "");
                const imageBuffer = Buffer.from(base64Data, 'base64');
                tags.image = {
                    mime: mimeMatch ? mimeMatch[1] : "image/jpeg",
                    type: { id: 3, name: "front cover" },
                    description: "Thumbnail",
                    imageBuffer: imageBuffer
                };
                console.log(`🖼️ Album Art attached (${mimeMatch ? mimeMatch[1] : 'image/jpeg'}).`);
            } catch (imgErr) {
                console.log(`⚠️ Failed to parse image buffer: ${imgErr.message}`);
            }
        }
        tasks[taskId].progress = 94;

        if (Object.keys(tags).length > 0) {
            const writeOk = NodeID3.write(tags, finalAudioPath);
            if (writeOk) {
                console.log(`✅ Metadata injected successfully!`);
            } else {
                console.log(`⚠️ Warning: node-id3 failed to write metadata lock.`);
            }
        }
        tasks[taskId].progress = 99;

        tasks[taskId].progress = 100;
        tasks[taskId].status = 'completed';

        const stats = fs.statSync(finalAudioPath);
        const fileSizeMB = (stats.size / (1024 * 1024)).toFixed(2);

        console.log(`\n🎉 TASK COMPLETE!`);
        console.log(`📄 MP3 File Details:`);
        console.table({
            "Filename": tasks[taskId].filename,
            "Size": `${fileSizeMB} MB`,
            "Bitrate": `${bitrate || '320'} kbps`,
            "Track Title": tags.title || '-',
            "Artist": tags.artist || '-',
            "Album": tags.album || '-'
        });
        console.log(`==================================================\n`);

    } catch (err) {
        console.log(`\n❌ ERROR ENCOUNTERED`);
        console.error(err.message);
        console.log(`==================================================\n`);
        
        tasks[taskId] = { 
            status: 'error', 
            error: err.message.substring(0, 200) 
        };

        if (fs.existsSync(finalAudioPath)) {
            try { fs.unlinkSync(finalAudioPath); } catch (e) {}
        }
    }
});

app.get('/thumbnail', async (req, res) => {
    const { url } = req.query;
    if (!url || typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
        return res.status(400).json({ error: 'A valid thumbnail url is required' });
    }
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);
        let upstream;
        try {
            upstream = await fetch(url, {
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
                signal: controller.signal
            });
        } finally {
            clearTimeout(timeout);
        }
        if (!upstream.ok) {
            return res.status(upstream.status).json({ error: `Upstream returned ${upstream.status}` });
        }
        const contentType = upstream.headers.get('content-type') || 'image/jpeg';
        const arrayBuffer = await upstream.arrayBuffer();
        res.set('Content-Type', contentType);
        res.set('Cache-Control', 'public, max-age=3600');
        res.send(Buffer.from(arrayBuffer));
    } catch (err) {
        res.status(502).json({ error: `Failed to fetch thumbnail: ${err.message}` });
    }
});

app.get('/status/:taskId', (req, res) => {
    const task = tasks[req.params.taskId];
    if (!task) return res.status(404).json({ error: 'Task not found' });
    res.json(task);
});

app.get('/download/:taskId', (req, res) => {
    const task = tasks[req.params.taskId];
    if (!task || task.status !== 'completed') {
        return res.status(400).send('File not ready or does not exist.');
    }

    const filePath = path.join(tempDir, `${req.params.taskId}_final.mp3`);
    res.download(filePath, task.filename, (err) => {
        if (!err) {
            setTimeout(() => {
                try { fs.unlinkSync(filePath); } catch (e) {}
            }, 5000);
        }
    });
});

const server = app.listen(PORT, () => {
    console.log(`\n==================================================`);
    console.log(`🚀 Advanced Converter Engine Backend is ONLINE`);
    console.log(`📡 Listening on: http://127.0.0.1:${PORT}`);
    console.log(`⏳ Waiting for tasks from Web Client...`);
    console.log(`==================================================\n`);
});

server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`\n❌ Port ${PORT} is already in use — is another copy of server.js already running?`);
        console.error(`   Close that process (or the other terminal window) and try again.\n`);
        process.exit(1);
    } else {
        console.error(`\n❌ Server failed to start: ${err.message}\n`);
        process.exit(1);
    }
});
