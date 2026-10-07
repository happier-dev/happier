import { createHash } from 'node:crypto';
import { lstat, readFile, readlink, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

import type {
    ReviewCommentAnchorV1,
    ReviewCommentSnapshotV1,
} from '@happier-dev/protocol';
import {
    buildReviewCommentTextSnapshotHashes,
    reviewCommentTextSnapshotHasBidiControlsV1,
    reviewCommentTextSnapshotIsLikelyMinifiedV1,
} from '@happier-dev/protocol/reviews/comments/snapshots';

const DEFAULT_CONTEXT_LINE_COUNT = 5;

function sha256(input: string | Uint8Array): string {
    return createHash('sha256').update(input).digest('hex');
}

function splitLines(text: string): readonly string[] {
    return text.length === 0 ? [] : text.split(/\r?\n/);
}

function filePathForAnchor(anchor: ReviewCommentAnchorV1): string | null {
    return 'filePath' in anchor ? anchor.filePath : null;
}

function lineBounds(anchor: ReviewCommentAnchorV1): Readonly<{ startIndex: number; endIndex: number }> {
    if (anchor.kind === 'line') {
        const index = Math.max(0, anchor.line - 1);
        return { startIndex: index, endIndex: index };
    }
    if (anchor.kind === 'range') {
        return {
            startIndex: Math.max(0, anchor.startLine - 1),
            endIndex: Math.max(0, anchor.endLine - 1),
        };
    }
    return { startIndex: 0, endIndex: 0 };
}

function resolveScopedPath(cwd: string, filePath: string): string | null {
    const root = resolve(cwd);
    const candidate = resolve(root, filePath);
    if (isPathInsideScope(root, candidate)) return candidate;
    return null;
}

function isPathInsideScope(root: string, candidate: string): boolean {
    const scopedRelative = relative(root, candidate);
    if (scopedRelative === '' || (!scopedRelative.startsWith('..') && !isAbsolute(scopedRelative))) {
        return true;
    }
    return false;
}

async function resolveRealScopedPath(cwd: string, candidate: string): Promise<string | null> {
    const root = resolve(cwd);
    const [realRoot, realCandidate] = await Promise.all([
        realpath(root),
        realpath(candidate),
    ]).catch(() => [null, null] as const);
    if (!realRoot || !realCandidate) return null;
    return isPathInsideScope(realRoot, realCandidate) ? realCandidate : null;
}

async function isGitWorkTreeDirectory(directoryPath: string): Promise<boolean> {
    const gitMetadata = await lstat(resolve(directoryPath, '.git')).catch(() => null);
    return Boolean(gitMetadata?.isFile() || gitMetadata?.isDirectory());
}

function createTextSnapshot(params: Readonly<{
    lines: readonly string[];
    anchor: ReviewCommentAnchorV1;
    capturedAt: number;
}>): ReviewCommentSnapshotV1 {
    const bounds = lineBounds(params.anchor);
    const lastIndex = Math.max(0, params.lines.length - 1);
    const boundedStart = Math.min(bounds.startIndex, lastIndex);
    const boundedEnd = Math.min(Math.max(bounds.endIndex, boundedStart), lastIndex);
    const selectedLines = params.lines.slice(boundedStart, boundedEnd + 1);
    const beforeContext = params.lines.slice(
        Math.max(0, boundedStart - DEFAULT_CONTEXT_LINE_COUNT),
        boundedStart,
    );
    const afterContext = params.lines.slice(
        boundedEnd + 1,
        boundedEnd + 1 + DEFAULT_CONTEXT_LINE_COUNT,
    );
    const allLines = [...beforeContext, ...selectedLines, ...afterContext];
    const hashes = buildReviewCommentTextSnapshotHashes({
        selectedLines,
        beforeContext,
        afterContext,
    });

    return {
        kind: 'text',
        selectedLines: [...selectedLines],
        beforeContext: [...beforeContext],
        afterContext: [...afterContext],
        selectedLinesHash: hashes.selectedLinesHash,
        contextWindowHash: hashes.contextWindowHash,
        capturedAt: params.capturedAt,
        fileLength: params.lines.length,
        source: 'workingTree',
        isUncommitted: true,
        isUntracked: false,
        truncated: false,
        hasBidiControls: reviewCommentTextSnapshotHasBidiControlsV1(allLines),
        likelyMinified: reviewCommentTextSnapshotIsLikelyMinifiedV1(allLines),
    };
}

function isLikelyBinary(buffer: Uint8Array): boolean {
    return buffer.includes(0);
}

export async function resolveReviewCommentSnapshot(params: Readonly<{
    cwd: string;
    anchor: ReviewCommentAnchorV1;
    now?: () => number;
}>): Promise<ReviewCommentSnapshotV1 | null> {
    const cwd = String(params.cwd ?? '').trim();
    const filePath = filePathForAnchor(params.anchor);
    if (!cwd || !filePath) return null;

    const resolvedPath = resolveScopedPath(cwd, filePath);
    if (!resolvedPath) return null;

    const capturedAt = Math.max(0, Math.trunc((params.now ?? Date.now)()));
    let fileStat;
    try {
        fileStat = await lstat(resolvedPath);
    } catch {
        return null;
    }

    if (fileStat.isSymbolicLink()) {
        const targetPath = await readlink(resolvedPath).catch(() => null);
        return targetPath
            ? { kind: 'symlink', filePath, targetPath, capturedAt }
            : null;
    }

    const realScopedPath = await resolveRealScopedPath(cwd, resolvedPath);
    if (!realScopedPath) return null;

    if (fileStat.isDirectory()) {
        if (params.anchor.kind === 'submodule' && await isGitWorkTreeDirectory(realScopedPath)) {
            return { kind: 'submodule', filePath, capturedAt };
        }
        return null;
    }

    if (!fileStat.isFile()) return null;
    const buffer = await readFile(realScopedPath).catch(() => null);
    if (!buffer) return null;
    if (isLikelyBinary(buffer)) {
        return {
            kind: 'binary',
            sizeBytes: buffer.byteLength,
            sha256: sha256(buffer),
            source: 'workingTree',
            capturedAt,
        };
    }

    return createTextSnapshot({
        lines: splitLines(buffer.toString('utf8')),
        anchor: params.anchor,
        capturedAt,
    });
}
