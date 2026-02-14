#!/usr/bin/env node
const http = require('http');

const port = Number.parseInt(process.argv[2], 10);
const secret = typeof process.argv[3] === 'string' ? process.argv[3] : '';

const fallback = JSON.stringify({
    continue: true,
    suppressOutput: true,
    hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
    },
});

if (!port || Number.isNaN(port)) {
    process.stdout.write(fallback);
    process.exit(0);
}

const chunks = [];
process.stdin.on('data', (chunk) => {
    chunks.push(chunk);
});

process.stdin.on('end', () => {
    const body = Buffer.concat(chunks);
    const headers = {
        'Content-Type': 'application/json',
        'Content-Length': body.length,
    };
    if (secret.length > 0) {
        headers['x-happier-hook-secret'] = secret;
    }

    const req = http.request(
        {
            host: '127.0.0.1',
            port,
            method: 'POST',
            path: '/hook/permission-request',
            headers,
        },
        (res) => {
            const responseChunks = [];
            res.on('data', (chunk) => {
                responseChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            });
            res.on('end', () => {
                const statusCode = res.statusCode ?? 0;
                if (statusCode < 200 || statusCode >= 300) {
                    process.stdout.write(fallback);
                    return;
                }
                const payload = Buffer.concat(responseChunks).toString('utf8').trim();
                process.stdout.write(payload || fallback);
            });
        },
    );

    req.on('error', () => {
        process.stdout.write(fallback);
    });

    req.end(body);
});

process.stdin.resume();
