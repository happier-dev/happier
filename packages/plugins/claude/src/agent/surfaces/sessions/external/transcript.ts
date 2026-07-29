import { createHash } from 'node:crypto';
import { open, stat } from 'node:fs/promises';

import type {
    ExternalSessionsSource,
    ExternalSessionTranscriptRawMessageV1,
} from '@happier-dev/plugin-sdk/experimental/sessions';
import {
    readJsonlFileBackwardPage,
    readJsonlFileForward,
} from '@happier-dev/plugin-sdk/experimental/sessions/fileStores';
import { classifyClaudeNativeTranscriptRow } from '../../../transcripts/nativeSemanticProjection.js';
import { projectClaudeJsonlLineToDirectMessages } from '../../../transcripts/projection.js';

import { readClaudeJsonlFileSize, resolveClaudeJsonlSessionFile } from './files.js';

type ClaudeBackwardCursorV1 = Readonly<{
    v: 1;
    kind: 'claudeBackward';
    fileRelPath: string;
    endOffsetBytes: number;
}>;

type ClaudeForwardCursorV1 = Readonly<{
    v: 1;
    kind: 'claudeForward';
    fileRelPath: string;
    offsetBytes: number;
}>;

type ClaudeForwardCursorV2 = Readonly<{
    v: 2;
    kind: 'claudeForward';
    fileRelPath: string;
    offsetBytes: number;
    sourceAnchorOffsetBytes: number;
    sourceAnchorSha256: string;
    sourceDevice: string;
    sourceInode: string;
}>;

export type ClaudeTranscriptResultBudget = Readonly<{
    fits(page: Readonly<{
        items: readonly ExternalSessionTranscriptRawMessageV1[];
        nextCursor: string | null;
        tailCursor?: string | null;
        hasMore?: boolean;
        truncated?: boolean;
    }>): boolean;
}>;

export class ClaudeTranscriptResultBudgetTooSmallError extends Error {
    readonly name = 'ClaudeTranscriptResultBudgetTooSmallError';
}

function throwIfAborted(signal: AbortSignal | undefined): void {
    signal?.throwIfAborted();
}

function encodeCursor(
    value: ClaudeBackwardCursorV1 | ClaudeForwardCursorV1 | ClaudeForwardCursorV2,
): string {
    return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function asCursorRecord(raw: string | undefined): Record<string, unknown> | null {
    if (typeof raw !== 'string' || raw.trim().length === 0) return null;
    try {
        const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown;
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed as Record<string, unknown>
            : null;
    } catch {
        return null;
    }
}

function decodeBackwardCursor(raw: string | undefined): ClaudeBackwardCursorV1 | null {
    const record = asCursorRecord(raw);
    if (!record || record.v !== 1 || record.kind !== 'claudeBackward') return null;
    const fileRelPath = typeof record.fileRelPath === 'string' ? record.fileRelPath : '';
    const endOffsetBytes = typeof record.endOffsetBytes === 'number' && Number.isFinite(record.endOffsetBytes)
        ? Math.trunc(record.endOffsetBytes)
        : Number.NaN;
    return fileRelPath.trim() && endOffsetBytes >= 0
        ? { v: 1, kind: 'claudeBackward', fileRelPath, endOffsetBytes }
        : null;
}

function decodeForwardCursor(
    raw: string,
): ClaudeForwardCursorV1 | ClaudeForwardCursorV2 | null {
    const record = asCursorRecord(raw);
    if (
        !record
        || (record.v !== 1 && record.v !== 2)
        || record.kind !== 'claudeForward'
    ) return null;
    const fileRelPath = typeof record.fileRelPath === 'string' ? record.fileRelPath : '';
    const offsetBytes = typeof record.offsetBytes === 'number' && Number.isFinite(record.offsetBytes)
        ? Math.trunc(record.offsetBytes)
        : Number.NaN;
    if (!fileRelPath.trim() || offsetBytes < 0) return null;
    if (record.v === 1) {
        return { v: 1, kind: 'claudeForward', fileRelPath, offsetBytes };
    }
    const sourceAnchorOffsetBytes =
        typeof record.sourceAnchorOffsetBytes === 'number'
        && Number.isFinite(record.sourceAnchorOffsetBytes)
            ? Math.trunc(record.sourceAnchorOffsetBytes)
            : Number.NaN;
    const sourceAnchorSha256 =
        typeof record.sourceAnchorSha256 === 'string'
            ? record.sourceAnchorSha256
            : '';
    const sourceDevice =
        typeof record.sourceDevice === 'string' ? record.sourceDevice : '';
    const sourceInode =
        typeof record.sourceInode === 'string' ? record.sourceInode : '';
    return sourceAnchorOffsetBytes >= 0
        && sourceAnchorOffsetBytes <= offsetBytes
        && /^[A-Za-z0-9_-]{43}$/.test(sourceAnchorSha256)
        && /^\d+$/.test(sourceDevice)
        && /^[1-9]\d*$/.test(sourceInode)
        ? {
            v: 2,
            kind: 'claudeForward',
            fileRelPath,
            offsetBytes,
            sourceAnchorOffsetBytes,
            sourceAnchorSha256,
            sourceDevice,
            sourceInode,
        }
        : null;
}

async function readSourceAnchorEvidence(
    filePath: string,
    offsetBytes: number,
    signal?: AbortSignal,
): Promise<Readonly<{
    sourceAnchorSha256: string;
    sourceDevice: string;
    sourceInode: string;
}> | null> {
    throwIfAborted(signal);
    const handle = await open(filePath, 'r').catch(() => null);
    if (!handle) return null;
    try {
        const before = await handle.stat({ bigint: true });
        if (!before.isFile() || before.size < BigInt(offsetBytes)) return null;
        const hash = createHash('sha256');
        const buffer = Buffer.allocUnsafe(64 * 1024);
        let position = 0;
        while (position < offsetBytes) {
            throwIfAborted(signal);
            const readLength = Math.min(buffer.length, offsetBytes - position);
            const read = await handle.read(buffer, 0, readLength, position);
            if (read.bytesRead !== readLength) return null;
            hash.update(buffer.subarray(0, read.bytesRead));
            position += read.bytesRead;
        }
        const afterHandle = await handle.stat({ bigint: true });
        const afterPath = await stat(filePath, { bigint: true }).catch(() => null);
        if (
            !afterPath?.isFile()
            || before.dev !== afterHandle.dev
            || before.ino !== afterHandle.ino
            || before.mtimeNs !== afterHandle.mtimeNs
            || before.ctimeNs !== afterHandle.ctimeNs
            || afterHandle.dev !== afterPath.dev
            || afterHandle.ino !== afterPath.ino
            || afterHandle.size < BigInt(offsetBytes)
        ) {
            return null;
        }
        if (afterHandle.ino === 0n) return null;
        return {
            sourceAnchorSha256: hash.digest('base64url'),
            sourceDevice: afterHandle.dev.toString(10),
            sourceInode: afterHandle.ino.toString(10),
        };
    } finally {
        await handle.close();
    }
}

async function createForwardCursor(params: Readonly<{
    filePath: string;
    fileRelPath: string;
    offsetBytes: number;
    signal?: AbortSignal;
}>): Promise<string | null> {
    const evidence = await readSourceAnchorEvidence(
        params.filePath,
        params.offsetBytes,
        params.signal,
    );
    if (!evidence) return null;
    return encodeCursor({
        v: 2,
        kind: 'claudeForward',
        fileRelPath: params.fileRelPath,
        offsetBytes: params.offsetBytes,
        sourceAnchorOffsetBytes: params.offsetBytes,
        ...evidence,
    });
}

function projectLines(params: Readonly<{
    lines: ReadonlyArray<Readonly<{ startOffsetBytes: number; value: unknown }>>;
    fileRelPath: string;
    maxItems: number;
}>): ExternalSessionTranscriptRawMessageV1[] {
    const items: ExternalSessionTranscriptRawMessageV1[] = [];
    for (const line of params.lines) {
        if (items.length >= params.maxItems) break;
        const mapped = projectClaudeJsonlLineToDirectMessages({
            fileRelPath: params.fileRelPath,
            lineStartOffsetBytes: line.startOffsetBytes,
            lineValue: line.value,
        });
        for (const item of mapped) {
            if (items.length >= params.maxItems) break;
            items.push(item);
        }
    }
    return items;
}

export async function pageClaudeExternalSessionTranscript(params: Readonly<{
    source: ExternalSessionsSource;
    env: NodeJS.ProcessEnv;
    providerSessionId: string;
    direction: 'older' | 'newer';
    cursor?: string;
    maxBytes: number;
    maxItems: number;
    signal?: AbortSignal;
    resultBudget?: ClaudeTranscriptResultBudget;
}>): Promise<Readonly<{
    items: ExternalSessionTranscriptRawMessageV1[];
    nextCursor: string | null;
    tailCursor: string | null;
    hasMore: boolean;
    truncated?: boolean;
}>> {
    throwIfAborted(params.signal);
    if (params.direction !== 'older') {
        return { items: [], nextCursor: null, tailCursor: null, hasMore: false };
    }

    const resolved = await resolveClaudeJsonlSessionFile({
        source: params.source,
        env: params.env,
        remoteSessionId: params.providerSessionId,
        signal: params.signal,
    });
    if (!resolved) {
        return { items: [], nextCursor: null, tailCursor: null, hasMore: false };
    }

    const fileSize = await readClaudeJsonlFileSize(resolved.filePath, params.signal);
    const tailCursor = await createForwardCursor({
        filePath: resolved.filePath,
        fileRelPath: resolved.fileRelPath,
        offsetBytes: fileSize,
        signal: params.signal,
    });
    const decoded = decodeBackwardCursor(params.cursor);
    const cursorMismatch = Boolean(decoded && decoded.fileRelPath !== resolved.fileRelPath);
    const endOffsetBytes = cursorMismatch || !decoded
        ? fileSize
        : Math.min(fileSize, Math.max(0, decoded.endOffsetBytes));
    if (endOffsetBytes <= 0) {
        return { items: [], nextCursor: null, tailCursor, hasMore: false, ...(cursorMismatch ? { truncated: true } : {}) };
    }

    const page = await readJsonlFileBackwardPage({
        filePath: resolved.filePath,
        endOffsetBytes,
        maxBytes: params.maxBytes,
        maxItems: params.maxItems,
    });
    throwIfAborted(params.signal);
    if (page.diagnostics?.some((diagnostic) => diagnostic.code === 'malformed_source_utf8')) {
        throw new Error('Claude transcript source contains malformed UTF-8.');
    }
    const maxItems = Math.max(1, Math.trunc(params.maxItems));
    if (params.resultBudget) {
        const items: ExternalSessionTranscriptRawMessageV1[] = [];
        let nextEndOffsetBytes = page.items.length === 0
            ? page.nextEndOffsetBytes
            : endOffsetBytes;
        let stoppedBeforeOlderLine = false;

        for (let index = page.items.length - 1; index >= 0; index -= 1) {
            throwIfAborted(params.signal);
            const line = page.items[index];
            if (!line) continue;
            const mapped = projectClaudeJsonlLineToDirectMessages({
                fileRelPath: resolved.fileRelPath,
                lineStartOffsetBytes: line.startOffsetBytes,
                lineValue: line.value,
            });
            if (items.length + mapped.length > maxItems) {
                stoppedBeforeOlderLine = true;
                break;
            }
            const proposedItems = [...mapped, ...items];
            const proposedNextEndOffsetBytes = line.startOffsetBytes;
            const proposedHasMore = index > 0 || !page.reachedStart;
            const proposedNextCursor = proposedHasMore
                ? encodeCursor({
                    v: 1,
                    kind: 'claudeBackward',
                    fileRelPath: resolved.fileRelPath,
                    endOffsetBytes: proposedNextEndOffsetBytes,
                })
                : null;
            const proposed = {
                items: proposedItems,
                nextCursor: proposedNextCursor,
                tailCursor,
                hasMore: proposedHasMore,
                ...(cursorMismatch ? { truncated: true } : {}),
            };
            if (!params.resultBudget.fits(proposed)) {
                if (items.length === 0) {
                    throw new ClaudeTranscriptResultBudgetTooSmallError(
                        'Claude transcript result byte budget cannot fit one item.',
                    );
                }
                stoppedBeforeOlderLine = true;
                break;
            }
            items.splice(0, items.length, ...proposedItems);
            nextEndOffsetBytes = proposedNextEndOffsetBytes;
        }

        const hasMore = stoppedBeforeOlderLine || !page.reachedStart;
        const nextCursor = hasMore
            ? encodeCursor({
                v: 1,
                kind: 'claudeBackward',
                fileRelPath: resolved.fileRelPath,
                endOffsetBytes: nextEndOffsetBytes,
            })
            : null;
        const result = {
            items,
            nextCursor,
            tailCursor,
            hasMore,
            ...(cursorMismatch ? { truncated: true } : {}),
        };
        if (!params.resultBudget.fits(result)) {
            throw new ClaudeTranscriptResultBudgetTooSmallError(
                'Claude transcript result byte budget cannot fit the page envelope.',
            );
        }
        return result;
    }
    const items = projectLines({
        lines: page.items,
        fileRelPath: resolved.fileRelPath,
        maxItems,
    });
    const hasMore = !page.reachedStart;
    const nextCursor = hasMore
        ? encodeCursor({
            v: 1,
            kind: 'claudeBackward',
            fileRelPath: resolved.fileRelPath,
            endOffsetBytes: page.nextEndOffsetBytes,
        })
        : null;
    return { items, nextCursor, tailCursor, hasMore, ...(cursorMismatch ? { truncated: true } : {}) };
}

export async function readAfterClaudeExternalSessionTranscript(params: Readonly<{
    source: ExternalSessionsSource;
    env: NodeJS.ProcessEnv;
    providerSessionId: string;
    cursor: string;
    maxBytes: number;
    maxItems: number;
    signal?: AbortSignal;
    resultBudget?: ClaudeTranscriptResultBudget;
}>): Promise<Readonly<{
    items: ExternalSessionTranscriptRawMessageV1[];
    nextCursor: string | null;
    truncated: boolean;
    readAfterOutcome?: 'already_current' | 'gap_or_cursor_expired' | 'source_replaced' | 'source_unavailable';
    diagnostics?: readonly Readonly<{ code: string; count: number; positions: readonly number[] }>[];
}>> {
    throwIfAborted(params.signal);
    const resolved = await resolveClaudeJsonlSessionFile({
        source: params.source,
        env: params.env,
        remoteSessionId: params.providerSessionId,
        signal: params.signal,
    });
    if (!resolved) {
        return { items: [], nextCursor: null, truncated: false, readAfterOutcome: 'source_unavailable' };
    }

    const fileSize = await readClaudeJsonlFileSize(resolved.filePath, params.signal);
    if (params.cursor === 'tail') {
        const nextCursor = await createForwardCursor({
            filePath: resolved.filePath,
            fileRelPath: resolved.fileRelPath,
            offsetBytes: fileSize,
            signal: params.signal,
        });
        if (!nextCursor) {
            return {
                items: [],
                nextCursor: null,
                truncated: false,
                readAfterOutcome: 'source_unavailable',
            };
        }
        return {
            items: [],
            nextCursor,
            truncated: false,
            readAfterOutcome: 'already_current',
        };
    }

    const decoded = decodeForwardCursor(params.cursor);
    if (!decoded) {
        return { items: [], nextCursor: null, truncated: true, readAfterOutcome: 'gap_or_cursor_expired' };
    }
    if (decoded.fileRelPath !== resolved.fileRelPath) {
        return {
            items: [],
            nextCursor: await createForwardCursor({
                filePath: resolved.filePath,
                fileRelPath: resolved.fileRelPath,
                offsetBytes: fileSize,
                signal: params.signal,
            }),
            truncated: true,
            readAfterOutcome: 'source_replaced',
        };
    }
    if (decoded.v === 2) {
        const currentEvidence = await readSourceAnchorEvidence(
            resolved.filePath,
            decoded.sourceAnchorOffsetBytes,
            params.signal,
        );
        if (
            !currentEvidence
            || currentEvidence.sourceAnchorSha256
              !== decoded.sourceAnchorSha256
            || currentEvidence.sourceDevice !== decoded.sourceDevice
            || currentEvidence.sourceInode !== decoded.sourceInode
        ) {
            return {
                items: [],
                nextCursor: await createForwardCursor({
                    filePath: resolved.filePath,
                    fileRelPath: resolved.fileRelPath,
                    offsetBytes: fileSize,
                    signal: params.signal,
                }),
                truncated: true,
                readAfterOutcome: 'source_replaced',
            };
        }
    }

    const read = await readJsonlFileForward({
        filePath: resolved.filePath,
        offsetBytes: Math.max(0, decoded.offsetBytes),
        maxBytes: params.maxBytes,
        maxItems: params.maxItems,
    });
    throwIfAborted(params.signal);
    if (read.truncated) {
        return {
            items: [],
            nextCursor: await createForwardCursor({
                filePath: resolved.filePath,
                fileRelPath: resolved.fileRelPath,
                offsetBytes: fileSize,
                signal: params.signal,
            }),
            truncated: true,
            readAfterOutcome: 'gap_or_cursor_expired',
        };
    }

    if (params.resultBudget) {
        const maxItems = Math.max(1, Math.trunc(params.maxItems));
        const items: ExternalSessionTranscriptRawMessageV1[] = [];
        const knownNonTranscriptPositions: number[] = [];
        const unsupportedPositions: number[] = [];
        let nextOffsetBytes = read.items.length === 0
            ? read.nextOffsetBytes
            : Math.max(0, decoded.offsetBytes);

        for (let index = 0; index < read.items.length; index += 1) {
            throwIfAborted(params.signal);
            const line = read.items[index];
            if (!line) continue;
            const mapped = projectClaudeJsonlLineToDirectMessages({
                fileRelPath: resolved.fileRelPath,
                lineStartOffsetBytes: line.startOffsetBytes,
                lineValue: line.value,
            });
            if (mapped.length === 0) {
                (classifyClaudeNativeTranscriptRow(line.value).knownNonTranscriptRecord
                    ? knownNonTranscriptPositions
                    : unsupportedPositions
                ).push(line.startOffsetBytes);
            }
            if (items.length + mapped.length > maxItems) break;
            const proposedItems = [...items, ...mapped];
            const proposedNextOffsetBytes = read.items[index + 1]?.startOffsetBytes
                ?? read.nextOffsetBytes;
            const proposed = {
                items: proposedItems,
                nextCursor: encodeCursor({
                    v: 2,
                    kind: 'claudeForward',
                    fileRelPath: resolved.fileRelPath,
                    offsetBytes: proposedNextOffsetBytes,
                    sourceAnchorOffsetBytes: proposedNextOffsetBytes,
                    sourceAnchorSha256: 'A'.repeat(43),
                    sourceDevice: '0',
                    sourceInode: '1',
                }),
                truncated: false,
            };
            if (!params.resultBudget.fits(proposed)) {
                if (items.length === 0) {
                    throw new ClaudeTranscriptResultBudgetTooSmallError(
                        'Claude transcript result byte budget cannot fit one item.',
                    );
                }
                break;
            }
            items.splice(0, items.length, ...proposedItems);
            nextOffsetBytes = proposedNextOffsetBytes;
        }

        const nextCursor = await createForwardCursor({
            filePath: resolved.filePath,
            fileRelPath: resolved.fileRelPath,
            offsetBytes: nextOffsetBytes,
            signal: params.signal,
        });
        if (!nextCursor) {
            return {
                items: [],
                nextCursor: null,
                truncated: false,
                readAfterOutcome: 'source_unavailable',
            };
        }
        const diagnostics = [
            ...(read.diagnostics ?? []),
            ...(knownNonTranscriptPositions.length > 0
                ? [{
                    code: 'non_transcript_record_skipped',
                    count: knownNonTranscriptPositions.length,
                    positions: knownNonTranscriptPositions.slice(0, 200),
                }]
                : []),
            ...(unsupportedPositions.length > 0
                ? [{
                    code: 'unsupported_record_skipped',
                    count: unsupportedPositions.length,
                    positions: unsupportedPositions.slice(0, 200),
                }]
                : []),
        ];
        const result = {
            items,
            nextCursor,
            truncated: false,
            ...(diagnostics.length > 0 ? { diagnostics } : {}),
        };
        if (!params.resultBudget.fits(result)) {
            throw new ClaudeTranscriptResultBudgetTooSmallError(
                'Claude transcript result byte budget cannot fit the page envelope.',
            );
        }
        return result;
    }

    const projectedItems: ExternalSessionTranscriptRawMessageV1[] = [];
    const knownNonTranscriptPositions: number[] = [];
    const unsupportedPositions: number[] = [];
    const maxItems = Math.max(1, Math.trunc(params.maxItems));
    for (const line of read.items) {
        if (projectedItems.length >= maxItems) break;
        const mapped = projectClaudeJsonlLineToDirectMessages({
            fileRelPath: resolved.fileRelPath,
            lineStartOffsetBytes: line.startOffsetBytes,
            lineValue: line.value,
        });
        if (mapped.length === 0) {
            (classifyClaudeNativeTranscriptRow(line.value).knownNonTranscriptRecord
                ? knownNonTranscriptPositions
                : unsupportedPositions
            ).push(line.startOffsetBytes);
        }
        for (const item of mapped) {
            if (projectedItems.length >= maxItems) break;
            projectedItems.push(item);
        }
    }
    const nextCursor = await createForwardCursor({
        filePath: resolved.filePath,
        fileRelPath: resolved.fileRelPath,
        offsetBytes: read.nextOffsetBytes,
        signal: params.signal,
    });
    if (!nextCursor) {
        return {
            items: [],
            nextCursor: null,
            truncated: false,
            readAfterOutcome: 'source_unavailable',
        };
    }
    const diagnostics = [
        ...(read.diagnostics ?? []),
        ...(knownNonTranscriptPositions.length > 0
            ? [{
                code: 'non_transcript_record_skipped',
                count: knownNonTranscriptPositions.length,
                positions: knownNonTranscriptPositions.slice(0, 200),
            }]
            : []),
        ...(unsupportedPositions.length > 0
            ? [{
                code: 'unsupported_record_skipped',
                count: unsupportedPositions.length,
                positions: unsupportedPositions.slice(0, 200),
            }]
            : []),
    ];
    return {
        items: projectedItems,
        nextCursor,
        truncated: false,
        ...(diagnostics.length > 0 ? { diagnostics } : {}),
    };
}
