import { createHash } from 'node:crypto';
import { open, stat } from 'node:fs/promises';

import {
    readJsonlFileBackwardPage,
    readJsonlFileForward,
} from '@happier-dev/plugin-sdk/sessions/file-stores';
import {
    projectClaudeJsonlLineRecord,
    projectClaudeJsonlLineToDirectMessages,
} from '../../../transcripts/projection.js';

import { readClaudeJsonlFileSize, resolveClaudeJsonlSessionFile } from './files.js';
import type { ClaudeExternalSessionSource } from './source.js';

type ClaudeBackwardCursorV1 = Readonly<{
    v: 1;
    kind: 'claudeBackward';
    fileRelPath: string;
    endOffsetBytes: number;
}>;

/**
 * A backward cursor names a byte position inside ONE physical generation of the
 * session file, so it carries the same physical-generation evidence the forward
 * cursor already proved: the device/inode pair plus a content anchor over
 * `[0, sourceAnchorOffsetBytes)` — every byte the cursor still promises to
 * deliver. Without it a same-path replacement or in-place rewrite reads as
 * ordinary continuation and splices rows from two generations into one
 * transcript.
 */
type ClaudeBackwardCursorV2 = Readonly<{
    v: 2;
    kind: 'claudeBackward';
    fileRelPath: string;
    endOffsetBytes: number;
    sourceAnchorOffsetBytes: number;
    sourceAnchorSha256: string;
    sourceDevice: string;
    sourceInode: string;
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
        items: readonly ReturnType<typeof projectClaudeJsonlLineToDirectMessages>[number][];
        nextCursor: string | null;
        tailCursor?: string | null;
        hasMore?: boolean;
        truncated?: boolean;
    }>): boolean;
}>;

export class ClaudeTranscriptResultBudgetTooSmallError extends Error {
    readonly name = 'ClaudeTranscriptResultBudgetTooSmallError';
}

/**
 * A supplied cursor this leaf cannot decode is a caller error, not an absent
 * cursor. Treating the two alike silently restarts an in-progress browse at the
 * tail and re-delivers rows the caller already assembled.
 */
export class ClaudeTranscriptInvalidCursorError extends Error {
    readonly name = 'ClaudeTranscriptInvalidCursorError';
}

function throwIfAborted(signal: AbortSignal | undefined): void {
    signal?.throwIfAborted();
}

function encodeCursor(
    value:
        | ClaudeBackwardCursorV1
        | ClaudeBackwardCursorV2
        | ClaudeForwardCursorV1
        | ClaudeForwardCursorV2,
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

function decodeBackwardCursor(
    raw: string | undefined,
): ClaudeBackwardCursorV1 | ClaudeBackwardCursorV2 | null {
    const record = asCursorRecord(raw);
    if (!record || (record.v !== 1 && record.v !== 2) || record.kind !== 'claudeBackward') return null;
    const fileRelPath = typeof record.fileRelPath === 'string' ? record.fileRelPath : '';
    const endOffsetBytes = typeof record.endOffsetBytes === 'number' && Number.isFinite(record.endOffsetBytes)
        ? Math.trunc(record.endOffsetBytes)
        : Number.NaN;
    if (!fileRelPath.trim() || !(endOffsetBytes >= 0)) return null;
    if (record.v === 1) {
        return { v: 1, kind: 'claudeBackward', fileRelPath, endOffsetBytes };
    }
    const sourceAnchorOffsetBytes =
        typeof record.sourceAnchorOffsetBytes === 'number'
        && Number.isFinite(record.sourceAnchorOffsetBytes)
            ? Math.trunc(record.sourceAnchorOffsetBytes)
            : Number.NaN;
    const sourceAnchorSha256 =
        typeof record.sourceAnchorSha256 === 'string' ? record.sourceAnchorSha256 : '';
    const sourceDevice = typeof record.sourceDevice === 'string' ? record.sourceDevice : '';
    const sourceInode = typeof record.sourceInode === 'string' ? record.sourceInode : '';
    return sourceAnchorOffsetBytes >= 0
        && sourceAnchorOffsetBytes <= endOffsetBytes
        && /^[A-Za-z0-9_-]{43}$/.test(sourceAnchorSha256)
        && /^\d+$/.test(sourceDevice)
        && /^[1-9]\d*$/.test(sourceInode)
        ? {
            v: 2,
            kind: 'claudeBackward',
            fileRelPath,
            endOffsetBytes,
            sourceAnchorOffsetBytes,
            sourceAnchorSha256,
            sourceDevice,
            sourceInode,
        }
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

/**
 * Mints a backward cursor bound to the physical generation the page was read
 * from. `null` means the file could not yield consistent generation evidence,
 * which the caller reports as a truncated page instead of a continuation the
 * next read could not validate.
 */
async function createBackwardCursor(params: Readonly<{
    filePath: string;
    fileRelPath: string;
    endOffsetBytes: number;
    signal?: AbortSignal;
}>): Promise<string | null> {
    const evidence = await readSourceAnchorEvidence(
        params.filePath,
        params.endOffsetBytes,
        params.signal,
    );
    if (!evidence) return null;
    return encodeCursor({
        v: 2,
        kind: 'claudeBackward',
        fileRelPath: params.fileRelPath,
        endOffsetBytes: params.endOffsetBytes,
        sourceAnchorOffsetBytes: params.endOffsetBytes,
        ...evidence,
    });
}

/**
 * A byte-exact stand-in for the cursor `createBackwardCursor` would mint at the
 * same offset, used only to size a candidate page against the result budget. The
 * SHA-256 anchor is always 43 base64url characters and the device/inode pair
 * belongs to the file rather than the offset, so probing with the real identity
 * costs one stat instead of one full re-hash per candidate row.
 */
function encodeBackwardCursorEnvelopeProbe(params: Readonly<{
    fileRelPath: string;
    endOffsetBytes: number;
    identity: Readonly<{ sourceDevice: string; sourceInode: string }>;
}>): string {
    return encodeCursor({
        v: 2,
        kind: 'claudeBackward',
        fileRelPath: params.fileRelPath,
        endOffsetBytes: params.endOffsetBytes,
        sourceAnchorOffsetBytes: params.endOffsetBytes,
        sourceAnchorSha256: 'A'.repeat(43),
        sourceDevice: params.identity.sourceDevice,
        sourceInode: params.identity.sourceInode,
    });
}

function projectLines(params: Readonly<{
    lines: ReadonlyArray<Readonly<{ startOffsetBytes: number; value: unknown }>>;
    fileRelPath: string;
    maxItems: number;
}>): Readonly<{
    items: ReturnType<typeof projectClaudeJsonlLineToDirectMessages>;
    consumedUnsupportedRecord: boolean;
}> {
    const items: ReturnType<typeof projectClaudeJsonlLineToDirectMessages> = [];
    let consumedUnsupportedRecord = false;
    for (const line of params.lines) {
        if (items.length >= params.maxItems) break;
        const projected = projectClaudeJsonlLineRecord({
            fileRelPath: params.fileRelPath,
            lineStartOffsetBytes: line.startOffsetBytes,
            lineValue: line.value,
            maxItems: params.maxItems - items.length,
        });
        if (projected.disposition === 'unsupported') consumedUnsupportedRecord = true;
        for (const item of projected.items) {
            if (items.length >= params.maxItems) break;
            items.push(item);
        }
    }
    return { items, consumedUnsupportedRecord };
}

export async function pageClaudeExternalSessionTranscript(params: Readonly<{
    source: ClaudeExternalSessionSource;
    env: NodeJS.ProcessEnv;
    providerSessionId: string;
    direction: 'older' | 'newer';
    cursor?: string;
    maxBytes: number;
    maxItems: number;
    signal?: AbortSignal;
    resultBudget?: ClaudeTranscriptResultBudget;
}>): Promise<Readonly<{
    items: ReturnType<typeof projectClaudeJsonlLineToDirectMessages>;
    nextCursor: string | null;
    tailCursor: string | null;
    hasMore: boolean;
    truncated?: boolean;
}>> {
    throwIfAborted(params.signal);
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
    if (params.direction === 'newer') {
        const initialCursor = params.cursor ?? await createForwardCursor({
            filePath: resolved.filePath,
            fileRelPath: resolved.fileRelPath,
            offsetBytes: 0,
            signal: params.signal,
        });
        if (!initialCursor || !tailCursor) {
            return { items: [], nextCursor: null, tailCursor, hasMore: false };
        }
        const forward = await readAfterClaudeExternalSessionTranscript({
            source: params.source,
            env: params.env,
            providerSessionId: params.providerSessionId,
            cursor: initialCursor,
            maxBytes: params.maxBytes,
            maxItems: params.maxItems,
            signal: params.signal,
            ...(params.resultBudget
                ? {
                    resultBudget: {
                        fits(candidate) {
                            const decodedNext = candidate.nextCursor
                                ? decodeForwardCursor(candidate.nextCursor)
                                : null;
                            const hasMore = decodedNext !== null
                                && decodedNext.offsetBytes < fileSize;
                            return params.resultBudget!.fits({
                                items: candidate.items,
                                nextCursor: hasMore ? candidate.nextCursor : null,
                                tailCursor,
                                hasMore,
                                ...(candidate.truncated ? { truncated: true } : {}),
                            });
                        },
                    },
                }
                : {}),
        });
        const decodedNext = forward.nextCursor
            ? decodeForwardCursor(forward.nextCursor)
            : null;
        const hasMore = decodedNext !== null && decodedNext.offsetBytes < fileSize;
        const truncated = forward.truncated
            || (
                forward.readAfterOutcome !== undefined
                && forward.readAfterOutcome !== 'already_current'
            );
        return {
            items: forward.items,
            nextCursor: hasMore ? forward.nextCursor : null,
            tailCursor,
            hasMore,
            ...(truncated ? { truncated: true } : {}),
        };
    }
    const decoded = decodeBackwardCursor(params.cursor);
    // A caller that supplied a cursor asked to continue a specific browse. When
    // this leaf cannot decode it, restarting at the tail would re-deliver rows
    // the caller already holds and present them as a fresh newest page, so the
    // undecodable cursor is refused instead of silently reinterpreted as absent.
    if (decoded === null && typeof params.cursor === 'string' && params.cursor.trim().length > 0) {
        throw new ClaudeTranscriptInvalidCursorError(
            'Claude transcript backward cursor could not be decoded.',
        );
    }
    const cursorMismatch = Boolean(decoded && decoded.fileRelPath !== resolved.fileRelPath);
    // A v2 cursor is bound to one physical generation of this file. Validating it
    // before the next older page is read is what keeps rows from a replaced or
    // rewritten file out of a transcript the caller is still assembling; a
    // mismatch is a discontinuity, not a continuation, so it yields zero rows.
    // A v1 cursor carries no such evidence — it can only have been minted by a
    // predecessor writer, and rejecting it outright would restart an in-progress
    // browse at the tail — so it keeps its established offset-only meaning.
    if (decoded?.v === 2 && !cursorMismatch) {
        const currentEvidence = await readSourceAnchorEvidence(
            resolved.filePath,
            decoded.sourceAnchorOffsetBytes,
            params.signal,
        );
        if (
            !currentEvidence
            || currentEvidence.sourceAnchorSha256 !== decoded.sourceAnchorSha256
            || currentEvidence.sourceDevice !== decoded.sourceDevice
            || currentEvidence.sourceInode !== decoded.sourceInode
        ) {
            return { items: [], nextCursor: null, tailCursor, hasMore: false, truncated: true };
        }
    }
    const endOffsetBytes = cursorMismatch || !decoded
        ? fileSize
        : Math.min(fileSize, Math.max(0, decoded.endOffsetBytes));
    if (endOffsetBytes <= 0) {
        return { items: [], nextCursor: null, tailCursor, hasMore: false, ...(cursorMismatch ? { truncated: true } : {}) };
    }
    const sourceIdentity = await readSourceAnchorEvidence(resolved.filePath, 0, params.signal);
    if (!sourceIdentity) {
        return { items: [], nextCursor: null, tailCursor, hasMore: false, truncated: true };
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
        const items: ReturnType<typeof projectClaudeJsonlLineToDirectMessages> = [];
        let nextEndOffsetBytes = page.items.length === 0
            ? page.nextEndOffsetBytes
            : endOffsetBytes;
        let stoppedBeforeOlderLine = false;
        // Only a row the page actually advances past can be lost. A row the
        // budget refuses stays behind `nextCursor`, so it is a continuation
        // rather than a discarded record.
        let consumedUnsupportedRecord = false;

        for (let index = page.items.length - 1; index >= 0; index -= 1) {
            throwIfAborted(params.signal);
            const line = page.items[index];
            if (!line) continue;
            const projected = projectClaudeJsonlLineRecord({
                fileRelPath: resolved.fileRelPath,
                lineStartOffsetBytes: line.startOffsetBytes,
                lineValue: line.value,
                maxItems: maxItems - items.length,
            });
            const mapped = projected.items;
            if (items.length + mapped.length > maxItems) {
                stoppedBeforeOlderLine = true;
                break;
            }
            const proposedItems = [...mapped, ...items];
            const proposedNextEndOffsetBytes = line.startOffsetBytes;
            const proposedHasMore = index > 0 || !page.reachedStart;
            const proposedNextCursor = proposedHasMore
                ? encodeBackwardCursorEnvelopeProbe({
                    fileRelPath: resolved.fileRelPath,
                    endOffsetBytes: proposedNextEndOffsetBytes,
                    identity: sourceIdentity,
                })
                : null;
            const proposed = {
                items: proposedItems,
                nextCursor: proposedNextCursor,
                tailCursor,
                hasMore: proposedHasMore,
                ...(cursorMismatch
                    || consumedUnsupportedRecord
                    || projected.disposition === 'unsupported'
                    ? { truncated: true }
                    : {}),
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
            if (projected.disposition === 'unsupported') consumedUnsupportedRecord = true;
        }

        const hasMore = stoppedBeforeOlderLine || !page.reachedStart;
        const nextCursor = hasMore
            ? await createBackwardCursor({
                filePath: resolved.filePath,
                fileRelPath: resolved.fileRelPath,
                endOffsetBytes: nextEndOffsetBytes,
                signal: params.signal,
            })
            : null;
        // A page whose continuation cannot be bound to this generation is
        // reported as truncated rather than as a silent end of history.
        if (hasMore && !nextCursor) {
            return { items, nextCursor: null, tailCursor, hasMore: false, truncated: true };
        }
        const result = {
            items,
            nextCursor,
            tailCursor,
            hasMore,
            ...(cursorMismatch || consumedUnsupportedRecord ? { truncated: true } : {}),
        };
        if (!params.resultBudget.fits(result)) {
            throw new ClaudeTranscriptResultBudgetTooSmallError(
                'Claude transcript result byte budget cannot fit the page envelope.',
            );
        }
        return result;
    }
    const { items, consumedUnsupportedRecord } = projectLines({
        lines: page.items,
        fileRelPath: resolved.fileRelPath,
        maxItems,
    });
    const hasMore = !page.reachedStart;
    const nextCursor = hasMore
        ? await createBackwardCursor({
            filePath: resolved.filePath,
            fileRelPath: resolved.fileRelPath,
            endOffsetBytes: page.nextEndOffsetBytes,
            signal: params.signal,
        })
        : null;
    if (hasMore && !nextCursor) {
        return { items, nextCursor: null, tailCursor, hasMore: false, truncated: true };
    }
    return {
        items,
        nextCursor,
        tailCursor,
        hasMore,
        ...(cursorMismatch || consumedUnsupportedRecord ? { truncated: true } : {}),
    };
}

export async function readAfterClaudeExternalSessionTranscript(params: Readonly<{
    source: ClaudeExternalSessionSource;
    env: NodeJS.ProcessEnv;
    providerSessionId: string;
    cursor: string;
    maxBytes: number;
    maxItems: number;
    signal?: AbortSignal;
    resultBudget?: ClaudeTranscriptResultBudget;
}>): Promise<Readonly<{
    items: ReturnType<typeof projectClaudeJsonlLineToDirectMessages>;
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
        const items: ReturnType<typeof projectClaudeJsonlLineToDirectMessages> = [];
        const knownNonTranscriptPositions: number[] = [];
        const unsupportedPositions: number[] = [];
        let nextOffsetBytes = read.items.length === 0
            ? read.nextOffsetBytes
            : Math.max(0, decoded.offsetBytes);

        for (let index = 0; index < read.items.length; index += 1) {
            throwIfAborted(params.signal);
            const line = read.items[index];
            if (!line) continue;
            const projected = projectClaudeJsonlLineRecord({
                fileRelPath: resolved.fileRelPath,
                lineStartOffsetBytes: line.startOffsetBytes,
                lineValue: line.value,
                maxItems: maxItems - items.length,
            });
            const mapped = projected.items;
            if (projected.disposition === 'known_non_transcript') {
                knownNonTranscriptPositions.push(line.startOffsetBytes);
            } else if (projected.disposition === 'unsupported') {
                unsupportedPositions.push(line.startOffsetBytes);
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

    const projectedItems: ReturnType<typeof projectClaudeJsonlLineToDirectMessages> = [];
    const knownNonTranscriptPositions: number[] = [];
    const unsupportedPositions: number[] = [];
    const maxItems = Math.max(1, Math.trunc(params.maxItems));
    for (const line of read.items) {
        if (projectedItems.length >= maxItems) break;
        const projected = projectClaudeJsonlLineRecord({
            fileRelPath: resolved.fileRelPath,
            lineStartOffsetBytes: line.startOffsetBytes,
            lineValue: line.value,
            maxItems: maxItems - projectedItems.length,
        });
        if (projected.disposition === 'known_non_transcript') {
            knownNonTranscriptPositions.push(line.startOffsetBytes);
        } else if (projected.disposition === 'unsupported') {
            unsupportedPositions.push(line.startOffsetBytes);
        }
        for (const item of projected.items) {
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
