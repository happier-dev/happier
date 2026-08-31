#!/usr/bin/env node

import { randomBytes } from 'node:crypto';
import { cp, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function readArg(name, fallback = undefined) {
    const index = process.argv.indexOf(`--${name}`);
    return index === -1 ? fallback : process.argv[index + 1];
}

function readArgs(name) {
    const flag = `--${name}`;
    const values = [];
    for (let index = 0; index < process.argv.length; index += 1) {
        if (process.argv[index] !== flag) {
            continue;
        }
        const value = process.argv[index + 1];
        if (!value || value.startsWith('--')) {
            throw new Error(`Missing required ${flag} value`);
        }
        values.push(value);
        index += 1;
    }
    return values;
}

function requireValue(name) {
    const value = readArg(name);
    if (!value || value.startsWith('--')) {
        throw new Error(`Missing required --${name} value`);
    }
    return value;
}

function slugify(value) {
    const slug = value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60);
    if (!slug) {
        throw new Error('Review slug must contain at least one letter or number');
    }
    return slug;
}

function timestamp(date) {
    return date.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[:T]/g, '-').replace(/Z$/, '');
}

const slug = slugify(requireValue('slug'));
const target = requireValue('target');
const mode = requireValue('mode');
const reviewClass = readArg('class', 'advisory');
const reviewPaths = readArgs('path');
const fullWorktree = process.argv.includes('--full-worktree');
if (fullWorktree && reviewPaths.length > 0) {
    throw new Error('Use either repeatable --path values or --full-worktree, not both');
}
const allowedModes = new Set(['report', 'comment', 'qa', 'staged', 'fix']);
if (!allowedModes.has(mode)) {
    throw new Error(`Unsupported --mode ${mode}; expected report, comment, qa, staged, or fix`);
}
const allowedClasses = new Set(['advisory', 'boundary', 'ship']);
if (!allowedClasses.has(reviewClass)) {
    throw new Error(`Unsupported --class ${reviewClass}; expected advisory, boundary, or ship`);
}

function git(args) {
    return execFileSync('git', args, {
        cwd: process.cwd(),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
    }).trimEnd();
}

let root;
try {
    root = git(['rev-parse', '--show-toplevel']);
} catch {
    throw new Error('Run this script from inside the Git repository being reviewed');
}

const head = git(['rev-parse', 'HEAD']);
const branch = git(['branch', '--show-current']);
const dirty = git(['status', '--porcelain=v1']).length > 0;
const scopedStatus = fullWorktree
    ? git(['status', '--short'])
    : reviewPaths.length > 0
        ? git(['status', '--short', '--', ...reviewPaths])
        : null;
const diffScope = fullWorktree ? [] : reviewPaths.length > 0 ? ['--', ...reviewPaths] : null;
const workingDiff = diffScope === null ? null : git(['diff', '--no-ext-diff', ...diffScope]);
const stagedDiff = diffScope === null ? null : git(['diff', '--cached', '--no-ext-diff', ...diffScope]);
const skillDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const workspace = path.join(
    root,
    '.project',
    'reviews',
    `${timestamp(new Date())}-${slug}-${randomBytes(3).toString('hex')}`,
);

await mkdir(path.join(workspace, 'subagents'), { recursive: true });
await mkdir(path.join(workspace, 'evidence'), { recursive: true });
await cp(path.join(skillDir, 'assets', 'TRACKING.md'), path.join(workspace, 'TRACKING.md'));
await cp(path.join(skillDir, 'assets', 'REPORT.md'), path.join(workspace, 'REPORT.md'));
await cp(path.join(skillDir, 'assets', 'LANE.md'), path.join(workspace, 'subagents', '_TEMPLATE.md'));
await writeFile(
    path.join(workspace, 'evidence', 'observed-basis.txt'),
    [
        `repository: ${root}`,
        `head: ${head}`,
        `branch: ${branch || '(detached HEAD)'}`,
        `review class: ${reviewClass}`,
        `global dirty: ${dirty ? 'yes' : 'no'}`,
        `status scope: ${fullWorktree ? 'full worktree' : reviewPaths.length > 0 ? reviewPaths.join(', ') : 'not captured'}`,
        '',
        fullWorktree || reviewPaths.length > 0
            ? 'git status --short for selected scope:'
            : 'Detailed status omitted; pass repeatable --path values or --full-worktree.',
        scopedStatus || (fullWorktree || reviewPaths.length > 0 ? '(clean in selected scope)' : ''),
        '',
    ].join('\n'),
    { flag: 'wx' },
);
if (workingDiff) {
    await writeFile(path.join(workspace, 'evidence', 'initial-working-tree.diff'), `${workingDiff}\n`, { flag: 'wx' });
}
if (stagedDiff) {
    await writeFile(path.join(workspace, 'evidence', 'initial-staged.diff'), `${stagedDiff}\n`, { flag: 'wx' });
}
await writeFile(
    path.join(workspace, 'REVIEW.json'),
    `${JSON.stringify({
        target,
        mode,
        reviewClass,
        repository: root,
        head,
        branch: branch || null,
        dirty,
        paths: reviewPaths,
        fullWorktree,
        createdAt: new Date().toISOString(),
    }, null, 2)}\n`,
    { flag: 'wx' },
);

process.stdout.write(`${path.relative(root, workspace)}\n`);
