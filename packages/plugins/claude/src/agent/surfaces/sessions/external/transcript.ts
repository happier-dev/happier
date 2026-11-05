import type { SessionMediaService } from '@happier-dev/plugin-sdk/sessions';
import { createHash } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { findExternalSessionContentMatchRange } from '@happier-dev/plugin-sdk/sessions/external';
import { z } from 'zod/mini';

import { isRecord } from '@happier-dev/plugin-sdk';
import { defineProtocolJsonValue } from '@happier-dev/plugin-sdk/protocol';
import type {
    AgentExternalSessionTerminalObservation,
    AgentExternalSessionTranscriptItem,
    AgentExternalSessionsInvocation,
    AgentExternalSessionsReadAfterDiagnostic,
} from '@happier-dev/plugin-sdk/sessions/external';

import {
    readJsonlFileBackwardPage,
    readJsonlFileForward,
    type JsonlScannerFileSystem,
    type ExternalSessionContentSearchControl,
    searchExternalSessionContent,
    ExternalSessionContentSearchYield,
    prefilterExternalSessionContentPaths,
} from '@happier-dev/plugin-sdk/sessions/file-stores';

import { readClaudeToolResultMediaRequests } from '../../../transcripts/toolResultMedia.js';
import { isClaudeTaskLifecycleResultEnvelope, readClaudeTaskLifecycleEnvelope } from '../../../transcripts/taskNotification.js';
import { parseClaudeWorkflowFacts } from '../../../workflowRecords/correlation.js';
import { classifyClaudeNativeTranscriptRow, projectClaudeNativeTranscriptObservation } from '../../../transcripts/nativeSemanticProjection.js';
import {
    projectClaudeJsonlLineRecord,
    projectClaudeJsonlLineToDirectMessages,
    readClaudeJsonlLineIdentity,
    readClaudeJsonlToolResultItemOffset,
    claudeContentSearchLinePatterns,
} from '../../../transcripts/projection.js';

import { ClaudeCandidateSourceChangedError, readClaudeJsonlFileSize, resolveClaudeJsonlSessionFile } from './files.js';
import { applyClaudeTitleRecord, resolveClaudeTitle } from './metadata.js';
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

function projectMediaEligibleLine(
    params: Parameters<typeof projectClaudeJsonlLineRecord>[0], includeMediaReferences?: boolean,
): ReturnType<typeof projectClaudeJsonlLineRecord> {
    const projected = projectClaudeJsonlLineRecord(params);
    if (!includeMediaReferences || projected.disposition === 'known_non_transcript') return projected;
    const requests = readClaudeToolResultMediaRequests(params.lineValue, params);
    if (requests.length === 0) return projected;
    return { ...projected, items: projected.items.map(item => {
        const content = item.raw.content;
        if (!isRecord(content) || content.type !== 'acp' || !('data' in content)) return item;
        const data = content.data;
        if (!isRecord(data) || data.type !== 'tool-result') return item;
        const media = requests.find(candidate => candidate.request.toolCallId === data.callId);
        if (!media) return item;
        return { ...item, toolResultMedia: {
            sourceMessageId: media.sourceMessageId, toolCallId: media.request.toolCallId,
        } };
    }) };
}

function projectForwardLine(params: Parameters<typeof projectClaudeJsonlLineRecord>[0], projection?: undefined, activeOffsets?: ReadonlySet<number> | null, historicalReplay?: boolean, includeMediaReferences?: boolean): ReturnType<typeof projectClaudeJsonlLineRecord>;
function projectForwardLine(params: Parameters<typeof projectClaudeJsonlLineRecord>[0], projection: 'terminal' | undefined, activeOffsets?: ReadonlySet<number> | null, historicalReplay?: boolean, includeMediaReferences?: boolean): Readonly<{ disposition: 'mapped' | 'known_non_transcript' | 'unsupported'; items: readonly ClaudeSourceItem[] }>;
function projectForwardLine(params: Parameters<typeof projectClaudeJsonlLineRecord>[0], projection?: 'terminal', activeOffsets?: ReadonlySet<number> | null, historicalReplay?: boolean, includeMediaReferences?: boolean): Readonly<{
    disposition: 'mapped' | 'known_non_transcript' | 'unsupported';
    items: readonly ClaudeSourceItem[];
}> {
    if (projection !== 'terminal' && activeOffsets && !activeOffsets.has(params.lineStartOffsetBytes)) return { disposition: 'known_non_transcript', items: [] };
    if (projection === 'terminal') {
        const classification = classifyClaudeNativeTranscriptRow(params.lineValue);
        // The ordered task projector knows whether this hand-back belongs to an active launch.
        const runtimeDecidesPeer = classification.content.kind === 'peer_message' && classification.content.peer.handback;
        if (classification.content.kind === 'peer_message' && !runtimeDecidesPeer) return projectMediaEligibleLine(params, includeMediaReferences);
        const raw = classification.rawObject;
        const attachment = raw && typeof raw === 'object' && 'attachment' in raw ? raw.attachment : null;
        const queuedCommand = attachment && typeof attachment === 'object' && 'type' in attachment
            && attachment.type === 'queued_command';
        // Native user envelopes also carry tool results. Those stay on the
        // ordinary semantic path; the runtime alone decides prompt acceptance.
        const userPrompt = classification.rawType === 'user'
            && classification.lifecycle.kind !== 'shell_output'
            && !classification.semanticParts.some((part) => part.kind === 'tool_result' || part.kind === 'tool_use');
        const workflowEvidence = parseClaudeWorkflowFacts(params.lineValue).length > 0;
        // Replay and live share the runtime's correlation authority for task results and reports.
        const runtimeDecidesTask = runtimeDecidesPeer || isClaudeTaskLifecycleResultEnvelope(readClaudeTaskLifecycleEnvelope(params.lineValue));
        if (runtimeDecidesTask || userPrompt || classification.rawType === 'queue-operation' || (classification.rawType === 'attachment' && queuedCommand)) {
            const parsed = nativeObservationContent.safeParse(projectClaudeNativeTranscriptObservation(params.lineValue));
            if (!parsed.success) return { disposition: 'unsupported', items: [] };
            return {
                disposition: 'mapped',
                items: [
                    ...(historicalReplay && !runtimeDecidesTask ? projectMediaEligibleLine({ ...params, maxItems: undefined }, includeMediaReferences).items : []),
                    { ...readClaudeJsonlLineIdentity(params), id: `${readClaudeJsonlLineIdentity(params).id}:source_observation`, raw: { role: 'source_observation', content: parsed.data } },
                ],
            };
        }
        if (workflowEvidence || classification.nativeBoundary !== null || classification.lifecycle.kind === 'stop_hook_feedback'
            || classification.lifecycle.kind === 'shell_output') {
            const parsed = nativeObservationContent.safeParse(projectClaudeNativeTranscriptObservation(params.lineValue));
            if (!parsed.success) return { disposition: 'unsupported', items: [] };
            // A lifecycle row is indivisible: publish its visible parts first,
            // then release its native boundary through the same ordered stream.
            const projected = projectMediaEligibleLine({ ...params, maxItems: undefined }, includeMediaReferences);
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
    return projectMediaEligibleLine(params, projection === 'terminal' && includeMediaReferences);
}

function projectHistoricalLine(
    params: Parameters<typeof projectClaudeJsonlLineRecord>[0], projection: 'terminal' | undefined, selected: boolean, includeMediaReferences?: boolean,
): Readonly<{ disposition: 'mapped' | 'known_non_transcript' | 'unsupported'; items: readonly ClaudeSourceItem[] }> {
    if (selected) return projectForwardLine(params, projection, undefined, true, includeMediaReferences);
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
    constructor(reason: 'transcript_item_count_budget' | 'transcript_item_byte_budget' | 'transcript_page_byte_budget') {
        super(`external_sessions_${reason}`);
    }
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
    /** Only retain ancestry decisions for this forward page; newer rows still choose its branch. */
    range?: Readonly<{ startOffsetBytes: number; endOffsetBytes: number }>;
    signal?: AbortSignal;
    fileSystem?: JsonlScannerFileSystem;
    checkWork?: () => void;
}>): Promise<Readonly<{ offsets: ReadonlySet<number> | null; partial: boolean }>> {
    const offsets = new Set<number>();
    let parentUuid: string | null | undefined;
    let endOffsetBytes = await readClaudeJsonlFileSize(params.filePath, params.signal);
    let partial = false;
    let reachedStart = false;
    while (true) {
        throwIfAborted(params.signal);
        // The source byte bound also bounds the number of nonempty JSONL rows.
        // Consume each read once instead of reopening an overlapping chunk for
        // every row in a long conversation.
        const page = await readJsonlFileBackwardPage({ filePath: params.filePath, endOffsetBytes, maxBytes: params.maxBytes, maxItems: Math.max(1, params.maxBytes), fileSystem: params.fileSystem, includeMalformedRecords: true });
        throwIfAborted(params.signal);
        partial ||= Boolean(page.diagnostics?.length);
        for (let index = page.items.length - 1; index >= 0; index -= 1) {
            params.checkWork?.();
            const line = page.items[index]!;
            if (params.range && line.startOffsetBytes < params.range.startOffsetBytes) break;
            const selected = selectClaudeExternalBranchLine(line.value, parentUuid);
            parentUuid = selected.parentUuid;
            if (selected.selected && (!params.range || line.startOffsetBytes < params.range.endOffsetBytes)) {
                offsets.add(line.startOffsetBytes);
            }
        }
        if (page.reachedStart) { reachedStart = true; break; }
        if (params.range && page.nextEndOffsetBytes <= params.range.startOffsetBytes) break;
        if (page.nextEndOffsetBytes >= endOffsetBytes) { partial = true; break; }
        endOffsetBytes = page.nextEndOffsetBytes;
    }
    return { offsets: parentUuid === undefined ? null : offsets, partial: partial || (reachedStart && typeof parentUuid === 'string') };
}

const ClaudeContentSearchRowSchema = z.strictObject({
    startOffsetBytes: z.number().check(z.int(), z.nonnegative()),
    endOffsetBytes: z.number().check(z.int(), z.nonnegative()),
});

const ClaudeContentSearchProgressSchema = z.strictObject({
    fileRelPath: z.string(),
    sourceIdentity: z.string(),
    sourceSize: z.number().check(z.int(), z.nonnegative()),
    endOffsetBytes: z.number().check(z.int(), z.nonnegative()),
    branchParentUuid: z.union([z.string(), z.null(), z.literal(false)]),
    count: z.number().check(z.int(), z.nonnegative()),
    partial: z.boolean(),
    candidateEndOffsetBytes: z.optional(z.number().check(z.int(), z.nonnegative())),
    candidateMatched: z.optional(z.boolean()),
    title: z.strictObject({ customTitle: z.nullable(ClaudeContentSearchRowSchema), aiTitle: z.nullable(ClaudeContentSearchRowSchema), fallbackTitle: z.nullable(ClaudeContentSearchRowSchema),
        customTitleSeen: z.optional(z.boolean()), aiTitleSeen: z.optional(z.boolean()) }),
    match: z.optional((<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(ClaudeContentSearchRowSchema, { itemIndex: z.number().check(z.int(), z.nonnegative()), newerItems: z.number().check(z.int(), z.nonnegative()) }))),
});

export type ClaudeContentSearchProgress = z.infer<typeof ClaudeContentSearchProgressSchema>;

export function parseClaudeContentSearchProgress(value: unknown): ClaudeContentSearchProgress | null {
    const parsed = ClaudeContentSearchProgressSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
}

export class ClaudeContentSearchYield extends ExternalSessionContentSearchYield {
    constructor(readonly progress: ClaudeContentSearchProgress) { super(); }
}

export type ClaudeContentSearchFileMetadata = Readonly<Pick<BigIntStats,
    'dev' | 'ino' | 'birthtimeNs' | 'size' | 'mtimeNs' | 'ctimeNs'>>;

export async function searchClaudeExternalTranscript(params: Readonly<{
    filePath: string;
    fileRelPath: string;
    query: string;
    maxBytes: number;
    signal?: AbortSignal;
    ripgrep: AgentExternalSessionsInvocation['ripgrep'];
    control: ExternalSessionContentSearchControl;
    progress?: ClaudeContentSearchProgress;
    /** The candidate page already ran the shared prefilter over this source. */
    prefiltered?: boolean;
    /** Facts captured before rg; a concurrent write forces exact decoding. */
    prefilterMetadata?: ClaudeContentSearchFileMetadata;
    /** Query-local positions, never decoded match or source identity authority. */
    candidateByteOffsets?: readonly number[];
    logger?: AgentExternalSessionsInvocation['logger'];
}>): Promise<Readonly<{ match?: { snippet: string; sourceItemId: string; messageIndex: number }; partial: boolean; title?: string; cwd?: string; messageCount?: number }>> {
    const sourceSize = params.progress?.sourceSize ?? await readClaudeJsonlFileSize(params.filePath, params.signal);
    const evidence = await readSourceAnchorEvidence(params.filePath, sourceSize, params.signal);
    if (!evidence) throw new ClaudeCandidateSourceChangedError('external_sessions_source_identity_unavailable');
    const sourceIdentity = `${evidence.sourceGeneration}:${evidence.sourceAnchorSha256}`;
    if (params.progress && params.progress.fileRelPath !== params.fileRelPath) {
        throw new ClaudeCandidateSourceChangedError('external_sessions_path_authority');
    }
    if (params.progress && params.progress.sourceIdentity !== sourceIdentity) {
        throw new ClaudeCandidateSourceChangedError('external_sessions_source_identity_changed');
    }
    let progress: ClaudeContentSearchProgress = params.progress ?? {
        fileRelPath: params.fileRelPath, sourceIdentity, sourceSize, endOffsetBytes: sourceSize,
        branchParentUuid: false, count: 0, partial: false,
        title: { customTitle: null, aiTitle: null, fallbackTitle: null },
    };
    const remoteSessionId = params.fileRelPath.split('/').at(-1)!.slice(0, -'.jsonl'.length);
    let cwd: string | undefined;
    const startedAt = performance.now();
    let admissionMode = 'exact';
    let fallbackReason = params.progress ? 'exact_resume' : 'prefilter_unavailable';
    let rowsDecoded = 0;
    let rowsSkipped = 0;
    let skippedRanges = 0;
    let bytesScanned = 0;
    let diagnostics = 0;
    let unsupportedRows = 0;
    let yielded = false;
    const linePatterns = claudeContentSearchLinePatterns(params.query,
        text => findExternalSessionContentMatchRange(text, params.query) ? text : null);
    // JSONL rows are indivisible continuation units. Cancellation reaches every
    // native read; cooperative time is checked after a decoded row is retained.
    try {
        const result = await searchExternalSessionContent({
            query: params.query, ...(params.progress || params.prefiltered || linePatterns === null ? {} : { paths: [params.filePath] }), ripgrep: params.ripgrep, control: params.control,
            isScanComplete: () => progress.endOffsetBytes === 0,
            decode: async (matchText) => {
                if (linePatterns === null) fallbackReason = 'generated_text_query';
                let offsets: readonly number[] | null = params.candidateByteOffsets ?? null;
                if (offsets !== null && params.prefilterMetadata) {
                    const current = await stat(params.filePath, { bigint: true });
                    // Positions are advisory. A native write during the batched
                    // rg read falls back to the original exact scan, under the
                    // same captured-prefix identity and final revalidation.
                    if ((['dev', 'ino', 'birthtimeNs', 'size', 'mtimeNs', 'ctimeNs'] as const)
                        .some(key => current[key] !== params.prefilterMetadata![key])) {
                        offsets = null;
                        fallbackReason = 'source_changed_after_prefilter';
                    }
                }
                const resumedCandidates = progress.candidateEndOffsetBytes !== undefined;
                // Capture source identity before asking rg for byte positions.
                // Final evidence rejects replacement/rewrite during either pass.
                if (resumedCandidates && linePatterns !== null && params.ripgrep) {
                    const filtered = await prefilterExternalSessionContentPaths({ query: params.query,
                        paths: [params.filePath], ripgrep: params.ripgrep!, signal: params.signal,
                        logger: params.logger,
                        lineOffsets: true, additionalLinePatterns: linePatterns });
                    offsets = filtered?.get(params.filePath) ?? (filtered === null ? null : []);
                }
                if (linePatterns !== null && offsets !== null && (!params.progress || resumedCandidates)) {
                    admissionMode = 'line_offsets';
                    fallbackReason = 'none';
                    const candidateOffsets = offsets;
                    let offsetIndex = candidateOffsets.length - 1;
                    progress = { ...progress, candidateEndOffsetBytes: progress.candidateEndOffsetBytes ?? sourceSize };
                    // The scanner already unwinds descriptor custody on callback
                    // interruption. Stop this phase as soon as exact scanning is
                    // required, rather than reading the whole body twice.
                    const candidateFound = new Error('Decoded candidate requires exact scanning');
                    try { await params.control.prepare(async () => {
                        const end = progress.candidateEndOffsetBytes!;
                        if (end === 0 || progress.candidateMatched) return true;
                        const consumed = (start: number, _end: number, tail: number | null) => {
                            progress = { ...progress, candidateEndOffsetBytes: start,
                                partial: progress.partial || (tail !== null && tail < end) };
                            if (start === 0) params.control.assertNotYielded();
                            else params.control.checkWork();
                        };
                        const page = await readJsonlFileBackwardPage({ filePath: params.filePath, endOffsetBytes: end,
                            maxBytes: params.maxBytes, maxItems: Math.max(1, params.maxBytes), signal: params.signal,
                            includeMalformedRecords: true,
                            candidateByteOffsets: candidateOffsets,
                            shouldParseLine: (start, lineEnd) => {
                                while (offsetIndex >= 0 && candidateOffsets[offsetIndex]! >= lineEnd) offsetIndex--;
                                return offsetIndex >= 0 && candidateOffsets[offsetIndex]! >= start;
                            },
                            onSkippedLine: (start, end, tail) => {
                                rowsSkipped++;
                                bytesScanned += end - start;
                                consumed(start, end, tail);
                            },
                            onSkippedRange: (start, end, tail) => {
                                if (end > start) skippedRanges++;
                                bytesScanned += end - start;
                                consumed(start, end, tail);
                            },
                            onDiagnostic: () => { diagnostics++; progress = { ...progress, partial: true }; },
                            onLine: (line, tail) => {
                                rowsDecoded++;
                                bytesScanned += line.endOffsetBytes - line.startOffsetBytes;
                                const projected = projectClaudeJsonlLineRecord({ fileRelPath: params.fileRelPath,
                                    lineStartOffsetBytes: line.startOffsetBytes, lineValue: line.value,
                                    projection: 'content_search', matchText });
                                if (projected.disposition === 'unsupported') unsupportedRows++;
                                // An admitted unsupported row is a coverage gap;
                                // only decoded text justifies the full branch,
                                // title and ordinal scan.
                                progress = { ...progress, candidateMatched: progress.candidateMatched
                                    || projected.match !== null,
                                    partial: progress.partial || projected.disposition === 'unsupported' };
                                consumed(line.startOffsetBytes, line.endOffsetBytes, tail);
                                if (progress.candidateMatched) throw candidateFound;
                            },
                        });
                        progress = { ...progress, candidateEndOffsetBytes: page.nextEndOffsetBytes,
                            partial: progress.partial || Boolean(page.diagnostics?.length)
                                || (page.tailOffsetBytes !== null && page.tailOffsetBytes < end) };
                        return page.reachedStart;
                    }); } catch (error) {
                        if (error !== candidateFound) throw error;
                    }
                    if (!progress.candidateMatched) {
                        progress = { ...progress, endOffsetBytes: 0 };
                        return { records: [], partial: progress.partial };
                    }
                    // Only decoded text can justify branch/title/ordinal work.
                    // The original scan remains the single authority for them.
                    const { candidateEndOffsetBytes: _end, candidateMatched: _matched, ...selected } = progress;
                    progress = selected;
                    admissionMode = 'line_then_exact';
                    fallbackReason = 'decoded_candidate_match';
                }
                await params.control.prepare(async () => {
                    if (progress.endOffsetBytes === 0) return true;
                    throwIfAborted(params.signal);
                    const initialEndOffsetBytes = progress.endOffsetBytes;
                    const page = await readJsonlFileBackwardPage({ filePath: params.filePath, endOffsetBytes: progress.endOffsetBytes,
                        maxBytes: params.maxBytes, maxItems: Math.max(1, params.maxBytes), signal: params.signal, includeMalformedRecords: true,
                        onDiagnostic: () => { diagnostics++; progress = { ...progress, partial: true }; },
                        onLine: (line, tailOffsetBytes) => {
                            rowsDecoded++;
                            bytesScanned += line.endOffsetBytes - line.startOffsetBytes;
                            throwIfAborted(params.signal);
                            if (isTranscriptObject(line.value) && typeof line.value.cwd === 'string' && line.value.cwd.trim()) cwd = line.value.cwd;
                            const selected = selectClaudeExternalBranchLine(line.value, progress.branchParentUuid === false ? undefined : progress.branchParentUuid);
                            let count = progress.count;
                            let match = progress.match;
                            let partial = progress.partial || (tailOffsetBytes !== null && tailOffsetBytes < initialEndOffsetBytes);
                            if (selected.selected) {
                                const projected = projectClaudeJsonlLineRecord({ fileRelPath: params.fileRelPath,
                                    lineStartOffsetBytes: line.startOffsetBytes, lineValue: line.value,
                                    projection: 'content_search', matchText });
                                if (projected.disposition === 'unsupported') unsupportedRows++;
                                partial ||= projected.disposition === 'unsupported';
                                if (projected.match !== null) match = { startOffsetBytes: line.startOffsetBytes,
                                    endOffsetBytes: line.endOffsetBytes, itemIndex: projected.match.itemIndex,
                                    newerItems: count + projected.itemCount - projected.match.itemIndex - 1 };
                                count += projected.itemCount;
                            }
                            const row = { startOffsetBytes: line.startOffsetBytes, endOffsetBytes: line.endOffsetBytes };
                            const titleRecord = applyClaudeTitleRecord({ customTitle: null, aiTitle: null, fallbackTitle: null }, line.value, remoteSessionId, 'backward');
                            const title = { ...progress.title };
                            if (titleRecord.customTitleSeen && !title.customTitleSeen) {
                                title.customTitleSeen = true;
                                title.customTitle = titleRecord.customTitle === null ? null : row;
                            }
                            if (titleRecord.aiTitleSeen && !title.aiTitleSeen) {
                                title.aiTitleSeen = true;
                                title.aiTitle = titleRecord.aiTitle === null ? null : row;
                            }
                            if (titleRecord.fallbackTitle !== null) title.fallbackTitle = row;
                            progress = { ...progress, endOffsetBytes: line.startOffsetBytes,
                                branchParentUuid: selected.parentUuid === undefined ? false : selected.parentUuid,
                                count, partial, title,
                                ...(match ? { match } : {}) };
                            if (progress.endOffsetBytes === 0) params.control.assertNotYielded();
                            else params.control.checkWork();
                        },
                    });
                    throwIfAborted(params.signal);
                    params.control.assertNotYielded();
                    if (!page.reachedStart && page.nextEndOffsetBytes >= initialEndOffsetBytes) {
                        progress = { ...progress, partial: true };
                        return true;
                    }
                    progress = { ...progress, endOffsetBytes: page.nextEndOffsetBytes,
                        partial: progress.partial || Boolean(page.diagnostics?.length)
                            || (page.tailOffsetBytes !== null && page.tailOffsetBytes < initialEndOffsetBytes) };
                    return page.reachedStart;
                });
                // A caller's opaque continuation carries positions, never
                // authoritative text. Re-read and re-match the native row.
                const line = progress.match ? await readSearchRow(progress.match) : null;
                const matched = line && progress.match ? projectClaudeJsonlLineRecord({ fileRelPath: params.fileRelPath,
                    lineStartOffsetBytes: line.startOffsetBytes, lineValue: line.value,
                    projection: 'content_search', matchText }).match : null;
                return { records: matched && progress.match && matched.itemIndex === progress.match.itemIndex ? [{ id: matched.sourceItemId, snippet: matched.snippet,
                    messageIndex: progress.count - progress.match.newerItems - 1 }] : [],
                    partial: progress.partial || typeof progress.branchParentUuid === 'string' };
            },
        });
        const titleRow = progress.title.customTitle ?? progress.title.aiTitle ?? progress.title.fallbackTitle;
        const titleLine = result.match && titleRow ? await readSearchRow(titleRow) : null;
        const title = titleLine ? resolveClaudeTitle(applyClaudeTitleRecord({ customTitle: null, aiTitle: null, fallbackTitle: null }, titleLine.value, remoteSessionId)) : null;
        // The page reads the captured prefix. Native writers may append after
        // it; the existing transcript anchor rejects replacement and anchor changes
        // without making an unrelated new tail invalidate a search page.
        const after = await readSourceAnchorEvidence(params.filePath, sourceSize, params.signal);
        if (!after || `${after.sourceGeneration}:${after.sourceAnchorSha256}` !== sourceIdentity) {
            throw new ClaudeCandidateSourceChangedError('external_sessions_source_identity_changed');
        }
        throwIfAborted(params.signal);
        return { ...result, ...(title ? { title } : {}), ...(cwd ? { cwd } : {}),
            ...(!result.partial ? { messageCount: progress.count } : {}) };
    } catch (error) {
        if (error instanceof ExternalSessionContentSearchYield) { yielded = true; throw new ClaudeContentSearchYield(progress); }
        throw error;
    } finally {
        params.logger?.debug('claude.content_search.file', {
            file: basename(params.filePath), sourceBytes: sourceSize, admissionMode, fallbackReason,
            candidateOffsets: params.candidateByteOffsets?.length ?? null,
            rowsDecoded, rowsSkipped: skippedRanges ? null : rowsSkipped, skippedRanges,
            bytesScanned, diagnostics, unsupportedRows, partial: progress.partial,
            unresolvedAncestry: typeof progress.branchParentUuid === 'string', yielded,
            elapsedMs: Math.round(performance.now() - startedAt),
        });
    }

    async function readSearchRow(row: z.infer<typeof ClaudeContentSearchRowSchema>) {
        throwIfAborted(params.signal);
        const page = await readJsonlFileForward({ filePath: params.filePath, offsetBytes: row.startOffsetBytes,
            maxBytes: Math.max(1, row.endOffsetBytes - row.startOffsetBytes + 1), maxItems: 1, signal: params.signal });
        throwIfAborted(params.signal);
        const line = page.items[0];
        return line?.startOffsetBytes === row.startOffsetBytes ? line : null;
    }
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
    unsupportedRecordCount: number;
}> {
    const items: ClaudeSourceItem[] = [];
    let unsupportedRecordCount = 0;
    for (const line of params.lines) {
        if (items.length >= params.maxItems) break;
        const projected = projectForwardLine({
            fileRelPath: params.fileRelPath,
            lineStartOffsetBytes: line.startOffsetBytes,
            lineValue: line.value,
            maxItems: params.maxItems - items.length,
        }, params.projection, undefined, true);
        if (projected.disposition === 'unsupported') unsupportedRecordCount += 1;
        for (const item of projected.items) {
            if (items.length >= params.maxItems) break;
            items.push(item);
        }
    }
    return { items, unsupportedRecordCount };
}

function unsupportedRecordDiagnostics(count: number) {
    return count > 0 ? { diagnostics: [{ code: 'external_sessions_transcript_unsupported_record',
        severity: 'benign', count, positions: [] }] satisfies AgentExternalSessionsReadAfterDiagnostic[] } : {};
}

function transcriptDiscontinuity(reason: 'source_identity_changed' | 'source_identity_unavailable' | 'path_authority' | 'frontier_anchor' | 'transcript_record_limit') {
    return { truncated: true as const, diagnostics: [{ code: `external_sessions_${reason}`,
        severity: 'required', count: 1, positions: [] }] satisfies AgentExternalSessionsReadAfterDiagnostic[] };
}

export async function pageClaudeExternalSessionTranscript(params: Readonly<{
    source: ClaudeExternalSessionSource;
    env: NodeJS.ProcessEnv;
    providerSessionId: string;
    direction: 'older' | 'newer';
    projection?: 'terminal';
    includeMediaReferences?: boolean;
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
    diagnostics?: readonly AgentExternalSessionsReadAfterDiagnostic[];
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
            includeMediaReferences: params.includeMediaReferences,
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
            ...(truncated ? transcriptDiscontinuity(forward.readAfterOutcome === 'source_replaced'
                ? 'source_identity_changed' : forward.readAfterOutcome === 'gap_or_cursor_expired'
                    ? 'frontier_anchor' : forward.readAfterOutcome === 'source_unavailable'
                        ? 'source_identity_unavailable' : 'transcript_record_limit') : unsupportedRecordDiagnostics(
                            forward.diagnostics?.filter(diagnostic => diagnostic.code === 'unsupported_record_skipped')
                                .reduce((count, diagnostic) => count + diagnostic.count, 0) ?? 0)),
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
            return { items: [], nextCursor: null, tailCursor: await readTailCursor(tailParams), hasMore: false,
                ...transcriptDiscontinuity('source_identity_changed') };
        }
    }
    const endOffsetBytes = cursorMismatch || !decoded
        ? fileSize
        : Math.min(fileSize, Math.max(0, decoded.endOffsetBytes));
    if (endOffsetBytes <= 0) {
        return { items: [], nextCursor: null, tailCursor: await readTailCursor(tailParams), hasMore: false,
            ...(cursorMismatch ? transcriptDiscontinuity('path_authority') : {}) };
    }
    const sourceGeneration = await readSourceGeneration(resolved.filePath, params.signal);
    if (!sourceGeneration) {
        return { items: [], nextCursor: null, tailCursor: await readTailCursor(tailParams), hasMore: false,
            ...transcriptDiscontinuity('source_identity_unavailable') };
    }

    // Carry one pending native parent, never a body cache or retained-row set.
    let branchParentUuid = decoded?.v === 3 && decoded.branchParentUuid !== false ? decoded.branchParentUuid : undefined;
    const page = await readJsonlFileBackwardPage({
        filePath: resolved.filePath,
        endOffsetBytes,
        maxBytes: params.maxBytes,
        maxItems: params.maxItems,
        includeMalformedRecords: true,
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
    if (!page.reachedStart && page.nextEndOffsetBytes >= endOffsetBytes) {
        // A native row exceeded the scanner's existing byte boundary. Refuse
        // this history explicitly rather than minting a cursor inside it or
        // repeatedly reading the same row as if a continuation were possible.
        return { items: [], nextCursor: null, tailCursor, hasMore: false, ...transcriptDiscontinuity('transcript_record_limit') };
    }
    const maxItems = Math.max(1, Math.trunc(params.maxItems));
    if (params.resultBudget || params.projection === 'terminal') {
        const items: ClaudeSourceItem[] = [];
        let nextEndOffsetBytes = page.items.length === 0
            ? page.nextEndOffsetBytes
            : endOffsetBytes;
        let stoppedBeforeOlderLine = false;
        // Represent unsupported rows within the same budget as ordinary rows.
        // A refused row stays behind nextCursor rather than becoming a loss.
        let unsupportedRecordCount = 0;

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
            }, params.projection, selection.selected, params.includeMediaReferences);
            const mapped = projected.items;
            if (items.length + mapped.length > maxItems) {
                if (items.length === 0) throw new ClaudeTranscriptResultBudgetTooSmallError('transcript_item_count_budget');
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
                ...(cursorMismatch ? { truncated: true } : unsupportedRecordDiagnostics(
                    unsupportedRecordCount + (projected.disposition === 'unsupported' ? 1 : 0))),
            };
            if (params.resultBudget && !params.resultBudget.fits(proposed)) {
                if (items.length === 0) {
                    throw new ClaudeTranscriptResultBudgetTooSmallError(
                        'transcript_item_byte_budget',
                    );
                }
                stoppedBeforeOlderLine = true;
                break;
            }
            items.splice(0, items.length, ...proposedItems);
            nextEndOffsetBytes = proposedNextEndOffsetBytes;
            branchParentUuid = selection.parentUuid;
            if (projected.disposition === 'unsupported') unsupportedRecordCount += 1;
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
            return { items, nextCursor: null, tailCursor, hasMore: false, ...transcriptDiscontinuity('source_identity_unavailable') };
        }
        const result = {
            items,
            nextCursor,
            tailCursor,
            hasMore,
            ...(cursorMismatch ? transcriptDiscontinuity('path_authority') : unsupportedRecordDiagnostics(unsupportedRecordCount)),
        };
        if (params.resultBudget && !params.resultBudget.fits(result)) {
            throw new ClaudeTranscriptResultBudgetTooSmallError(
                'transcript_page_byte_budget',
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
    const { items, unsupportedRecordCount } = projectLines({
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
        return { items, nextCursor: null, tailCursor, hasMore: false, ...transcriptDiscontinuity('source_identity_unavailable') };
    }
    return {
        items,
        nextCursor,
        tailCursor,
        hasMore,
        ...(cursorMismatch ? transcriptDiscontinuity('path_authority') : unsupportedRecordDiagnostics(unsupportedRecordCount)),
    };
}

export async function readAfterClaudeExternalSessionTranscript(params: Readonly<{
    source: ClaudeExternalSessionSource;
    env: NodeJS.ProcessEnv;
    providerSessionId: string;
    cursor: string;
    projection?: 'terminal';
    includeMediaReferences?: boolean;
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
        includeMalformedRecords: true,
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

    // The forward read and cursor validation already establish an unchanged or
    // incomplete tail. It needs no historical branch walk. For new records,
    // walk from the current leaf only as far as this page and retain no prefix
    // decisions: already acknowledged ancestors cannot change its selection.
    const branch = params.projection === 'terminal' || read.items.length === 0 ? { offsets: null, partial: false }
        : await readClaudeExternalTranscriptBranch({ filePath: resolved.filePath, maxBytes: params.maxBytes, signal: params.signal,
            range: { startOffsetBytes: read.items[0]!.startOffsetBytes, endOffsetBytes: read.nextOffsetBytes } });
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
            }, params.projection, branch.offsets, false, params.includeMediaReferences);
            const mapped = projected.items;
            if (items.length + mapped.length > maxItems) {
                if (items.length === 0) {
                    throw new ClaudeTranscriptResultBudgetTooSmallError(
                        'transcript_item_count_budget',
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
                        'transcript_item_byte_budget',
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
                    severity: 'benign' as const,
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
                'transcript_page_byte_budget',
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
                severity: 'benign' as const,
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

/** Reopen only a fact already accepted by the ordered Session importer. */
export async function materializeClaudeExternalSessionTranscriptMedia(params: Readonly<{
    source: ClaudeExternalSessionSource;
    env: NodeJS.ProcessEnv;
    providerSessionId: string;
    itemId: string;
    sourceMessageId: string;
    toolCallId: string;
    cursor: string;
    maxBytes: number;
    media: Pick<SessionMediaService, 'publishToolResultMedia'>;
    signal?: AbortSignal;
}>): Promise<void> {
    throwIfAborted(params.signal);
    const cursor = decodeForwardCursor(params.cursor) ?? decodeBackwardCursor(params.cursor);
    const offsetBytes = readClaudeJsonlToolResultItemOffset(params.itemId);
    if (!cursor || cursor.v !== 3 || offsetBytes === null) {
        throw new ClaudeTranscriptInvalidCursorError('Claude media source fact is not pinned.');
    }
    const resolved = await resolveClaudeJsonlSessionFile({ source: params.source, env: params.env,
        remoteSessionId: params.providerSessionId, signal: params.signal });
    if (!resolved || resolved.fileRelPath !== cursor.fileRelPath) {
        throw new ClaudeCandidateSourceChangedError();
    }
    const assertSource = async () => {
        const evidence = await readSourceAnchorEvidence(resolved.filePath, cursor.sourceAnchorOffsetBytes, params.signal);
        if (!evidence || evidence.sourceGeneration !== cursor.sourceGeneration
            || evidence.sourceAnchorSha256 !== cursor.sourceAnchorSha256) {
            throw new ClaudeCandidateSourceChangedError();
        }
    };
    await assertSource();
    const size = await readClaudeJsonlFileSize(resolved.filePath, params.signal);
    if (offsetBytes >= size) throw new ClaudeCandidateSourceChangedError();
    // Reuse the source scanner's existing row budget and stop after one exact row.
    const read = await readJsonlFileForward({ filePath: resolved.filePath, offsetBytes,
        maxBytes: params.maxBytes, maxItems: 1, signal: params.signal });
    const line = read.items[0];
    if (!line || line.startOffsetBytes !== offsetBytes) throw new ClaudeCandidateSourceChangedError();
    const context = { fileRelPath: resolved.fileRelPath, lineStartOffsetBytes: offsetBytes, lineValue: line.value };
    const eligible = projectMediaEligibleLine(context, true).items.some(item => item.id === params.itemId
        && item.toolResultMedia?.sourceMessageId === params.sourceMessageId
        && item.toolResultMedia.toolCallId === params.toolCallId);
    const media = readClaudeToolResultMediaRequests(line.value, context).find(candidate =>
        candidate.request.toolCallId === params.toolCallId
        && candidate.sourceMessageId === params.sourceMessageId);
    if (!eligible || !media) throw new ClaudeCandidateSourceChangedError();
    await assertSource();
    throwIfAborted(params.signal);
    const publish = params.media.publishToolResultMedia;
    if (!publish) throw new Error('external_session_transcript_media_unavailable');
    await publish.call(params.media, media.request, params.signal ? { signal: params.signal } : undefined);
}
