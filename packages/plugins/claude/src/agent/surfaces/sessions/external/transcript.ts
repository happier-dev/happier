import { createHash } from 'node:crypto';
import { open, stat } from 'node:fs/promises';

import { defineProtocolJsonValue } from '@happier-dev/plugin-sdk/protocol';
import type {
    AgentExternalSessionTerminalObservation,
    AgentExternalSessionTranscriptItem,
    AgentExternalSessionsInvocation,
} from '@happier-dev/plugin-sdk/sessions/external';

import {
    readJsonlFileBackwardPage,
    readJsonlFileForward,
    type JsonlScannerFileSystem,
    type ExternalSessionContentSearchControl,
    searchExternalSessionContent,
} from '@happier-dev/plugin-sdk/sessions/file-stores';

import { readClaudeTaskLifecycleEnvelope } from '../../../transcripts/taskNotification.js';
import { parseClaudeWorkflowFacts } from '../../../workflowRecords/correlation.js';
import { classifyClaudeNativeTranscriptRow, projectClaudeNativeTranscriptObservation } from '../../../transcripts/nativeSemanticProjection.js';
import {
    projectClaudeJsonlLineRecord,
    projectClaudeJsonlLineToDirectMessages,
    readClaudeJsonlLineIdentity,
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
 * session file, so it carries the same continuity evidence the forward cursor
 * proves: the physical generation plus a BOUNDED content anchor over the
 * acknowledged prefix `[0, sourceAnchorOffsetBytes)`. Without it a same-path
 * replacement or in-place rewrite reads as ordinary continuation and splices
 * rows from two generations into one transcript.
 */
type ClaudeBackwardCursorV3 = Readonly<{
    v: 3;
    kind: 'claudeBackward';
    fileRelPath: string;
    endOffsetBytes: number;
    sourceAnchorOffsetBytes: number;
    sourceAnchorSha256: string;
    sourceGeneration: string;
    branchParentUuid: string | null | false;
}>;

type ClaudeForwardCursorV1 = Readonly<{
    v: 1;
    kind: 'claudeForward';
    fileRelPath: string;
    offsetBytes: number;
}>;

type ClaudeForwardCursorV3 = Readonly<{
    v: 3;
    kind: 'claudeForward';
    fileRelPath: string;
    offsetBytes: number;
    sourceAnchorOffsetBytes: number;
    sourceAnchorSha256: string;
    sourceGeneration: string;
}>;

type ClaudeSourceItem = AgentExternalSessionTranscriptItem | AgentExternalSessionTerminalObservation;

const nativeObservationContent = defineProtocolJsonValue();

function projectForwardLine(params: Parameters<typeof projectClaudeJsonlLineRecord>[0], projection?: undefined, activeOffsets?: ReadonlySet<number> | null, historicalReplay?: boolean): ReturnType<typeof projectClaudeJsonlLineRecord>;
function projectForwardLine(params: Parameters<typeof projectClaudeJsonlLineRecord>[0], projection: 'terminal' | undefined, activeOffsets?: ReadonlySet<number> | null, historicalReplay?: boolean): Readonly<{ disposition: 'mapped' | 'known_non_transcript' | 'unsupported'; items: readonly ClaudeSourceItem[] }>;
function projectForwardLine(params: Parameters<typeof projectClaudeJsonlLineRecord>[0], projection?: 'terminal', activeOffsets?: ReadonlySet<number> | null, historicalReplay?: boolean): Readonly<{
    disposition: 'mapped' | 'known_non_transcript' | 'unsupported';
    items: readonly ClaudeSourceItem[];
}> {
    if (projection !== 'terminal' && activeOffsets && !activeOffsets.has(params.lineStartOffsetBytes)) return { disposition: 'known_non_transcript', items: [] };
    if (projection === 'terminal') {
        const classification = classifyClaudeNativeTranscriptRow(params.lineValue);
        if (classification.content.kind === 'peer_message') return projectClaudeJsonlLineRecord(params);
        const raw = classification.rawObject;
        const attachment = raw && typeof raw === 'object' && 'attachment' in raw ? raw.attachment : null;
        const queuedCommand = attachment && typeof attachment === 'object' && 'type' in attachment
            && attachment.type === 'queued_command';
        // Native user envelopes also carry tool results. Those stay on the
        // ordinary semantic path; the runtime alone decides prompt acceptance.
        const userPrompt = classification.rawType === 'user'
            && !classification.semanticParts.some((part) => part.kind === 'tool_result' || part.kind === 'tool_use');
        const workflowEvidence = parseClaudeWorkflowFacts(params.lineValue).length > 0;
        if (readClaudeTaskLifecycleEnvelope(params.lineValue)?.subtype === 'task_notification' || userPrompt || classification.rawType === 'queue-operation' || (classification.rawType === 'attachment' && queuedCommand)) {
            const parsed = nativeObservationContent.safeParse(projectClaudeNativeTranscriptObservation(params.lineValue));
            if (!parsed.success) return { disposition: 'unsupported', items: [] };
            return {
                disposition: 'mapped',
                items: [
                    ...(historicalReplay ? projectClaudeJsonlLineRecord({ ...params, maxItems: undefined }).items : []),
                    { ...readClaudeJsonlLineIdentity(params), id: `${readClaudeJsonlLineIdentity(params).id}:source_observation`, raw: { role: 'source_observation', content: parsed.data } },
                ],
            };
        }
        if (workflowEvidence || classification.nativeBoundary !== null || classification.lifecycle.kind === 'stop_hook_feedback') {
            const parsed = nativeObservationContent.safeParse(projectClaudeNativeTranscriptObservation(params.lineValue));
            if (!parsed.success) return { disposition: 'unsupported', items: [] };
            // A lifecycle row is indivisible: publish its visible parts first,
            // then release its native boundary through the same ordered stream.
            const projected = projectClaudeJsonlLineRecord({ ...params, maxItems: undefined });
            const identity = readClaudeJsonlLineIdentity(params);
            return {
                disposition: 'mapped',
                items: [
                    ...projected.items,
                    { ...identity, id: `${identity.id}:source_observation`, raw: { role: 'source_observation', content: parsed.data } },
                ],
            };
        }
    }
    return projectClaudeJsonlLineRecord(params);
}

function projectHistoricalLine(
    params: Parameters<typeof projectClaudeJsonlLineRecord>[0], projection: 'terminal' | undefined, selected: boolean,
): Readonly<{ disposition: 'mapped' | 'known_non_transcript' | 'unsupported'; items: readonly ClaudeSourceItem[] }> {
    if (selected) return projectForwardLine(params, projection, undefined, true);
    if (projection !== 'terminal') return { disposition: 'known_non_transcript', items: [] };
    const classification = classifyClaudeNativeTranscriptRow(params.lineValue);
    if (classification.sidechain || parseClaudeWorkflowFacts(params.lineValue).length === 0) {
        return { disposition: 'known_non_transcript', items: [] };
    }
    const parsed = nativeObservationContent.safeParse(projectClaudeNativeTranscriptObservation(params.lineValue));
    if (!parsed.success) return { disposition: 'unsupported', items: [] };
    const identity = readClaudeJsonlLineIdentity(params);
    return { disposition: 'mapped', items: [{ ...identity, id: `${identity.id}:source_observation`,
        raw: { role: 'source_observation', content: parsed.data } }] };
}

export type ClaudeTranscriptResultBudget = Readonly<{
    fits(page: Readonly<{
        items: readonly ClaudeSourceItem[];
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

/** One backwards native ancestry decision, shared by every external projection. */
function selectClaudeExternalBranchLine(value: unknown, parentUuid: string | null | undefined) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { selected: true, parentUuid };
    const row = value as Record<string, unknown>;
    if (row.isSidechain === true) return { selected: false, parentUuid };
    const conversation = row.type === 'user' || row.type === 'assistant';
    // Native compaction metadata can bridge conversation ancestors. It must
    // advance an established branch, but must not choose the branch's leaf.
    if (!conversation && parentUuid === undefined) return { selected: true, parentUuid };
    if (typeof row.uuid !== 'string' || !('parentUuid' in row)) return { selected: !conversation || parentUuid === undefined, parentUuid };
    if (parentUuid !== undefined && parentUuid !== row.uuid) return { selected: false, parentUuid };
    return { selected: true, parentUuid: typeof row.parentUuid === 'string' ? row.parentUuid : null };
}

/** Select native ancestry without persisting transcript bodies or a search index. */
export async function readClaudeExternalTranscriptBranch(params: Readonly<{
    filePath: string;
    maxBytes: number;
    signal?: AbortSignal;
    fileSystem?: JsonlScannerFileSystem;
    checkWork?: () => void;
}>): Promise<Readonly<{ offsets: ReadonlySet<number> | null; partial: boolean }>> {
    const offsets = new Set<number>();
    let parentUuid: string | null | undefined;
    let endOffsetBytes = await readClaudeJsonlFileSize(params.filePath, params.signal);
    let partial = false;
    while (true) {
        throwIfAborted(params.signal);
        // The source byte bound also bounds the number of nonempty JSONL rows.
        // Consume each read once instead of reopening an overlapping chunk for
        // every row in a long conversation.
        const page = await readJsonlFileBackwardPage({ filePath: params.filePath, endOffsetBytes, maxBytes: params.maxBytes, maxItems: Math.max(1, params.maxBytes), fileSystem: params.fileSystem });
        throwIfAborted(params.signal);
        partial ||= Boolean(page.diagnostics?.length);
        for (let index = page.items.length - 1; index >= 0; index -= 1) {
            params.checkWork?.();
            const line = page.items[index]!;
            const selected = selectClaudeExternalBranchLine(line.value, parentUuid);
            parentUuid = selected.parentUuid;
            if (selected.selected) offsets.add(line.startOffsetBytes);
        }
        if (page.reachedStart) break;
        if (page.nextEndOffsetBytes >= endOffsetBytes) { partial = true; break; }
        endOffsetBytes = page.nextEndOffsetBytes;
    }
    return { offsets: parentUuid === undefined ? null : offsets, partial: partial || typeof parentUuid === 'string' };
}

export async function searchClaudeExternalTranscript(params: Readonly<{
    filePath: string;
    fileRelPath: string;
    query: string;
    maxBytes: number;
    signal?: AbortSignal;
    ripgrep: AgentExternalSessionsInvocation['ripgrep'];
    control: ExternalSessionContentSearchControl;
}>): Promise<Readonly<{ match?: { snippet: string; sourceItemId: string; messageIndex: number }; partial: boolean }>> {
    return searchExternalSessionContent({
        query: params.query, paths: [params.filePath], ripgrep: params.ripgrep, control: params.control,
        decode: async (matchText) => {
            const scanParams = { ...params, fileSystem: params.control.fileSystem, checkWork: params.control.checkWork };
            const branch = await readClaudeExternalTranscriptBranch(scanParams);
            let offsetBytes = 0;
            const records: { id: string; snippet?: string }[] = [];
            let partial = branch.partial;
            while (true) {
                throwIfAborted(params.signal);
                const page = await readJsonlFileForward({ filePath: params.filePath, offsetBytes, maxBytes: params.maxBytes, maxItems: Math.max(1, params.maxBytes), fileSystem: params.control.fileSystem });
                throwIfAborted(params.signal);
                partial ||= page.truncated || Boolean(page.diagnostics?.length);
                for (const line of page.items) {
                    params.control.checkWork();
                    if (branch.offsets && !branch.offsets.has(line.startOffsetBytes)) continue;
                    const projected = projectClaudeJsonlLineRecord({ fileRelPath: params.fileRelPath, lineStartOffsetBytes: line.startOffsetBytes, lineValue: line.value });
                    partial ||= projected.disposition === 'unsupported';
                    for (const item of projected.items) {
                        const content = item.raw.content;
                        const text = isTranscriptObject(content)
                            ? content.type === 'text' && typeof content.text === 'string' ? content.text
                                : content.type === 'acp' && 'data' in content && isTranscriptObject(content.data) && content.data.type === 'message' && typeof content.data.message === 'string' ? content.data.message : null
                            : null;
                        const snippet = text !== null ? matchText(text) : null;
                        records.push({ id: item.id, ...(snippet !== null ? { snippet } : {}) });
                    }
                }
                if (page.reachedEnd) break;
                if (page.nextOffsetBytes <= offsetBytes) { partial = true; break; }
                offsetBytes = page.nextOffsetBytes;
            }
            return { records, partial };
        },
    });
}

function isTranscriptObject(value: unknown): value is Readonly<Record<string, unknown>> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
    signal?.throwIfAborted();
}

function encodeCursor(
    value:
        | ClaudeBackwardCursorV1
        | ClaudeBackwardCursorV3
        | ClaudeForwardCursorV1
        | ClaudeForwardCursorV3,
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
): ClaudeBackwardCursorV1 | ClaudeBackwardCursorV3 | null {
    const record = asCursorRecord(raw);
    if (!record || (record.v !== 1 && record.v !== 3) || record.kind !== 'claudeBackward') return null;
    const fileRelPath = typeof record.fileRelPath === 'string' ? record.fileRelPath : '';
    const endOffsetBytes = typeof record.endOffsetBytes === 'number' && Number.isFinite(record.endOffsetBytes)
        ? Math.trunc(record.endOffsetBytes)
        : Number.NaN;
    if (!fileRelPath.trim() || !(endOffsetBytes >= 0)) return null;
    if (record.v === 1) {
        return { v: 1, kind: 'claudeBackward', fileRelPath, endOffsetBytes };
    }
    if (record.branchParentUuid !== null && record.branchParentUuid !== false && typeof record.branchParentUuid !== 'string') return null;
    const sourceAnchorOffsetBytes =
        typeof record.sourceAnchorOffsetBytes === 'number'
        && Number.isFinite(record.sourceAnchorOffsetBytes)
            ? Math.trunc(record.sourceAnchorOffsetBytes)
            : Number.NaN;
    const sourceAnchorSha256 =
        typeof record.sourceAnchorSha256 === 'string' ? record.sourceAnchorSha256 : '';
    const sourceGeneration =
        typeof record.sourceGeneration === 'string' ? record.sourceGeneration : '';
    return sourceAnchorOffsetBytes >= 0
        && sourceAnchorOffsetBytes <= endOffsetBytes
        && /^[A-Za-z0-9_-]{43}$/.test(sourceAnchorSha256)
        && SOURCE_GENERATION_PATTERN.test(sourceGeneration)
        ? {
            v: 3,
            kind: 'claudeBackward',
            fileRelPath,
            endOffsetBytes,
            sourceAnchorOffsetBytes,
            sourceAnchorSha256,
            sourceGeneration,
            branchParentUuid: record.branchParentUuid as string | null | false,
        }
        : null;
}

function decodeForwardCursor(
    raw: string,
): ClaudeForwardCursorV1 | ClaudeForwardCursorV3 | null {
    const record = asCursorRecord(raw);
    if (
        !record
        || (record.v !== 1 && record.v !== 3)
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
    const sourceGeneration =
        typeof record.sourceGeneration === 'string' ? record.sourceGeneration : '';
    return sourceAnchorOffsetBytes >= 0
        && sourceAnchorOffsetBytes <= offsetBytes
        && /^[A-Za-z0-9_-]{43}$/.test(sourceAnchorSha256)
        && SOURCE_GENERATION_PATTERN.test(sourceGeneration)
        ? {
            v: 3,
            kind: 'claudeForward',
            fileRelPath,
            offsetBytes,
            sourceAnchorOffsetBytes,
            sourceAnchorSha256,
            sourceGeneration,
        }
        : null;
}

/**
 * How much of the acknowledged prefix each anchor window covers.
 *
 * The continuity contract is that append, in-place rewrite and replacement stay
 * distinguishable — NOT that every acknowledged byte is re-verified. Hashing the
 * whole prefix satisfied the contract by reading it again on every cursor mint
 * and every cursor validation, which made draining a transcript quadratic in its
 * size. Two fixed windows plus the prefix LENGTH keep the same three cases
 * apart at a cost that does not grow with the file:
 *
 * - append leaves the head, the boundary and the length alone;
 * - a rewrite at the boundary — where a writer that reflowed the prefix
 *   necessarily lands — changes the boundary window;
 * - a rewrite of the head, a truncation, or a regrow to a different length
 *   changes the head window or the length;
 * - a replacement changes the physical generation.
 */
const SOURCE_ANCHOR_WINDOW_BYTES = 8 * 1024;

/**
 * `i:` is the physical generation proper — the device/inode pair. Where a
 * filesystem does not report an inode (Windows shares and some network mounts
 * return zero), `b:` falls back to the creation timestamp, which still changes
 * when a new file takes the same path, and `p:` names the case where neither is
 * available and the content anchor carries the whole contract. Refusing to mint
 * a cursor there — the previous behavior — made external transcript paging fail
 * outright on those filesystems rather than degrade.
 */
const SOURCE_GENERATION_PATTERN = /^(?:i:\d+:\d+|b:\d+:\d+|p:\d+)$/;

function formatSourceGeneration(stats: Readonly<{
    dev: bigint;
    ino: bigint;
    birthtimeNs: bigint;
}>): string {
    if (stats.ino !== 0n) return `i:${stats.dev}:${stats.ino}`;
    if (stats.birthtimeNs > 0n) return `b:${stats.dev}:${stats.birthtimeNs}`;
    return `p:${stats.dev}`;
}

/**
 * The generation alone, for the places that need a byte-exact stand-in for a
 * cursor rather than the cursor itself. One stat, no read.
 */
async function readSourceGeneration(
    filePath: string,
    signal?: AbortSignal,
): Promise<string | null> {
    throwIfAborted(signal);
    const stats = await stat(filePath, { bigint: true }).catch(() => null);
    throwIfAborted(signal);
    return stats?.isFile() ? formatSourceGeneration(stats) : null;
}

async function hashAnchorWindow(params: Readonly<{
    handle: Awaited<ReturnType<typeof open>>;
    hash: ReturnType<typeof createHash>;
    buffer: Buffer;
    startOffsetBytes: number;
    endOffsetBytes: number;
    signal?: AbortSignal;
}>): Promise<boolean> {
    let position = params.startOffsetBytes;
    while (position < params.endOffsetBytes) {
        throwIfAborted(params.signal);
        const readLength = Math.min(params.buffer.length, params.endOffsetBytes - position);
        const read = await params.handle.read(params.buffer, 0, readLength, position);
        if (read.bytesRead !== readLength) return false;
        params.hash.update(params.buffer.subarray(0, read.bytesRead));
        position += read.bytesRead;
    }
    return true;
}

async function readSourceAnchorEvidence(
    filePath: string,
    offsetBytes: number,
    signal?: AbortSignal,
): Promise<Readonly<{
    sourceAnchorSha256: string;
    sourceGeneration: string;
}> | null> {
    throwIfAborted(signal);
    const handle = await open(filePath, 'r').catch(() => null);
    if (!handle) return null;
    try {
        const before = await handle.stat({ bigint: true });
        if (!before.isFile() || before.size < BigInt(offsetBytes)) return null;
        const hash = createHash('sha256');
        // The acknowledged LENGTH is part of the anchor: without it two prefixes
        // that share a head and a boundary window would anchor alike.
        hash.update(`claudeAnchor/v3\n${offsetBytes}\n`);
        const buffer = Buffer.allocUnsafe(SOURCE_ANCHOR_WINDOW_BYTES);
        const headEndOffsetBytes = Math.min(offsetBytes, SOURCE_ANCHOR_WINDOW_BYTES);
        const boundaryStartOffsetBytes = Math.max(
            headEndOffsetBytes,
            offsetBytes - SOURCE_ANCHOR_WINDOW_BYTES,
        );
        const hashed = await hashAnchorWindow({
            handle,
            hash,
            buffer,
            startOffsetBytes: 0,
            endOffsetBytes: headEndOffsetBytes,
            ...(signal ? { signal } : {}),
        }) && await hashAnchorWindow({
            handle,
            hash,
            buffer,
            startOffsetBytes: boundaryStartOffsetBytes,
            endOffsetBytes: offsetBytes,
            ...(signal ? { signal } : {}),
        });
        if (!hashed) return null;
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
        return {
            sourceAnchorSha256: hash.digest('base64url'),
            sourceGeneration: formatSourceGeneration(afterHandle),
        };
    } finally {
        await handle.close();
    }
}

async function createForwardCursor(params: Readonly<{
    filePath: string;
    fileRelPath: string;
    offsetBytes: number | null;
    signal?: AbortSignal;
}>): Promise<string | null> {
    if (params.offsetBytes === null) {
        throw new Error('Cannot establish Claude transcript tail boundary within the JSONL read budget.');
    }
    const evidence = await readSourceAnchorEvidence(
        params.filePath,
        params.offsetBytes,
        params.signal,
    );
    if (!evidence) return null;
    return encodeCursor({
        v: 3,
        kind: 'claudeForward',
        fileRelPath: params.fileRelPath,
        offsetBytes: params.offsetBytes,
        sourceAnchorOffsetBytes: params.offsetBytes,
        ...evidence,
    });
}

async function readTailCursor(params: Readonly<{
    filePath: string;
    fileRelPath: string;
    endOffsetBytes: number;
    maxBytes: number;
    signal?: AbortSignal;
}>): Promise<string | null> {
    const page = await readJsonlFileBackwardPage({
        filePath: params.filePath,
        endOffsetBytes: params.endOffsetBytes,
        maxBytes: params.maxBytes,
        maxItems: 1,
        // This read only establishes the tail boundary. Match anchor I/O
        // granularity without reducing the scanner's page or oversize budget.
        chunkBytes: SOURCE_ANCHOR_WINDOW_BYTES,
    });
    throwIfAborted(params.signal);
    if (page.diagnostics?.some((diagnostic) => diagnostic.code === 'malformed_source_utf8')) {
        throw new Error('Claude transcript source contains malformed UTF-8.');
    }
    return await createForwardCursor({
        filePath: params.filePath,
        fileRelPath: params.fileRelPath,
        offsetBytes: page.tailOffsetBytes,
        signal: params.signal,
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
    branchParentUuid?: string | null;
}>): Promise<string | null> {
    const evidence = await readSourceAnchorEvidence(
        params.filePath,
        params.endOffsetBytes,
        params.signal,
    );
    if (!evidence) return null;
    return encodeCursor({
        v: 3,
        kind: 'claudeBackward',
        fileRelPath: params.fileRelPath,
        endOffsetBytes: params.endOffsetBytes,
        sourceAnchorOffsetBytes: params.endOffsetBytes,
        branchParentUuid: params.branchParentUuid ?? (params.branchParentUuid === null ? null : false),
        ...evidence,
    });
}

/**
 * A byte-exact stand-in for the cursor `createBackwardCursor` would mint at the
 * same offset, used only to size a page against the result budget. The SHA-256
 * anchor is always 43 base64url characters and the generation belongs to the
 * file rather than the offset, so probing with the real generation costs one
 * stat instead of one anchor read per row — and stays byte-exact, which a
 * placeholder generation would not be.
 */
function encodeBackwardCursorEnvelopeProbe(params: Readonly<{
    fileRelPath: string;
    endOffsetBytes: number;
    sourceGeneration: string;
    branchParentUuid?: string | null;
}>): string {
    return encodeCursor({
        v: 3,
        kind: 'claudeBackward',
        fileRelPath: params.fileRelPath,
        endOffsetBytes: params.endOffsetBytes,
        sourceAnchorOffsetBytes: params.endOffsetBytes,
        sourceAnchorSha256: 'A'.repeat(43),
        sourceGeneration: params.sourceGeneration,
        branchParentUuid: params.branchParentUuid ?? (params.branchParentUuid === null ? null : false),
    });
}

/** The forward counterpart of `encodeBackwardCursorEnvelopeProbe`. */
function encodeForwardCursorEnvelopeProbe(params: Readonly<{
    fileRelPath: string;
    offsetBytes: number;
    sourceGeneration: string;
}>): string {
    return encodeCursor({
        v: 3,
        kind: 'claudeForward',
        fileRelPath: params.fileRelPath,
        offsetBytes: params.offsetBytes,
        sourceAnchorOffsetBytes: params.offsetBytes,
        sourceAnchorSha256: 'A'.repeat(43),
        sourceGeneration: params.sourceGeneration,
    });
}

function projectLines(params: Readonly<{
    lines: ReadonlyArray<Readonly<{ startOffsetBytes: number; value: unknown }>>;
    fileRelPath: string;
    maxItems: number;
    projection?: 'terminal';
}>): Readonly<{
    items: ClaudeSourceItem[];
    consumedUnsupportedRecord: boolean;
}> {
    const items: ClaudeSourceItem[] = [];
    let consumedUnsupportedRecord = false;
    for (const line of params.lines) {
        if (items.length >= params.maxItems) break;
        const projected = projectForwardLine({
            fileRelPath: params.fileRelPath,
            lineStartOffsetBytes: line.startOffsetBytes,
            lineValue: line.value,
            maxItems: params.maxItems - items.length,
        }, params.projection, undefined, true);
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
    projection?: 'terminal';
    cursor?: string;
    maxBytes: number;
    maxItems: number;
    signal?: AbortSignal;
    resultBudget?: ClaudeTranscriptResultBudget;
}>): Promise<Readonly<{
    items: ClaudeSourceItem[];
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
    const tailParams = {
        filePath: resolved.filePath,
        fileRelPath: resolved.fileRelPath,
        endOffsetBytes: fileSize,
        maxBytes: params.maxBytes,
        signal: params.signal,
    };
    if (params.direction === 'newer') {
        const tailCursor = await readTailCursor(tailParams);
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
            projection: params.projection,
            maxBytes: params.maxBytes,
            maxItems: params.maxItems,
            signal: params.signal,
            ...(params.resultBudget
                ? {
                    resultBudget: {
                        fits(candidate) {
                            const hasMore = candidate.hasMore === true;
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
        const hasMore = forward.hasMore === true;
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
    if (decoded?.v === 3 && !cursorMismatch) {
        const currentEvidence = await readSourceAnchorEvidence(
            resolved.filePath,
            decoded.sourceAnchorOffsetBytes,
            params.signal,
        );
        if (
            !currentEvidence
            || currentEvidence.sourceAnchorSha256 !== decoded.sourceAnchorSha256
            || currentEvidence.sourceGeneration !== decoded.sourceGeneration
        ) {
            return { items: [], nextCursor: null, tailCursor: await readTailCursor(tailParams), hasMore: false, truncated: true };
        }
    }
    const endOffsetBytes = cursorMismatch || !decoded
        ? fileSize
        : Math.min(fileSize, Math.max(0, decoded.endOffsetBytes));
    if (endOffsetBytes <= 0) {
        return { items: [], nextCursor: null, tailCursor: await readTailCursor(tailParams), hasMore: false, ...(cursorMismatch ? { truncated: true } : {}) };
    }
    const sourceGeneration = await readSourceGeneration(resolved.filePath, params.signal);
    if (!sourceGeneration) {
        return { items: [], nextCursor: null, tailCursor: await readTailCursor(tailParams), hasMore: false, truncated: true };
    }

    // Carry one pending native parent, never a body cache or retained-row set.
    let branchParentUuid = decoded?.v === 3 && decoded.branchParentUuid !== false ? decoded.branchParentUuid : undefined;
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
    const tailCursor = endOffsetBytes === fileSize
        ? await createForwardCursor({
            filePath: resolved.filePath,
            fileRelPath: resolved.fileRelPath,
            offsetBytes: page.tailOffsetBytes,
            signal: params.signal,
        })
        : await readTailCursor(tailParams);
    const maxItems = Math.max(1, Math.trunc(params.maxItems));
    if (params.resultBudget || params.projection === 'terminal') {
        const items: ClaudeSourceItem[] = [];
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
            const selection = selectClaudeExternalBranchLine(line.value, branchParentUuid);
            const projected = projectHistoricalLine({
                fileRelPath: resolved.fileRelPath,
                lineStartOffsetBytes: line.startOffsetBytes,
                lineValue: line.value,
                maxItems: maxItems - items.length,
            }, params.projection, selection.selected);
            const mapped = projected.items;
            if (items.length + mapped.length > maxItems) {
                if (items.length === 0) throw new ClaudeTranscriptResultBudgetTooSmallError('Claude transcript item budget cannot fit one native row.');
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
                    sourceGeneration,
                    branchParentUuid: selection.parentUuid,
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
            if (params.resultBudget && !params.resultBudget.fits(proposed)) {
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
            branchParentUuid = selection.parentUuid;
            if (projected.disposition === 'unsupported') consumedUnsupportedRecord = true;
        }

        const hasMore = stoppedBeforeOlderLine || !page.reachedStart;
        const nextCursor = hasMore
            ? await createBackwardCursor({
                filePath: resolved.filePath,
                fileRelPath: resolved.fileRelPath,
                endOffsetBytes: nextEndOffsetBytes,
                signal: params.signal,
                branchParentUuid,
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
        if (params.resultBudget && !params.resultBudget.fits(result)) {
            throw new ClaudeTranscriptResultBudgetTooSmallError(
                'Claude transcript result byte budget cannot fit the page envelope.',
            );
        }
        return result;
    }
    const selectedOffsets = new Set<number>();
    for (let index = page.items.length - 1; index >= 0; index -= 1) {
        const line = page.items[index]!;
        const selection = selectClaudeExternalBranchLine(line.value, branchParentUuid);
        branchParentUuid = selection.parentUuid;
        if (selection.selected) selectedOffsets.add(line.startOffsetBytes);
    }
    const { items, consumedUnsupportedRecord } = projectLines({
        lines: page.items.filter((line) => selectedOffsets.has(line.startOffsetBytes)),
        fileRelPath: resolved.fileRelPath,
        maxItems,
        ...(params.projection ? { projection: params.projection } : {}),
    });
    const hasMore = !page.reachedStart;
    const nextCursor = hasMore
        ? await createBackwardCursor({
            filePath: resolved.filePath,
            fileRelPath: resolved.fileRelPath,
            endOffsetBytes: page.nextEndOffsetBytes,
            signal: params.signal,
            branchParentUuid,
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
    projection?: 'terminal';
    maxBytes: number;
    maxItems: number;
    signal?: AbortSignal;
    resultBudget?: ClaudeTranscriptResultBudget;
}>): Promise<Readonly<{
    items: ClaudeSourceItem[];
    nextCursor: string | null;
    truncated: boolean;
    hasMore?: boolean;
    readAfterOutcome?: 'already_current' | 'gap_or_cursor_expired' | 'source_replaced' | 'source_unavailable';
    diagnostics?: readonly Readonly<{
        code: string;
        severity: 'benign' | 'required';
        count: number;
        positions: readonly number[];
    }>[];
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
    const tailParams = {
        filePath: resolved.filePath,
        fileRelPath: resolved.fileRelPath,
        endOffsetBytes: fileSize,
        maxBytes: params.maxBytes,
        signal: params.signal,
    };
    if (params.cursor === 'tail') {
        const nextCursor = await readTailCursor(tailParams);
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
            nextCursor: await readTailCursor(tailParams),
            truncated: true,
            readAfterOutcome: 'source_replaced',
        };
    }
    if (decoded.v === 3) {
        const currentEvidence = await readSourceAnchorEvidence(
            resolved.filePath,
            decoded.sourceAnchorOffsetBytes,
            params.signal,
        );
        if (
            !currentEvidence
            || currentEvidence.sourceAnchorSha256
              !== decoded.sourceAnchorSha256
            || currentEvidence.sourceGeneration !== decoded.sourceGeneration
        ) {
            return {
                items: [],
                nextCursor: await readTailCursor(tailParams),
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
            nextCursor: await readTailCursor(tailParams),
            truncated: true,
            readAfterOutcome: 'gap_or_cursor_expired',
        };
    }

    const branch = params.projection === 'terminal' ? { offsets: null, partial: false }
        : await readClaudeExternalTranscriptBranch({ filePath: resolved.filePath, maxBytes: params.maxBytes, signal: params.signal });
    if (params.resultBudget || params.projection === 'terminal') {
        // The budget is measured against the cursor this page would actually
        // return, so the probe carries the file's real generation rather than a
        // placeholder whose length differs from it.
        const forwardSourceGeneration = await readSourceGeneration(resolved.filePath, params.signal);
        if (!forwardSourceGeneration) {
            return { items: [], nextCursor: null, truncated: true, readAfterOutcome: 'source_unavailable' };
        }
        const maxItems = Math.max(1, Math.trunc(params.maxItems));
        const items: ClaudeSourceItem[] = [];
        const knownNonTranscriptPositions: number[] = [];
        const unsupportedPositions: number[] = [];
        let nextOffsetBytes = read.items.length === 0
            ? read.nextOffsetBytes
            : Math.max(0, decoded.offsetBytes);

        for (let index = 0; index < read.items.length; index += 1) {
            throwIfAborted(params.signal);
            const line = read.items[index];
            if (!line) continue;
            const projected = projectForwardLine({
                fileRelPath: resolved.fileRelPath,
                lineStartOffsetBytes: line.startOffsetBytes,
                lineValue: line.value,
                maxItems: maxItems - items.length,
            }, params.projection, branch.offsets);
            const mapped = projected.items;
            if (items.length + mapped.length > maxItems) {
                if (items.length === 0) {
                    throw new ClaudeTranscriptResultBudgetTooSmallError(
                        'Claude transcript result item budget cannot fit one complete source row.',
                    );
                }
                break;
            }
            const proposedItems = [...items, ...mapped];
            const proposedNextOffsetBytes = read.items[index + 1]?.startOffsetBytes
                ?? read.nextOffsetBytes;
            const proposed = {
                items: proposedItems,
                nextCursor: encodeForwardCursorEnvelopeProbe({
                    fileRelPath: resolved.fileRelPath,
                    offsetBytes: proposedNextOffsetBytes,
                    sourceGeneration: forwardSourceGeneration,
                }),
                truncated: false,
                hasMore: read.hitPageLimit || proposedNextOffsetBytes < read.nextOffsetBytes,
            };
            if (params.resultBudget && !params.resultBudget.fits(proposed)) {
                if (items.length === 0) {
                    throw new ClaudeTranscriptResultBudgetTooSmallError(
                        'Claude transcript result byte budget cannot fit one item.',
                    );
                }
                break;
            }
            if (projected.disposition === 'known_non_transcript') {
                knownNonTranscriptPositions.push(line.startOffsetBytes);
            } else if (projected.disposition === 'unsupported') {
                unsupportedPositions.push(line.startOffsetBytes);
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
            ...(read.diagnostics ?? []).map((diagnostic) => ({
                ...diagnostic,
                severity: 'required' as const,
            })),
            ...(knownNonTranscriptPositions.length > 0
                ? [{
                    code: 'non_transcript_record_skipped',
                    severity: 'benign' as const,
                    count: knownNonTranscriptPositions.length,
                    positions: knownNonTranscriptPositions.slice(0, 200),
                }]
                : []),
            ...(unsupportedPositions.length > 0
                ? [{
                    code: 'unsupported_record_skipped',
                    severity: 'required' as const,
                    count: unsupportedPositions.length,
                    positions: unsupportedPositions.slice(0, 200),
                }]
                : []),
        ];
        const result = {
            items,
            nextCursor,
            truncated: false,
            hasMore: read.hitPageLimit || nextOffsetBytes < read.nextOffsetBytes,
            ...(diagnostics.length > 0 ? { diagnostics } : {}),
        };
        if (params.resultBudget && !params.resultBudget.fits(result)) {
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
        const projected = projectForwardLine({
            fileRelPath: resolved.fileRelPath,
            lineStartOffsetBytes: line.startOffsetBytes,
            lineValue: line.value,
            maxItems: maxItems - projectedItems.length,
        }, undefined, branch.offsets);
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
        ...(read.diagnostics ?? []).map((diagnostic) => ({
            ...diagnostic,
            severity: 'required' as const,
        })),
        ...(knownNonTranscriptPositions.length > 0
            ? [{
                code: 'non_transcript_record_skipped',
                severity: 'benign' as const,
                count: knownNonTranscriptPositions.length,
                positions: knownNonTranscriptPositions.slice(0, 200),
            }]
            : []),
        ...(unsupportedPositions.length > 0
            ? [{
                code: 'unsupported_record_skipped',
                severity: 'required' as const,
                count: unsupportedPositions.length,
                positions: unsupportedPositions.slice(0, 200),
            }]
            : []),
    ];
    return {
        items: projectedItems,
        nextCursor,
        truncated: false,
        hasMore: read.hitPageLimit,
        ...(diagnostics.length > 0 ? { diagnostics } : {}),
    };
}
