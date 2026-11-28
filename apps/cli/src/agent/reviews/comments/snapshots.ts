import { createHash } from 'node:crypto';
import { lstat, mkdtemp, readFile, readlink, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';

import type {
    ReviewCommentAnchorV1,
    ReviewCommentSnapshotV1,
    ScmComparison,
} from '@happier-dev/protocol';
import {
    buildReviewCommentTextSnapshotHashes,
    reviewCommentTextSnapshotHasBidiControlsV1,
    reviewCommentTextSnapshotIsLikelyMinifiedV1,
} from '@happier-dev/protocol/reviews/comments/snapshots';
import { parseUnifiedDiffHunks } from '@happier-dev/protocol/diff/hunks';
import { runGitCheckpointCommand } from '@/scm/checkpoints/gitCheckpointCommands';
import { logger } from '@/ui/logger';

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
}>): ReviewCommentSnapshotV1 | null {
    const bounds = lineBounds(params.anchor);
    if ((params.anchor.kind === 'line' || params.anchor.kind === 'range')
        && (bounds.startIndex >= params.lines.length || bounds.endIndex >= params.lines.length)) return null;
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

type SnapshotReads = Map<string, Promise<Buffer | null>>;

function readOnce(reads: SnapshotReads | undefined, key: string, read: () => Promise<Buffer | null>): Promise<Buffer | null> {
    if (!reads) return read();
    let pending = reads.get(key);
    if (!pending) {
        pending = read();
        reads.set(key, pending);
    }
    return pending;
}

async function readComparisonBlob(repository: string, blobId: string): Promise<Buffer | null> {
    const directory = await mkdtemp(join(tmpdir(), 'happier-review-blob-'));
    try {
        // Git writes the complete immutable object through the existing binary-safe
        // output owner. Never substitute HEAD or the current path on a failed read.
        const output = join(directory, 'blob');
        const read = await runGitCheckpointCommand({ cwd: repository,
            args: ['cat-file', 'blob', blobId], stdoutFilePath: output });
        return read.success ? await readFile(output) : null;
    } finally {
        try {
            await rm(directory, { recursive: true, force: true });
        } catch {
            logger.warnLocalFile('Temporary review snapshot directory could not be removed.');
        }
    }
}

async function resolveComparisonSnapshot(params: Readonly<{
    comparison: ScmComparison;
    anchor: ReviewCommentAnchorV1;
    filePath: string;
    capturedAt: number;
    reads?: SnapshotReads;
}>): Promise<ReviewCommentSnapshotV1 | null> {
    const { comparison, anchor, filePath, capturedAt } = params;
    const files = comparison.inventory.files.filter(file => file.path === filePath || file.previousPath === filePath);
    if (files.length !== 1) return null;
    const file = files[0]!;
    const side = 'side' in anchor && anchor.side ? anchor.side
        : file.previousPath === filePath || !file.afterBlobId ? 'before' : 'after';
    const blobId = side === 'before' ? file.beforeBlobId : file.afterBlobId;
    if (!blobId && comparison.source.kind === 'pullRequest' && file.evidence.state === 'available'
        && (anchor.kind === 'line' || anchor.kind === 'range' || anchor.kind === 'file')) {
        // Hosted comparisons retain immutable patch lines rather than local Git objects.
        const patchSide = 'side' in anchor && anchor.side ? anchor.side
            : file.changeKind === 'deleted' || file.previousPath === filePath ? 'before' : 'after';
        const reportedStart = anchor.kind === 'line' ? anchor.line : anchor.kind === 'range' ? anchor.startLine : null;
        const reportedEnd = anchor.kind === 'line' ? anchor.line : anchor.kind === 'range' ? anchor.endLine : null;
        for (const hunk of parseUnifiedDiffHunks(file.evidence.unifiedDiff)) {
            const firstLine = patchSide === 'before' ? hunk.oldStart : hunk.newStart;
            const lines = hunk.lines.filter(line => line.kind !== (patchSide === 'before' ? 'add' : 'remove')).map(line => line.text);
            const start = reportedStart ?? firstLine;
            const end = reportedEnd ?? firstLine;
            if (start < firstLine || end >= firstLine + lines.length) continue;
            const snapshot = createTextSnapshot({ lines, capturedAt, anchor: { kind: 'range', filePath,
                startLine: start - firstLine + 1, endLine: end - firstLine + 1 } });
            if (snapshot?.kind !== 'text') return null;
            const { fileLength, ...excerpt } = snapshot;
            return { ...excerpt, source: 'diffSide', isUncommitted: false, isUntracked: file.changeKind === 'added',
                diffContext: { side: patchSide, ...(comparison.endpoints.before ? { baseSha: comparison.endpoints.before } : {}),
                    ...(comparison.endpoints.after ? { headSha: comparison.endpoints.after } : {}) } };
        }
        return null;
    }
    if (!blobId || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(blobId)) return null;
    const buffer = await readOnce(params.reads, JSON.stringify(['blob', comparison.repository.rootPath, blobId]),
        () => readComparisonBlob(comparison.repository.rootPath, blobId));
    if (!buffer) return null;
    if (isLikelyBinary(buffer)) {
        return anchor.kind === 'file' || anchor.kind === 'binary'
            ? { kind: 'binary', sizeBytes: buffer.byteLength, sha256: sha256(buffer), source: 'diffSide', capturedAt }
            : null;
    }
    const text = buffer.toString('utf8');
    if (!Buffer.from(text).equals(buffer)) return null;
    const snapshot = createTextSnapshot({ lines: splitLines(text), anchor, capturedAt });
    if (snapshot?.kind !== 'text') return null;
    return { ...snapshot, source: 'diffSide', isUncommitted: comparison.source.kind === 'workingTree'
        || comparison.source.kind === 'session' || comparison.source.kind === 'turnCheckpoint',
        isUntracked: !file.beforeBlobId,
        diffContext: { side, ...(comparison.endpoints.before ? { baseSha: comparison.endpoints.before } : {}),
            ...(comparison.endpoints.after ? { headSha: comparison.endpoints.after } : {}) } };
}

type SnapshotParams = Readonly<{
    cwd: string;
    anchor: ReviewCommentAnchorV1;
    /** Present only for a Review bound to captured evidence; null means unavailable. */
    comparison?: ScmComparison | null;
    now?: () => number;
}>;

/** Read sharing lasts only for this materialization, never across user operations. */
export function createReviewCommentSnapshotResolver(): typeof resolveReviewCommentSnapshot {
    const reads: SnapshotReads = new Map();
    return params => resolveSnapshot(params, reads);
}

export async function resolveReviewCommentSnapshot(params: SnapshotParams): Promise<ReviewCommentSnapshotV1 | null> {
    return resolveSnapshot(params);
}

async function resolveSnapshot(params: SnapshotParams, reads?: SnapshotReads): Promise<ReviewCommentSnapshotV1 | null> {
    const cwd = String(params.cwd ?? '').trim();
    const filePath = filePathForAnchor(params.anchor);
    if (!cwd || !filePath) return null;

    const resolvedPath = resolveScopedPath(cwd, filePath);
    if (!resolvedPath) return null;

    const capturedAt = Math.max(0, Math.trunc((params.now ?? Date.now)()));
    if (params.comparison !== undefined) {
        return params.comparison ? resolveComparisonSnapshot({ comparison: params.comparison,
            anchor: params.anchor, filePath, capturedAt, reads }) : null;
    }
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
    const buffer = await readOnce(reads, JSON.stringify(['file', realScopedPath]), () => readFile(realScopedPath).catch(() => null));
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
