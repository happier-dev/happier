#!/usr/bin/env node
const http = require('http');
const fs = require('fs');

const port = Number.parseInt(process.argv[2], 10);
const rawThirdArg = typeof process.argv[3] === 'string' ? process.argv[3] : '';
const knownHookEvents = new Set(['PermissionRequest', 'PreToolUse']);
const hookEventName = knownHookEvents.has(rawThirdArg) ? rawThirdArg : '';

function readSecret(args) {
    if (args[0] !== '--secret-file' || typeof args[1] !== 'string' || args[1].length === 0) {
        return '';
    }
    try {
        return fs.readFileSync(args[1], 'utf8').trim();
    } catch {
        return '';
    }
}

const secret = readSecret(hookEventName ? process.argv.slice(4) : process.argv.slice(3));

function buildFallback() {
    return JSON.stringify({
        continue: true,
        suppressOutput: true,
        hookSpecificOutput: {
            hookEventName: hookEventName || 'PermissionRequest',
        },
    });
}

if (!port || Number.isNaN(port)) {
    process.stdout.write(buildFallback());
    process.exit(0);
}

const chunks = [];
process.stdin.on('data', (chunk) => {
    chunks.push(chunk);
});

process.stdin.on('end', () => {
    let body = Buffer.concat(chunks);
    if (hookEventName) {
        try {
            const parsed = JSON.parse(body.toString('utf8'));
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && typeof parsed.hook_event_name !== 'string') {
                parsed.hook_event_name = hookEventName;
                body = Buffer.from(JSON.stringify(parsed), 'utf8');
            }
        } catch {
            // Preserve original payload if Claude sends unexpected data.
        }
    }

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
                    process.stdout.write(buildFallback());
                    return;
                }
                const payload = Buffer.concat(responseChunks).toString('utf8').trim();
                process.stdout.write(payload || buildFallback());
            });
        },
    );

    req.on('error', () => {
        process.stdout.write(buildFallback());
    });

    req.end(body);
});

process.stdin.resume();
