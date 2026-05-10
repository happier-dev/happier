#!/usr/bin/env node
// @ts-check
/**
 * Publish release-notes assets to `happier-dev/happier-assets` under the rolling
 * `release-notes` tag.
 *
 * Pre-conditions:
 *   - Asset bundle has been built into --in-dir by `build-release-notes-assets.mjs`.
 *   - `gh` CLI is installed and authenticated for the target repo.
 *
 * Behavior:
 *   - Ensures the rolling `release-notes` release exists (creates it idempotently).
 *   - Uploads every file in --in-dir with --clobber.
 *
 * Flags:
 *   --in-dir <path>          Default: dist/release-notes-assets
 *   --repo <owner/repo>      Default: happier-dev/happier-assets
 *   --tag <tag>              Default: release-notes
 *   --dry-run                Print commands without executing.
 */

import { execFileSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REQUIRED_BUNDLE_FILES = Object.freeze([
    'release-notes__manifest.json',
    'release-notes__assets-index.json',
]);

function parseFlags(argv) {
    const map = new Map();
    const positional = [];
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (!arg.startsWith('--')) {
            positional.push(arg);
            continue;
        }
        if (arg === '--dry-run') {
            map.set('dry-run', 'true');
            continue;
        }
        const eq = arg.indexOf('=');
        if (eq !== -1) {
            map.set(arg.slice(2, eq), arg.slice(eq + 1));
        } else {
            map.set(arg.slice(2), argv[i + 1] ?? '');
            i += 1;
        }
    }
    return { map, positional };
}

function run(cmd, args, opts) {
    if (opts?.dryRun) {
        console.log(`[dry-run] ${cmd} ${args.join(' ')}`);
        return '';
    }
    return execFileSync(cmd, args, {
        env: process.env,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'inherit'],
    });
}

async function main() {
    const { map } = parseFlags(process.argv.slice(2));
    const repoRoot = resolve(new URL('../../../..', import.meta.url).pathname);
    const inDir = resolve(map.get('in-dir') ?? join(repoRoot, 'dist/release-notes-assets'));
    const repo = map.get('repo') ?? 'happier-dev/happier-assets';
    const tag = map.get('tag') ?? 'release-notes';
    const dryRun = map.get('dry-run') === 'true';

    if (!existsSync(inDir)) {
        throw new Error(`Asset bundle not found at ${inDir}. Run build-release-notes-assets.mjs first.`);
    }

    const files = (await readdir(inDir)).filter((name) => !name.startsWith('.'));
    const missing = REQUIRED_BUNDLE_FILES.filter((name) => !files.includes(name));
    if (missing.length > 0) {
        throw new Error(`Release notes asset bundle is missing required file(s): ${missing.join(', ')}`);
    }
    if (files.length === 0) {
        console.warn(`[release-notes] no files to upload from ${inDir}`);
        return;
    }

    // Ensure release exists (idempotent; ignore failure if already present).
    try {
        run('gh', [
            'release', 'view', tag,
            '--repo', repo,
        ], { dryRun });
    } catch {
        run('gh', [
            'release', 'create', tag,
            '--repo', repo,
            '--title', 'Release notes assets',
            '--notes', 'Rolling tag for in-app release-notes story media. Updated by CI.',
        ], { dryRun });
    }

    // Upload all files with --clobber.
    const uploadArgs = [
        'release', 'upload', tag,
        ...files.sort((a, b) => a.localeCompare(b)).map((name) => join(inDir, name)),
        '--repo', repo,
        '--clobber',
    ];
    run('gh', uploadArgs, { dryRun });

    console.log(`[release-notes] uploaded ${files.length} file(s) to ${repo}@${tag}`);
}

main().catch((error) => {
    console.error('[release-notes] publish failed:', error?.message ?? error);
    process.exit(1);
});
