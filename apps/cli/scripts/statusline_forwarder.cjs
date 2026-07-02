#!/usr/bin/env node
/**
 * Statusline Forwarder
 *
 * Installed as the Claude Code `statusLine.command` for Happier-spawned unified terminal
 * sessions. Claude pipes a structured JSON status payload on stdin (~300ms debounce). This
 * script:
 *
 *   1. POSTs the payload to Happier's session hook server (`/hook/statusline`) with the
 *      shared secret — fire-and-forget, short timeout, all errors swallowed. The secret is
 *      read from a 0600 secret file (`--secret-file`), NEVER from argv, so it cannot leak
 *      through world-readable process listings.
 *   2. In PARALLEL, exec-chains the user's ORIGINAL statusline command (`--original-b64`),
 *      piping the SAME stdin payload and passing stdout/exit code through untouched, so
 *      the user's visible status bar is byte-preserved.
 *   3. With no original configured, prints a minimal model line (display name → id →
 *      "Claude") so the status bar is never pathologically broken.
 *
 * Fail-open everywhere: a broken forwarder must never break the user's statusline.
 * Never writes forwarder noise to stderr (the chained command's own stderr passes through).
 *
 * Usage: node statusline_forwarder.cjs <port> [--secret-file <path>] [--original-b64 <b64>]
 */

const http = require('http');
const fs = require('fs');
const { spawn } = require('child_process');

const POST_TIMEOUT_MS = 400;

const port = Number.parseInt(process.argv[2], 10);

function readFlag(args, flag) {
    const index = args.indexOf(flag);
    if (index === -1 || typeof args[index + 1] !== 'string' || args[index + 1].length === 0) {
        return null;
    }
    return args[index + 1];
}

function readSecret(args) {
    const secretFile = readFlag(args, '--secret-file');
    if (!secretFile) return '';
    try {
        return fs.readFileSync(secretFile, 'utf8').trim();
    } catch {
        return '';
    }
}

const flagArgs = process.argv.slice(3);
const secret = readSecret(flagArgs);
const rawOriginal = readFlag(flagArgs, '--original-b64') || '';

function decodeOriginalCommand(value) {
    if (!value) return null;
    // Strict validation: Buffer.from(.., 'base64') silently ignores invalid characters,
    // which would exec garbage. An undecodable original is treated as absent (fallback line).
    if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return null;
    try {
        const decoded = Buffer.from(value, 'base64').toString('utf8');
        return decoded.trim().length > 0 ? decoded : null;
    } catch {
        return null;
    }
}

function buildFallbackLine(body) {
    try {
        const parsed = JSON.parse(body.toString('utf8'));
        const model = parsed && typeof parsed === 'object' ? parsed.model : null;
        if (model && typeof model === 'object') {
            if (typeof model.display_name === 'string' && model.display_name.trim()) return model.display_name.trim();
            if (typeof model.id === 'string' && model.id.trim()) return model.id.trim();
        }
    } catch {
        // Unparseable payload: generic label below.
    }
    return 'Claude';
}

function postPayload(body) {
    if (!port || Number.isNaN(port)) {
        return;
    }
    try {
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
                path: '/hook/statusline',
                headers,
                // Idle timeout: a hook server that accepts but never responds must not hold
                // the status bar hostage; the request is destroyed and the process exits on
                // its own once the exec chain (or fallback line) is done.
                timeout: POST_TIMEOUT_MS,
            },
            (res) => {
                res.resume();
            },
        );
        req.on('timeout', () => {
            req.destroy();
        });
        req.on('error', () => {
            // Fire-and-forget: server down or refusing is never the user's problem.
        });
        req.end(body);
    } catch {
        // Fire-and-forget.
    }
}

function chainOriginal(originalCommand, body) {
    let child;
    try {
        child = spawn(originalCommand, {
            shell: true,
            stdio: ['pipe', 'pipe', 'inherit'],
        });
    } catch {
        process.stdout.write(buildFallbackLine(body) + '\n');
        return;
    }
    // Pass the chained command's stdout through byte-for-byte while tracking whether it produced
    // ANY visible output (needed for the failed-with-no-output fallback below).
    let chainWroteOutput = false;
    child.stdout.on('data', (chunk) => {
        chainWroteOutput = chainWroteOutput || chunk.length > 0;
        process.stdout.write(chunk);
    });
    child.stdout.on('error', () => {});
    child.on('error', () => {
        process.stdout.write(buildFallbackLine(body) + '\n');
        process.exitCode = 0;
    });
    child.on('close', (code) => {
        // QA-B F7 (ported from remote-dev, live 2026-06-12): NEVER propagate a failing user
        // statusline as a failing statusLine command. Claude Code marks a non-zero statusLine
        // command as a setup issue ("1 setup issue: statusline") and stops invoking it, which
        // silently kills Happier's statusline truth feed. The user's visible bar keeps the
        // chain's own output when there was any; a failure with no output degrades to the
        // minimal model line instead of a blank, broken bar.
        if (typeof code === 'number' && code !== 0 && !chainWroteOutput) {
            process.stdout.write(buildFallbackLine(body) + '\n');
        }
        process.exitCode = 0;
    });
    try {
        child.stdin.on('error', () => {});
        child.stdin.end(body);
    } catch {
        // Chained command closed stdin early: its output still passes through.
    }
}

const chunks = [];
process.stdin.on('data', (chunk) => {
    chunks.push(chunk);
});

process.stdin.on('end', () => {
    const body = Buffer.concat(chunks);
    // Fire-and-forget POST in parallel with the exec chain: rendering must never wait on it.
    postPayload(body);

    const originalCommand = decodeOriginalCommand(rawOriginal);
    if (originalCommand) {
        chainOriginal(originalCommand, body);
        return;
    }
    process.stdout.write(buildFallbackLine(body) + '\n');
});

process.stdin.resume();
