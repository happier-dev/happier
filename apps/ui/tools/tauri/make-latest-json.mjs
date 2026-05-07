#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

function fail(message) {
    process.stderr.write(`[make-latest-json] ${message}\n`);
    process.exit(1);
}

function parseArgs(argv) {
    const out = new Map();
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (!arg.startsWith('--')) continue;
        const next = argv[i + 1];
        if (next && !next.startsWith('--')) {
            out.set(arg, next);
            i++;
        } else {
            out.set(arg, 'true');
        }
    }
    return out;
}

function listFilesRecursive(rootDir) {
    /** @type {string[]} */
    const out = [];
    /** @type {string[]} */
    const stack = [rootDir];
    while (stack.length) {
        const dir = stack.pop();
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            const p = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                stack.push(p);
            } else if (entry.isFile()) {
                out.push(p);
            }
        }
    }
    return out;
}

function normalizeSegments(filePath) {
    return filePath.split(path.sep).join('/').split('/');
}

function isValidTauriUpdaterSignature(signature) {
    const value = String(signature ?? '').trim();
    if (!/^[A-Za-z0-9+/=]+$/.test(value)) return false;

    const decoded = Buffer.from(value, 'base64').toString('utf8');
    return decoded.startsWith('untrusted comment:') && decoded.includes('\ntrusted comment:');
}

function main() {
    const args = parseArgs(process.argv.slice(2));

    const requestedChannel = String(args.get('--channel') ?? '').trim().toLowerCase();
    // `publicdev` is kept as a backward-compatible alias for `dev` (older workflows/pipeline
    // scripts used it as an internal id while showing "dev" publicly).
    const channel = requestedChannel === 'publicdev' ? 'dev' : requestedChannel;
    const version = String(args.get('--version') ?? '').trim();
    const pubDate = String(args.get('--pub-date') ?? '').trim();
    const notes = String(args.get('--notes') ?? '').trim();
    const repo = String(args.get('--repo') ?? '').trim();
    const releaseTag = String(args.get('--release-tag') ?? '').trim();
    const artifactsDir = String(args.get('--artifacts-dir') ?? '').trim();
    const outPath = String(args.get('--out') ?? '').trim();

    // NOTE: `latest.json` uses the Tauri updater schema and doesn't include the channel; we still validate
    // it so CI can fail fast if a workflow is misconfigured.
    if (!channel || !['preview', 'dev', 'production', 'stable'].includes(channel)) {
        fail('--channel must be one of: preview, dev, production, stable');
    }
    if (!version) fail('--version is required');
    if (!pubDate) fail('--pub-date is required');
    if (!notes) fail('--notes is required');
    if (!repo || !repo.includes('/')) fail('--repo must be like owner/repo');
    if (!releaseTag) fail('--release-tag is required');
    if (!artifactsDir) fail('--artifacts-dir is required');
    if (!outPath) fail('--out is required');

    if (!fs.existsSync(artifactsDir) || !fs.statSync(artifactsDir).isDirectory()) {
        fail(`artifacts-dir does not exist or is not a directory: ${artifactsDir}`);
    }

    const wantedPlatforms = ['linux-x86_64', 'windows-x86_64', 'darwin-x86_64', 'darwin-aarch64'];
    const allFiles = listFilesRecursive(artifactsDir);
    const sigFiles = allFiles.filter((p) => p.endsWith('.sig')).sort((a, b) => a.localeCompare(b));

    /** @type {Record<string, { url: string; signature: string }>} */
    const platforms = {};

    for (const platformKey of wantedPlatforms) {
        const sigPath = sigFiles.find((p) => normalizeSegments(p).some((segment) => segment.includes(platformKey)));
        if (!sigPath) {
            fail(`Missing signature file for platform "${platformKey}" under ${artifactsDir}`);
        }

        const artifactPath = sigPath.slice(0, -'.sig'.length);
        if (!fs.existsSync(artifactPath)) {
            fail(`Signature file has no matching artifact: ${sigPath}`);
        }

        const assetName = path.basename(artifactPath);
        const signature = fs.readFileSync(sigPath, 'utf8').trim();
        if (!isValidTauriUpdaterSignature(signature)) {
            fail(`Invalid updater signature file for platform "${platformKey}": ${sigPath}`);
        }
        platforms[platformKey] = {
            url: `https://github.com/${repo}/releases/download/${releaseTag}/${assetName}`,
            signature,
        };
    }

    const latest = {
        version,
        notes,
        pub_date: pubDate,
        platforms,
    };

    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, `${JSON.stringify(latest, null, 2)}\n`);
}

main();
