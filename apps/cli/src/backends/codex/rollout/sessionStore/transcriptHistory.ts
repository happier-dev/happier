import { stat } from 'node:fs/promises';

import { createSessionStateSyncEngine } from '@happier-dev/agents';
import type { ExternalSessionsSource, ExternalSessionTranscriptRawMessageV1 } from '@happier-dev/protocol';

import { readJsonlFileForward } from '../../../../api/session/fileBackedTranscripts/jsonl/readJsonlForward';
import { readJsonlFileForwardLines } from '../../../../api/session/fileBackedTranscripts/jsonl/readJsonlForwardLines';
import { readJsonlFileBackwardPage } from '../../../../api/session/fileBackedTranscripts/jsonl/pageJsonlBackward';

import {
    decodeCodexExternalForwardCursor,
    encodeCodexExternalForwardCursor,
    mapCodexExternalSessionAppServerPreviewToMessage,
    type CodexExternalForwardCursor,
} from '@happier-dev/plugins-codex/agent/surfaces/sessions/external/transcript';
import { resolveCodexExternalSessionAppServerMetadata } from '../resolveCodexExternalSessionAppServerMetadata';
import { CODEX_SESSION_STATE_CAPABILITIES, codexSessionStateFacet } from '../../sessionState';
import { homeEntries as resolveHomeEntries } from '@happier-dev/plugins-codex/agent/rollout/discovery/homeEntries';
import { createCodexRolloutSemanticTracker } from '@happier-dev/plugins-codex/agent/rollout/semanticTracker';
import { mapCodexRolloutLineToExternalMessages } from '@happier-dev/plugins-codex/agent/rollout/projection/transcript';
import {
  collectCodexSessionRolloutFiles,
  type CodexRolloutFile,
} from '@happier-dev/plugins-codex/agent/rollout/discovery/sessionsForHome';
import { mapCodexRolloutEventToActions } from '@happier-dev/plugins-codex/agent/rollout/projection/actions';

type CodexBackwardMergedCursorV2 = Readonly<{
    v: 2;
    kind: 'codexBackwardMerged';
    endIndex: number;
}>;

type CodexBackwardMergedCursorV3 = Readonly<{
    v: 3;
    kind: 'codexBackwardMerged';
    beforeId: string | null;
}>;

type CodexBackwardStreamVectorCursorV4 = Readonly<{
    v: 4;
    kind: 'codexBackwardStreamVector';
    streams: readonly Readonly<{
        fileRelPath: string;
        endOffsetBytes: number;
    }>[];
}>;

type CodexBackwardCursor = CodexBackwardMergedCursorV2 | CodexBackwardMergedCursorV3 | CodexBackwardStreamVectorCursorV4;

type CodexExternalTranscriptRolloutStream = CodexRolloutFile & Readonly<{
    threadId: string;
    sidechainId: string | null;
}>;

type CodexRolloutStreamVectorEntry = Readonly<{
    fileRelPath: string;
    nextOffsetBytes: number;
    subIndex: number;
}>;

type CodexProjectedTranscriptRecord = Readonly<{
    item: ExternalSessionTranscriptRawMessageV1;
    streamId: string;
    lineStartOffsetBytes: number;
    lineEndOffsetBytes: number;
    subIndex: number;
    lineRecordCount: number;
}>;

type CodexRolloutReadProgressEntry = Readonly<{
    nextOffsetBytes: number;
    subIndex: number;
}>;

type CodexRolloutExternalTranscriptStreamState = Readonly<{
    stream: CodexExternalTranscriptRolloutStream;
    nextOffsetBytes: number;
    fileSizeBytes: number;
    records: readonly CodexProjectedTranscriptRecord[];
    discoveredChildThreadIds: readonly string[];
    completedChildThreadIds: readonly string[];
    sessionMetaCwd: string | null;
    sessionMetaTimestampMs: number | null;
    semanticTracker: ReturnType<typeof createCodexRolloutSemanticTracker>;
}>;

type CodexRolloutExternalTranscriptSnapshot = Readonly<{
    remoteSessionId: string;
    mergedRecords: readonly CodexProjectedTranscriptRecord[];
    rolloutHome: string | null;
    rolloutSource: ExternalSessionsSource | null;
    rolloutSignature: string | null;
    appServerMetadata: Awaited<ReturnType<typeof resolveCodexExternalSessionAppServerMetadata>> | null;
    title: string | null;
    workingDirectory: string | null;
    lastActivityAtMs: number | null;
    createdAtMs: number | null;
    primaryRolloutFilePath: string | null;
    streamStates: readonly CodexRolloutExternalTranscriptStreamState[];
}>;

type CodexRolloutExternalTranscriptSnapshotOptions = Readonly<{
    allowRolloutCwdAppServerFallback: boolean;
    resolveTitle: boolean;
}>;

type CodexResolvedStreamState = Readonly<{
    state: CodexRolloutExternalTranscriptStreamState;
    appendedRecords: readonly CodexProjectedTranscriptRecord[];
    replacedExistingRecords: boolean;
}>;

export type CodexRolloutExternalSessionTranscriptPageParams = Readonly<{
    direction: 'older' | 'newer';
    cursor?: string;
    maxBytes: number;
    maxItems: number;
    allowProviderFallback?: boolean;
}>;

export type CodexRolloutExternalSessionTranscriptPageResult = Readonly<{
    items: ExternalSessionTranscriptRawMessageV1[];
    nextCursor: string | null;
    tailCursor: string | null;
    hasMore: boolean;
    truncated: boolean;
}>;

export type CodexRolloutExternalSessionTranscriptReadAfterParams = Readonly<{
    cursor: string;
    maxBytes: number;
    maxItems: number;
    allowProviderFallback?: boolean;
}>;

export type CodexRolloutExternalSessionTranscriptReadAfterResult = Readonly<{
    items: ExternalSessionTranscriptRawMessageV1[];
    nextCursor: string | null;
    truncated: boolean;
}>;

function encodeBackwardCursor(value: CodexBackwardCursor): string {
    return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decodeBackwardCursor(raw: string | undefined): CodexBackwardCursor | null {
    if (typeof raw !== 'string' || raw.trim().length === 0) return null;
    try {
        const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown;
        if (!parsed || typeof parsed !== 'object') return null;
        const record = parsed as Record<string, unknown>;
        if (record.v === 2 && record.kind === 'codexBackwardMerged') {
            const endIndex =
                typeof record.endIndex === 'number' && Number.isFinite(record.endIndex)
                    ? Math.trunc(record.endIndex)
                    : NaN;
            if (!Number.isFinite(endIndex) || endIndex < 0) return null;
            return { v: 2, kind: 'codexBackwardMerged', endIndex };
        }
        if (record.v === 3 && record.kind === 'codexBackwardMerged') {
            const beforeId = typeof record.beforeId === 'string' && record.beforeId.trim().length > 0
                ? record.beforeId
                : null;
            return { v: 3, kind: 'codexBackwardMerged', beforeId };
        }
        if (record.v === 4 && record.kind === 'codexBackwardStreamVector') {
            const rawStreams = Array.isArray(record.streams) ? record.streams : [];
            const streams = rawStreams
                .map((entry) => {
                    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
                    const streamRecord = entry as Record<string, unknown>;
                    const fileRelPath = typeof streamRecord.fileRelPath === 'string' ? streamRecord.fileRelPath.trim() : '';
                    const endOffsetBytes =
                        typeof streamRecord.endOffsetBytes === 'number' && Number.isFinite(streamRecord.endOffsetBytes)
                            ? Math.trunc(streamRecord.endOffsetBytes)
                            : NaN;
                    if (!fileRelPath || !Number.isFinite(endOffsetBytes) || endOffsetBytes < 0) {
                        return null;
                    }
                    return { fileRelPath, endOffsetBytes };
                })
                .filter((entry): entry is { fileRelPath: string; endOffsetBytes: number } => entry !== null);
            return { v: 4, kind: 'codexBackwardStreamVector', streams };
        }
        return null;
    } catch {
        return null;
    }
}

function measureDirectTranscriptItemBytes(item: ExternalSessionTranscriptRawMessageV1): number {
    return Buffer.byteLength(JSON.stringify(item), 'utf8');
}

function compareDirectTranscriptItemsOldestFirst(left: ExternalSessionTranscriptRawMessageV1, right: ExternalSessionTranscriptRawMessageV1): number {
    if (left.createdAtMs !== right.createdAtMs) return left.createdAtMs - right.createdAtMs;
    return left.id.localeCompare(right.id);
}

function compareProjectedRecordsOldestFirst(left: CodexProjectedTranscriptRecord, right: CodexProjectedTranscriptRecord): number {
    return compareDirectTranscriptItemsOldestFirst(left.item, right.item);
}

function buildAppServerPreviewCursor(metadata: NonNullable<CodexRolloutExternalTranscriptSnapshot['appServerMetadata']>): string {
    return encodeCodexExternalForwardCursor({
        v: 2,
        kind: 'codexForwardAppServer',
        updatedAtMs: metadata.updatedAtMs,
        previewText: metadata.previewText,
    });
}

function buildStreamVectorCursorFromEntries(
    entries: readonly CodexRolloutStreamVectorEntry[],
    allowEmpty: boolean,
): string | null {
    if (!allowEmpty && entries.length === 0) {
        return null;
    }
    const streams = entries
        .map((entry) => ({
            fileRelPath: entry.fileRelPath,
            nextOffsetBytes: entry.nextOffsetBytes,
            subIndex: entry.subIndex,
        }))
        .sort((left, right) => left.fileRelPath.localeCompare(right.fileRelPath));
    return encodeCodexExternalForwardCursor({
        v: 4,
        kind: 'codexForwardStreamVector',
        streams,
    });
}

function buildStreamVectorCursor(
    streamStates: readonly CodexRolloutExternalTranscriptStreamState[],
    allowEmpty: boolean,
): string | null {
    return buildStreamVectorCursorFromEntries(
        streamStates.map((state): CodexRolloutStreamVectorEntry => ({
            fileRelPath: state.stream.fileRelPath,
            nextOffsetBytes: state.nextOffsetBytes,
            subIndex: 0,
        })),
        allowEmpty,
    );
}

async function buildStreamVectorTailCursorFromStreams(
    streams: readonly CodexExternalTranscriptRolloutStream[],
): Promise<string | null> {
    const entries = await Promise.all(
        streams.map(async (stream): Promise<CodexRolloutStreamVectorEntry> => ({
            fileRelPath: stream.fileRelPath,
            nextOffsetBytes: await statFileSize(stream.filePath) ?? 0,
            subIndex: 0,
        })),
    );
    return buildStreamVectorCursorFromEntries(entries, false);
}

function decodeStreamVectorCursor(
    cursor: CodexExternalForwardCursor | null,
): ReadonlyMap<string, CodexRolloutReadProgressEntry> | null {
    if (!cursor || cursor.kind !== 'codexForwardStreamVector') return null;
    return new Map(
        cursor.streams.map((entry) => [
            entry.fileRelPath,
            {
                nextOffsetBytes: Math.max(0, Math.trunc(entry.nextOffsetBytes)),
                subIndex: Math.max(0, Math.trunc(entry.subIndex ?? 0)),
            },
        ]),
    );
}

function buildReadAfterCursorFromProgress(params: Readonly<{
    snapshot: CodexRolloutExternalTranscriptSnapshot;
    progressByStreamId: ReadonlyMap<string, CodexRolloutReadProgressEntry>;
}>): string | null {
    return buildStreamVectorCursorFromEntries(
        params.snapshot.streamStates.map((state): CodexRolloutStreamVectorEntry => {
            const progress = params.progressByStreamId.get(state.stream.fileRelPath);
            return {
                fileRelPath: state.stream.fileRelPath,
                nextOffsetBytes: progress?.nextOffsetBytes ?? 0,
                subIndex: progress?.subIndex ?? 0,
            };
        }),
        true,
    );
}

function normalizeOffsetBytes(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function parseSessionMeta(value: unknown): Readonly<{ cwd: string | null; timestampMs: number | null }> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const envelope = value as Record<string, unknown>;
    if (envelope.type !== 'session_meta') return null;
    const payload =
        envelope.payload && typeof envelope.payload === 'object' && !Array.isArray(envelope.payload)
            ? (envelope.payload as Record<string, unknown>)
            : null;
    if (!payload) return null;
    const cwd = typeof payload.cwd === 'string' && payload.cwd.trim().length > 0 ? payload.cwd.trim() : null;
    const timestampMs = typeof payload.timestamp === 'string'
        ? (() => {
            const parsed = Date.parse(payload.timestamp);
            return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : null;
        })()
        : null;
    return { cwd, timestampMs };
}

function buildInvalidJsonRecord(params: Readonly<{
    stream: CodexExternalTranscriptRolloutStream;
    lineStartOffsetBytes: number;
    lineEndOffsetBytes: number;
    rawLine: string;
}>): CodexProjectedTranscriptRecord {
    const padded = Math.max(0, Math.trunc(params.lineStartOffsetBytes)).toString().padStart(12, '0');
    const stableId = `codex:${params.stream.fileRelPath}:${padded}`;
    return {
        streamId: params.stream.fileRelPath,
        lineStartOffsetBytes: params.lineStartOffsetBytes,
        lineEndOffsetBytes: params.lineEndOffsetBytes,
        subIndex: 0,
        lineRecordCount: 1,
        item: {
            id: stableId,
            localId: stableId,
            createdAtMs: Math.max(0, Math.trunc(params.stream.sortMs)),
            raw: {
                role: 'agent',
                content: {
                    type: 'output',
                    data: {
                        type: 'opaque',
                        reason: 'invalid_json',
                        source: {
                            fileRelPath: params.stream.fileRelPath,
                            lineStartOffsetBytes: params.lineStartOffsetBytes,
                        },
                        original: params.rawLine,
                    },
                },
            },
        },
    };
}

function insertProjectedRecordSorted(records: CodexProjectedTranscriptRecord[], record: CodexProjectedTranscriptRecord): void {
    let low = 0;
    let high = records.length;
    while (low < high) {
        const mid = Math.floor((low + high) / 2);
        const compare = compareProjectedRecordsOldestFirst(records[mid]!, record);
        if (compare <= 0) {
            low = mid + 1;
        } else {
            high = mid;
        }
    }
    records.splice(low, 0, record);
}

async function statFileSize(filePath: string): Promise<number | null> {
    try {
        const fileStats = await stat(filePath);
        return Math.max(0, Math.trunc(fileStats.size));
    } catch {
        return null;
    }
}

async function readCodexStreamRecords(params: Readonly<{
    stream: CodexExternalTranscriptRolloutStream;
    offsetBytes: number;
    semanticTracker: ReturnType<typeof createCodexRolloutSemanticTracker>;
}>): Promise<Readonly<{
    nextOffsetBytes: number;
    fileSizeBytes: number;
    records: readonly CodexProjectedTranscriptRecord[];
    discoveredChildThreadIds: readonly string[];
    completedChildThreadIds: readonly string[];
    sessionMetaCwd: string | null;
    sessionMetaTimestampMs: number | null;
}>> {
    const fileSizeBytes = (await statFileSize(params.stream.filePath)) ?? 0;
    const records: CodexProjectedTranscriptRecord[] = [];
    const discoveredChildThreadIds = new Set<string>();
    const completedChildThreadIds = new Set<string>();
    let nextOffsetBytes = normalizeOffsetBytes(params.offsetBytes);
    let sessionMetaCwd: string | null = null;
    let sessionMetaTimestampMs: number | null = null;

    while (true) {
        const page = await readJsonlFileForwardLines({
            filePath: params.stream.filePath,
            offsetBytes: nextOffsetBytes,
            maxBytes: 1024 * 1024,
            maxItems: 256,
        });
        if (page.truncated) {
            return {
                nextOffsetBytes: 0,
                fileSizeBytes: 0,
                records,
                discoveredChildThreadIds: [...discoveredChildThreadIds],
                completedChildThreadIds: [...completedChildThreadIds],
                sessionMetaCwd,
                sessionMetaTimestampMs,
            };
        }

        for (const line of page.items) {
            if (line.value === null) {
                records.push(buildInvalidJsonRecord({
                    stream: params.stream,
                    lineStartOffsetBytes: line.startOffsetBytes,
                    lineEndOffsetBytes: line.endOffsetBytes,
                    rawLine: line.rawLine,
                }));
                continue;
            }

            const sessionMeta = parseSessionMeta(line.value);
            if (sessionMeta?.cwd) {
                sessionMetaCwd = sessionMeta.cwd;
            }
            if (sessionMeta?.timestampMs != null) {
                sessionMetaTimestampMs = sessionMeta.timestampMs;
            }

            const actions = mapCodexRolloutEventToActions(line.value, { debug: true });
            const normalizedActions = actions.flatMap((action) => params.semanticTracker.consume(action));
            for (const action of normalizedActions) {
                if (action.type === 'subagent-spawn') {
                    discoveredChildThreadIds.add(action.threadId);
                } else if (action.type === 'subagent-complete') {
                    completedChildThreadIds.add(action.threadId);
                }
            }

            const mappedItems = mapCodexRolloutLineToExternalMessages({
                fileRelPath: params.stream.fileRelPath,
                lineStartOffsetBytes: line.startOffsetBytes,
                lineValue: line.value,
                actions: normalizedActions,
                sidechainId: params.stream.sidechainId,
            });
            mappedItems.forEach((item, subIndex) => {
                records.push({
                    item,
                    streamId: params.stream.fileRelPath,
                    lineStartOffsetBytes: line.startOffsetBytes,
                    lineEndOffsetBytes: line.endOffsetBytes,
                    subIndex,
                    lineRecordCount: mappedItems.length,
                });
            });
        }

        nextOffsetBytes = page.nextOffsetBytes;
        if (page.reachedEnd) {
            break;
        }
        if (page.nextOffsetBytes <= params.offsetBytes && page.items.length === 0) {
            break;
        }
    }

    return {
        nextOffsetBytes,
        fileSizeBytes,
        records,
        discoveredChildThreadIds: [...discoveredChildThreadIds],
        completedChildThreadIds: [...completedChildThreadIds],
        sessionMetaCwd,
        sessionMetaTimestampMs,
    };
}

const CHILD_DISCOVERY_MAX_BYTES = 1024 * 1024;
const CHILD_DISCOVERY_MAX_ITEMS = 512;

async function discoverSpawnedThreadIdsFromFilesBounded(files: readonly CodexRolloutFile[]): Promise<readonly string[]> {
    const discovered = new Set<string>();
    const semanticTracker = createCodexRolloutSemanticTracker();
    for (const file of files) {
        let offsetBytes = 0;
        let scannedBytes = 0;
        let scannedItems = 0;
        while (scannedBytes < CHILD_DISCOVERY_MAX_BYTES && scannedItems < CHILD_DISCOVERY_MAX_ITEMS) {
            const page = await readJsonlFileForward({
                filePath: file.filePath,
                offsetBytes,
                maxBytes: Math.min(128 * 1024, CHILD_DISCOVERY_MAX_BYTES - scannedBytes),
                maxItems: Math.min(64, CHILD_DISCOVERY_MAX_ITEMS - scannedItems),
            });
            for (const line of page.items) {
                const normalizedActions = mapCodexRolloutEventToActions(line.value, { debug: true })
                    .flatMap((action) => semanticTracker.consume(action));
                for (const action of normalizedActions) {
                    if (action.type === 'subagent-spawn') {
                        discovered.add(action.threadId);
                    }
                }
            }
            if (page.reachedEnd || page.nextOffsetBytes <= offsetBytes) break;
            scannedBytes += Math.max(0, page.nextOffsetBytes - offsetBytes);
            scannedItems += page.items.length;
            offsetBytes = page.nextOffsetBytes;
        }
    }
    return [...discovered];
}

async function collectCodexExternalTranscriptRolloutStreams(params: Readonly<{
    codexHome: string;
    remoteSessionId: string;
    initialRolloutFiles?: readonly CodexRolloutFile[];
}>): Promise<readonly CodexExternalTranscriptRolloutStream[]> {
    const queue = [{ threadId: params.remoteSessionId, sidechainId: null as string | null }];
    const seenThreadIds = new Set<string>();
    const streams: CodexExternalTranscriptRolloutStream[] = [];

    while (queue.length > 0) {
        const current = queue.shift()!;
        if (seenThreadIds.has(current.threadId)) continue;
        seenThreadIds.add(current.threadId);

        const files = current.threadId === params.remoteSessionId && current.sidechainId === null && params.initialRolloutFiles
            ? [...params.initialRolloutFiles]
            : await collectCodexSessionRolloutFiles({
                codexHome: params.codexHome,
                remoteSessionId: current.threadId,
            });
        if (files.length === 0) continue;

        streams.push(...files.map((file) => ({
            ...file,
            threadId: current.threadId,
            sidechainId: current.sidechainId,
        })));

        const discoveredChildThreadIds = await discoverSpawnedThreadIdsFromFilesBounded(files);
        for (const threadId of discoveredChildThreadIds) {
            if (!seenThreadIds.has(threadId)) {
                queue.push({ threadId, sidechainId: threadId });
            }
        }
    }

    streams.sort((left, right) =>
        left.sortMs - right.sortMs
        || left.mtimeMs - right.mtimeMs
        || left.fileRelPath.localeCompare(right.fileRelPath),
    );
    return streams;
}

function projectCodexRolloutParsedLine(params: Readonly<{
    stream: CodexExternalTranscriptRolloutStream;
    lineStartOffsetBytes: number;
    lineEndOffsetBytes: number;
    lineValue: unknown;
    semanticTracker: ReturnType<typeof createCodexRolloutSemanticTracker>;
}>): Readonly<{
    records: readonly CodexProjectedTranscriptRecord[];
    discoveredChildThreadIds: readonly string[];
    completedChildThreadIds: readonly string[];
}> {
    const actions = mapCodexRolloutEventToActions(params.lineValue, { debug: true });
    const normalizedActions = actions.flatMap((action) => params.semanticTracker.consume(action));
    const discoveredChildThreadIds = normalizedActions
        .filter((action) => action.type === 'subagent-spawn')
        .map((action) => action.threadId);
    const completedChildThreadIds = normalizedActions
        .filter((action) => action.type === 'subagent-complete')
        .map((action) => action.threadId);
    const mappedItems = mapCodexRolloutLineToExternalMessages({
        fileRelPath: params.stream.fileRelPath,
        lineStartOffsetBytes: params.lineStartOffsetBytes,
        lineValue: params.lineValue,
        actions: normalizedActions,
        sidechainId: params.stream.sidechainId,
    });
    return {
        records: mappedItems.map((item, subIndex) => ({
            item,
            streamId: params.stream.fileRelPath,
            lineStartOffsetBytes: params.lineStartOffsetBytes,
            lineEndOffsetBytes: params.lineEndOffsetBytes,
            subIndex,
            lineRecordCount: mappedItems.length,
        })),
        discoveredChildThreadIds,
        completedChildThreadIds,
    };
}

async function resolveStreamState(
    stream: CodexExternalTranscriptRolloutStream,
    previousState: CodexRolloutExternalTranscriptStreamState | null,
): Promise<CodexResolvedStreamState> {
    const currentFileSizeBytes = await statFileSize(stream.filePath);
    if (currentFileSizeBytes == null) {
        if (previousState) {
            return { state: previousState, appendedRecords: [], replacedExistingRecords: false };
        }
        return {
            state: {
                stream,
                nextOffsetBytes: 0,
                fileSizeBytes: 0,
                records: [],
                discoveredChildThreadIds: [],
                completedChildThreadIds: [],
                sessionMetaCwd: null,
                sessionMetaTimestampMs: null,
                semanticTracker: createCodexRolloutSemanticTracker(),
            },
            appendedRecords: [],
            replacedExistingRecords: true,
        };
    }

    const shouldAppend =
        previousState !== null
        && previousState.stream.filePath === stream.filePath
        && currentFileSizeBytes >= previousState.nextOffsetBytes
        && stream.mtimeMs >= previousState.stream.mtimeMs;

    if (!shouldAppend) {
        const semanticTracker = createCodexRolloutSemanticTracker();
        const read = await readCodexStreamRecords({
            stream,
            offsetBytes: 0,
            semanticTracker,
        });
        return {
            state: {
                stream,
                nextOffsetBytes: read.nextOffsetBytes,
                fileSizeBytes: Math.max(currentFileSizeBytes, read.fileSizeBytes),
                records: read.records,
                discoveredChildThreadIds: read.discoveredChildThreadIds,
                completedChildThreadIds: read.completedChildThreadIds,
                sessionMetaCwd: read.sessionMetaCwd,
                sessionMetaTimestampMs: read.sessionMetaTimestampMs,
                semanticTracker,
            },
            appendedRecords: read.records,
            replacedExistingRecords: true,
        };
    }

    if (currentFileSizeBytes === previousState.nextOffsetBytes && stream.mtimeMs === previousState.stream.mtimeMs) {
        return {
            state: {
                ...previousState,
                stream,
                fileSizeBytes: currentFileSizeBytes,
            },
            appendedRecords: [],
            replacedExistingRecords: false,
        };
    }

    const read = await readCodexStreamRecords({
        stream,
        offsetBytes: previousState.nextOffsetBytes,
        semanticTracker: previousState.semanticTracker,
    });
    return {
        state: {
            stream,
            nextOffsetBytes: read.nextOffsetBytes,
            fileSizeBytes: Math.max(currentFileSizeBytes, read.fileSizeBytes),
            records: [...previousState.records, ...read.records],
            discoveredChildThreadIds: Array.from(new Set([
                ...previousState.discoveredChildThreadIds,
                ...read.discoveredChildThreadIds,
            ])),
            completedChildThreadIds: Array.from(new Set([
                ...previousState.completedChildThreadIds,
                ...read.completedChildThreadIds,
            ])),
            sessionMetaCwd: read.sessionMetaCwd ?? previousState.sessionMetaCwd,
            sessionMetaTimestampMs: read.sessionMetaTimestampMs ?? previousState.sessionMetaTimestampMs,
            semanticTracker: previousState.semanticTracker,
        },
        appendedRecords: read.records,
        replacedExistingRecords: false,
    };
}

function buildRolloutSignature(streams: readonly CodexExternalTranscriptRolloutStream[]): string | null {
    if (streams.length === 0) return null;
    return streams
        .map((stream) => `${stream.fileRelPath}:${stream.sortMs}:${stream.mtimeMs}:${stream.threadId}:${stream.sidechainId ?? ''}`)
        .join('|');
}

function selectBestCodexHomeWithFiles<TEntry extends Readonly<{ codexHome: string }>>(
    entries: readonly TEntry[],
    perHomeFiles: readonly (readonly CodexRolloutFile[])[],
): Readonly<{ entry: TEntry; files: readonly CodexRolloutFile[] }> | null {
    let bestEntry: TEntry | null = null;
    let bestFiles: readonly CodexRolloutFile[] = [];
    let bestLatestMtimeMs = -1;
    for (let index = 0; index < entries.length; index += 1) {
        const entry = entries[index]!;
        const files = perHomeFiles[index] ?? [];
        if (files.length === 0) continue;
        const latestMtimeMs = Math.max(...files.map((file) => file.mtimeMs));
        if (latestMtimeMs > bestLatestMtimeMs) {
            bestLatestMtimeMs = latestMtimeMs;
            bestEntry = entry;
            bestFiles = files;
        }
    }
    return bestEntry ? { entry: bestEntry, files: bestFiles } : null;
}

async function collectCodexExternalTranscriptStreamStates(params: Readonly<{
    codexHome: string;
    remoteSessionId: string;
    previousSnapshot?: CodexRolloutExternalTranscriptSnapshot | null;
    initialRolloutFiles?: readonly CodexRolloutFile[];
}>): Promise<readonly CodexResolvedStreamState[]> {
    const previousStateByStreamId = new Map(
        (params.previousSnapshot?.streamStates ?? []).map((state) => [state.stream.fileRelPath, state] as const),
    );
    const queue = [{ threadId: params.remoteSessionId, sidechainId: null as string | null }];
    const seenThreadIds = new Set<string>();
    const resolvedStates = new Map<string, CodexResolvedStreamState>();

    while (queue.length > 0) {
        const current = queue.shift()!;
        if (seenThreadIds.has(current.threadId)) continue;
        seenThreadIds.add(current.threadId);

        const files = current.threadId === params.remoteSessionId && current.sidechainId === null && params.initialRolloutFiles
            ? [...params.initialRolloutFiles]
            : await collectCodexSessionRolloutFiles({
                codexHome: params.codexHome,
                remoteSessionId: current.threadId,
            });
        if (files.length === 0) continue;

        const sortedStreams = files
            .map((file): CodexExternalTranscriptRolloutStream => ({
                ...file,
                threadId: current.threadId,
                sidechainId: current.sidechainId,
            }))
            .sort((left, right) =>
                left.sortMs - right.sortMs
                || left.mtimeMs - right.mtimeMs
                || left.fileRelPath.localeCompare(right.fileRelPath),
            );

        for (const stream of sortedStreams) {
            const resolved = await resolveStreamState(stream, previousStateByStreamId.get(stream.fileRelPath) ?? null);
            resolvedStates.set(stream.fileRelPath, resolved);
            for (const discoveredThreadId of resolved.state.discoveredChildThreadIds) {
                if (!seenThreadIds.has(discoveredThreadId)) {
                    queue.push({ threadId: discoveredThreadId, sidechainId: discoveredThreadId });
                }
            }
        }
    }

    return [...resolvedStates.values()].sort((left, right) =>
        left.state.stream.sortMs - right.state.stream.sortMs
        || left.state.stream.mtimeMs - right.state.stream.mtimeMs
        || left.state.stream.fileRelPath.localeCompare(right.state.stream.fileRelPath),
    );
}

function buildMergedRecords(params: Readonly<{
    previousSnapshot?: CodexRolloutExternalTranscriptSnapshot | null;
    resolvedStates: readonly CodexResolvedStreamState[];
    rolloutHome: string | null;
}>): readonly CodexProjectedTranscriptRecord[] {
    if (
        !params.previousSnapshot
        || params.previousSnapshot.rolloutHome !== params.rolloutHome
    ) {
        const merged: CodexProjectedTranscriptRecord[] = [];
        for (const resolved of params.resolvedStates) {
            resolved.state.records.forEach((record) => insertProjectedRecordSorted(merged, record));
        }
        return merged;
    }

    const replacedStreamIds = new Set<string>();
    const currentStreamIds = new Set(params.resolvedStates.map((resolved) => resolved.state.stream.fileRelPath));
    for (const resolved of params.resolvedStates) {
        if (resolved.replacedExistingRecords) {
            replacedStreamIds.add(resolved.state.stream.fileRelPath);
        }
    }
    for (const state of params.previousSnapshot.streamStates) {
        if (!currentStreamIds.has(state.stream.fileRelPath)) {
            replacedStreamIds.add(state.stream.fileRelPath);
        }
    }

    const merged = params.previousSnapshot.mergedRecords
        .filter((record) => !replacedStreamIds.has(record.streamId))
        .slice();

    for (const resolved of params.resolvedStates) {
        const recordsToInsert = resolved.replacedExistingRecords ? resolved.state.records : resolved.appendedRecords;
        recordsToInsert.forEach((record) => insertProjectedRecordSorted(merged, record));
    }

    return merged;
}

async function resolveSnapshotTitle(
    streamStates: readonly CodexRolloutExternalTranscriptStreamState[],
): Promise<string | null> {
    const primaryRootStream = [...streamStates]
        .filter((state) => state.stream.sidechainId === null)
        .sort((left, right) =>
            resolveRolloutChronologyMs(left.stream) - resolveRolloutChronologyMs(right.stream)
            || left.stream.mtimeMs - right.stream.mtimeMs
            || left.stream.fileRelPath.localeCompare(right.stream.fileRelPath),
    )[0];
    if (!primaryRootStream) return null;
    const result = await createSessionStateSyncEngine({
        capabilities: CODEX_SESSION_STATE_CAPABILITIES,
        facet: codexSessionStateFacet,
    }).readProviderField({
        ctx: {
        sessionId: primaryRootStream.stream.threadId,
        rolloutFilePath: primaryRootStream.stream.filePath,
        },
        fieldId: 'display.title',
    });
    return result.ok ? result.value : null;
}

function resolveSnapshotWorkingDirectory(
    streamStates: readonly CodexRolloutExternalTranscriptStreamState[],
): string | null {
    const rootStates = streamStates.filter((state) => state.stream.sidechainId === null);
    const orderedStates = (rootStates.length > 0 ? rootStates : streamStates)
        .slice()
        .sort((left, right) =>
            resolveRolloutChronologyMs(right.stream) - resolveRolloutChronologyMs(left.stream)
            || right.stream.mtimeMs - left.stream.mtimeMs
            || right.stream.fileRelPath.localeCompare(left.stream.fileRelPath),
        );
    for (const state of orderedStates) {
        if (state.sessionMetaCwd) {
            return state.sessionMetaCwd;
        }
    }
    return null;
}

function resolveSnapshotCreatedAtMs(
    streamStates: readonly CodexRolloutExternalTranscriptStreamState[],
): number | null {
    const rootStates = streamStates.filter((state) => state.stream.sidechainId === null);
    const orderedStates = (rootStates.length > 0 ? rootStates : streamStates)
        .slice()
        .sort((left, right) =>
            resolveRolloutChronologyMs(left.stream) - resolveRolloutChronologyMs(right.stream)
            || left.stream.mtimeMs - right.stream.mtimeMs
            || left.stream.fileRelPath.localeCompare(right.stream.fileRelPath),
        );
    for (const state of orderedStates) {
        if (state.sessionMetaTimestampMs != null) {
            return state.sessionMetaTimestampMs;
        }
    }
    const first = orderedStates[0];
    return first ? Math.max(0, Math.trunc(first.stream.mtimeMs)) : null;
}

function resolveSnapshotActivity(streamStates: readonly CodexRolloutExternalTranscriptStreamState[]): number | null {
    if (streamStates.length === 0) return null;
    return Math.max(...streamStates.map((state) => Math.max(0, Math.trunc(state.stream.mtimeMs))));
}

function resolvePrimaryRolloutFilePath(
    streamStates: readonly CodexRolloutExternalTranscriptStreamState[],
): string | null {
    const rootStates = streamStates.filter((state) => state.stream.sidechainId === null);
    const orderedStates = (rootStates.length > 0 ? rootStates : streamStates)
        .slice()
        .sort((left, right) =>
            resolveRolloutChronologyMs(left.stream) - resolveRolloutChronologyMs(right.stream)
            || left.stream.mtimeMs - right.stream.mtimeMs
            || left.stream.fileRelPath.localeCompare(right.stream.fileRelPath),
        );
    return orderedStates.at(-1)?.stream.filePath ?? null;
}

function resolveRolloutChronologyMs(stream: CodexExternalTranscriptRolloutStream): number {
    const name = stream.filePath.split(/[/\\]/).pop() ?? '';
    const match = /^rollout-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})/.exec(name);
    if (!match) {
        return Math.max(0, Math.trunc(stream.sortMs));
    }
    const isoLike = match[1].replace(/T(\d{2})-(\d{2})-(\d{2})$/, 'T$1:$2:$3');
    const parsed = Date.parse(`${isoLike}Z`);
    return Number.isFinite(parsed) ? Math.trunc(parsed) : Math.max(0, Math.trunc(stream.sortMs));
}

export async function resolveCodexRolloutExternalTranscriptSnapshot(params: Readonly<{
    source: ExternalSessionsSource;
    activeServerDir: string;
    env?: NodeJS.ProcessEnv;
    remoteSessionId: string;
    previousSnapshot?: CodexRolloutExternalTranscriptSnapshot | null;
    options?: Partial<CodexRolloutExternalTranscriptSnapshotOptions>;
}>): Promise<CodexRolloutExternalTranscriptSnapshot> {
    const env = params.env ?? process.env;
    const options: CodexRolloutExternalTranscriptSnapshotOptions = {
        allowRolloutCwdAppServerFallback: params.options?.allowRolloutCwdAppServerFallback !== false,
        resolveTitle: params.options?.resolveTitle !== false,
    };
    const homeEntries = await resolveHomeEntries({
        source: params.source,
        activeServerDir: params.activeServerDir,
        env,
    });
    const perHomeFiles = await Promise.all(
        homeEntries.map((entry) => collectCodexSessionRolloutFiles({ codexHome: entry.codexHome, remoteSessionId: params.remoteSessionId })),
    );
    const bestEntry = selectBestCodexHomeWithFiles(homeEntries, perHomeFiles);

    if (bestEntry === null) {
        if (params.previousSnapshot?.rolloutHome) {
            return params.previousSnapshot;
        }
        const appServerMetadata = options.allowRolloutCwdAppServerFallback
            ? await resolveCodexExternalSessionAppServerMetadata({
                source: params.source,
                activeServerDir: params.activeServerDir,
                remoteSessionId: params.remoteSessionId,
                env,
            })
            : null;
        return {
            remoteSessionId: params.remoteSessionId,
            mergedRecords: [],
            rolloutHome: null,
            rolloutSource: null,
            rolloutSignature: null,
            appServerMetadata,
            title: null,
            workingDirectory: appServerMetadata?.workingDirectory ?? null,
            lastActivityAtMs: appServerMetadata?.updatedAtMs ?? null,
            createdAtMs: null,
            primaryRolloutFilePath: null,
            streamStates: [],
        };
    }

    const resolvedStates = await collectCodexExternalTranscriptStreamStates({
        codexHome: bestEntry.entry.codexHome,
        remoteSessionId: params.remoteSessionId,
        previousSnapshot:
            params.previousSnapshot?.rolloutHome === bestEntry.entry.codexHome
                ? params.previousSnapshot
                : null,
        initialRolloutFiles: bestEntry.files,
    });
    const streamStates = resolvedStates.map((resolved) => resolved.state);
    const rolloutSignature = buildRolloutSignature(streamStates.map((state) => state.stream));
    const previousSnapshotNeedsCwdFallback =
        options.allowRolloutCwdAppServerFallback
        && params.previousSnapshot?.rolloutHome
        && params.previousSnapshot.workingDirectory === null
        && params.previousSnapshot.appServerMetadata === null;
    const previousSnapshotNeedsTitle =
        options.resolveTitle
        && params.previousSnapshot?.rolloutHome
        && params.previousSnapshot.title === null;
    const canReusePreviousSnapshot = !(previousSnapshotNeedsCwdFallback || previousSnapshotNeedsTitle);
    if (
        canReusePreviousSnapshot
        &&
        params.previousSnapshot
        && params.previousSnapshot.rolloutHome === bestEntry.entry.codexHome
        && params.previousSnapshot.rolloutSignature === rolloutSignature
    ) {
        return params.previousSnapshot;
    }

    const mergedRecords = buildMergedRecords({
        previousSnapshot:
            params.previousSnapshot?.rolloutHome === bestEntry.entry.codexHome
                ? params.previousSnapshot
                : null,
        resolvedStates,
        rolloutHome: bestEntry.entry.codexHome,
    });
    const title = options.resolveTitle
        ? await resolveSnapshotTitle(streamStates)
        : params.previousSnapshot?.rolloutHome === bestEntry.entry.codexHome
            ? params.previousSnapshot.title
            : null;
    const workingDirectoryFromRollout = resolveSnapshotWorkingDirectory(streamStates);
    const appServerMetadata = workingDirectoryFromRollout || !options.allowRolloutCwdAppServerFallback
        ? null
        : await resolveCodexExternalSessionAppServerMetadata({
            source: params.source,
            activeServerDir: params.activeServerDir,
            remoteSessionId: params.remoteSessionId,
            env,
        });
    return {
        remoteSessionId: params.remoteSessionId,
        mergedRecords,
        rolloutHome: bestEntry.entry.codexHome,
        rolloutSource: bestEntry.entry.source,
        rolloutSignature,
        appServerMetadata,
        title,
        workingDirectory: workingDirectoryFromRollout ?? appServerMetadata?.workingDirectory ?? null,
        lastActivityAtMs: resolveSnapshotActivity(streamStates),
        createdAtMs: resolveSnapshotCreatedAtMs(streamStates),
        primaryRolloutFilePath: resolvePrimaryRolloutFilePath(streamStates),
        streamStates,
    };
}

export async function pageCodexRolloutExternalTranscriptHistory(params: Readonly<{
    source: ExternalSessionsSource;
    activeServerDir: string;
    env?: NodeJS.ProcessEnv;
    remoteSessionId: string;
} & CodexRolloutExternalSessionTranscriptPageParams>): Promise<CodexRolloutExternalSessionTranscriptPageResult> {
    const env = params.env ?? process.env;
    const allowProviderFallback = params.allowProviderFallback !== false;
    const homeEntries = await resolveHomeEntries({
        source: params.source,
        activeServerDir: params.activeServerDir,
        env,
    });
    const perHomeFiles = await Promise.all(
        homeEntries.map((entry) => collectCodexSessionRolloutFiles({ codexHome: entry.codexHome, remoteSessionId: params.remoteSessionId })),
    );
    const bestEntry = selectBestCodexHomeWithFiles(homeEntries, perHomeFiles);

    if (bestEntry === null) {
        const appServerMetadata = allowProviderFallback
            ? await resolveCodexExternalSessionAppServerMetadata({
                source: params.source,
                activeServerDir: params.activeServerDir,
                remoteSessionId: params.remoteSessionId,
                env,
            })
            : null;
        const previewItem = appServerMetadata
            ? mapCodexExternalSessionAppServerPreviewToMessage({
                remoteSessionId: params.remoteSessionId,
                metadata: appServerMetadata,
            })
            : null;
        return {
            items: previewItem ? [previewItem] : [],
            nextCursor: null,
            tailCursor: appServerMetadata ? buildAppServerPreviewCursor(appServerMetadata) : null,
            hasMore: false,
            truncated: false,
        };
    }

    const streams = await collectCodexExternalTranscriptRolloutStreams({
        codexHome: bestEntry.entry.codexHome,
        remoteSessionId: params.remoteSessionId,
        initialRolloutFiles: bestEntry.files,
    });
    const tailCursor = await buildStreamVectorTailCursorFromStreams(streams);
    if (params.direction !== 'older') {
        return { items: [], nextCursor: null, tailCursor, hasMore: false, truncated: false };
    }

    const decoded = decodeBackwardCursor(params.cursor);
    const endByStreamId = new Map(
        decoded?.kind === 'codexBackwardStreamVector'
            ? decoded.streams.map((entry) => [entry.fileRelPath, entry.endOffsetBytes] as const)
            : [],
    );
    const maxBytes = Math.max(1, Math.trunc(params.maxBytes));
    const maxItems = Math.max(1, Math.trunc(params.maxItems));
    const candidateRecords: CodexProjectedTranscriptRecord[] = [];
    const reachedStartByStreamId = new Map<string, boolean>();
    const initialEndByStreamId = new Map<string, number>();
    const pageNextEndByStreamId = new Map<string, number>();
    const hasLoadedCandidateByStreamId = new Map<string, boolean>();

    for (const stream of streams) {
        const fileSize = await statFileSize(stream.filePath) ?? 0;
        const endOffsetBytes = Math.min(fileSize, Math.max(0, Math.trunc(endByStreamId.get(stream.fileRelPath) ?? fileSize)));
        initialEndByStreamId.set(stream.fileRelPath, endOffsetBytes);
        if (endOffsetBytes <= 0) continue;
        const page = await readJsonlFileBackwardPage({
            filePath: stream.filePath,
            endOffsetBytes,
            maxBytes,
            maxItems: maxItems * 2,
        });
        const pageNextEndOffsetBytes = page.items.length === 0 && !page.reachedStart
            ? Math.max(0, endOffsetBytes - maxBytes)
            : page.nextEndOffsetBytes;
        reachedStartByStreamId.set(stream.fileRelPath, page.reachedStart);
        pageNextEndByStreamId.set(stream.fileRelPath, pageNextEndOffsetBytes);
        const semanticTracker = createCodexRolloutSemanticTracker();
        const forwardWindow = await readJsonlFileForwardLines({
            filePath: stream.filePath,
            offsetBytes: pageNextEndOffsetBytes,
            maxBytes: Math.max(1, endOffsetBytes - pageNextEndOffsetBytes),
            maxItems: Math.max(maxItems * 4, 64),
        });
        for (const line of forwardWindow.items) {
            if (line.startOffsetBytes >= endOffsetBytes) break;
            if (line.value === null) {
                candidateRecords.push(buildInvalidJsonRecord({
                    stream,
                    lineStartOffsetBytes: line.startOffsetBytes,
                    lineEndOffsetBytes: line.endOffsetBytes,
                    rawLine: line.rawLine,
                }));
                hasLoadedCandidateByStreamId.set(stream.fileRelPath, true);
                continue;
            }
            const projected = projectCodexRolloutParsedLine({
                stream,
                lineStartOffsetBytes: line.startOffsetBytes,
                lineEndOffsetBytes: line.endOffsetBytes,
                lineValue: line.value,
                semanticTracker,
            });
            if (projected.records.length > 0) {
                hasLoadedCandidateByStreamId.set(stream.fileRelPath, true);
            }
            candidateRecords.push(...projected.records);
        }
    }

    candidateRecords.sort(compareProjectedRecordsOldestFirst);
    const selectedReversed: CodexProjectedTranscriptRecord[] = [];
    let usedBytes = 0;
    for (let index = candidateRecords.length - 1; index >= 0; index -= 1) {
        const record = candidateRecords[index]!;
        const itemBytes = measureDirectTranscriptItemBytes(record.item);
        if (selectedReversed.length > 0 && (selectedReversed.length >= maxItems || usedBytes + itemBytes > maxBytes)) {
            break;
        }
        selectedReversed.push(record);
        usedBytes += itemBytes;
        if (selectedReversed.length >= maxItems || usedBytes >= maxBytes) {
            break;
        }
    }

    const selected = selectedReversed.reverse();
    const nextEndByStreamId = new Map<string, number>();
    for (const stream of streams) {
        const initialEndOffsetBytes = initialEndByStreamId.get(stream.fileRelPath) ?? 0;
        const pageNextEndOffsetBytes = pageNextEndByStreamId.get(stream.fileRelPath) ?? initialEndOffsetBytes;
        nextEndByStreamId.set(
            stream.fileRelPath,
            hasLoadedCandidateByStreamId.get(stream.fileRelPath) === true
                ? initialEndOffsetBytes
                : pageNextEndOffsetBytes,
        );
    }
    for (const record of selected) {
        const current = nextEndByStreamId.get(record.streamId);
        if (current == null || record.lineStartOffsetBytes < current) {
            nextEndByStreamId.set(record.streamId, record.lineStartOffsetBytes);
        }
    }

    const selectedIds = new Set(selected.map((record) => record.item.id));
    const hasUndeliveredLoadedRecord = candidateRecords.some((record) => !selectedIds.has(record.item.id));
    const mayHaveUndeliveredRecordBeforeLoadedWindow = streams.some((stream) => {
        const endOffsetBytes = nextEndByStreamId.get(stream.fileRelPath) ?? 0;
        return endOffsetBytes > 0 && reachedStartByStreamId.get(stream.fileRelPath) === false;
    });
    const hasMore = hasUndeliveredLoadedRecord || mayHaveUndeliveredRecordBeforeLoadedWindow;
    const nextCursor = hasMore
        ? encodeBackwardCursor({
            v: 4,
            kind: 'codexBackwardStreamVector',
            streams: [...nextEndByStreamId.entries()]
                .map(([fileRelPath, endOffsetBytes]) => ({ fileRelPath, endOffsetBytes }))
                .sort((left, right) => left.fileRelPath.localeCompare(right.fileRelPath)),
        })
        : null;

    return {
        items: selected.map((record) => record.item),
        nextCursor,
        tailCursor,
        hasMore,
        truncated: decoded === null && typeof params.cursor === 'string' && params.cursor.trim().length > 0,
    };
}

export async function readAfterCodexRolloutExternalTranscriptHistory(params: Readonly<{
    source: ExternalSessionsSource;
    activeServerDir: string;
    env?: NodeJS.ProcessEnv;
    remoteSessionId: string;
} & CodexRolloutExternalSessionTranscriptReadAfterParams>): Promise<CodexRolloutExternalSessionTranscriptReadAfterResult> {
    const env = params.env ?? process.env;
    const allowProviderFallback = params.allowProviderFallback !== false;
    const homeEntries = await resolveHomeEntries({
        source: params.source,
        activeServerDir: params.activeServerDir,
        env,
    });
    const perHomeFiles = await Promise.all(
        homeEntries.map((entry) => collectCodexSessionRolloutFiles({ codexHome: entry.codexHome, remoteSessionId: params.remoteSessionId })),
    );
    const bestEntry = selectBestCodexHomeWithFiles(homeEntries, perHomeFiles);

    if (bestEntry === null) {
        const appServerMetadata = allowProviderFallback
            ? await resolveCodexExternalSessionAppServerMetadata({
                source: params.source,
                activeServerDir: params.activeServerDir,
                remoteSessionId: params.remoteSessionId,
                env,
            })
            : null;
        if (params.cursor === 'tail' && appServerMetadata) {
            return { items: [], nextCursor: buildAppServerPreviewCursor(appServerMetadata), truncated: false };
        }

        const decodedEmpty = params.cursor === 'tail' ? null : decodeCodexExternalForwardCursor(params.cursor);
        if (decodedEmpty?.kind === 'codexForwardAppServer') {
            const changed = appServerMetadata
                ? appServerMetadata.updatedAtMs !== decodedEmpty.updatedAtMs || appServerMetadata.previewText !== decodedEmpty.previewText
                : false;
            const previewItem = changed && appServerMetadata
                ? mapCodexExternalSessionAppServerPreviewToMessage({
                    remoteSessionId: params.remoteSessionId,
                    metadata: appServerMetadata,
                })
                : null;
            return {
                items: previewItem ? [previewItem] : [],
                nextCursor: encodeCodexExternalForwardCursor({
                    v: 2,
                    kind: 'codexForwardAppServer',
                    updatedAtMs: appServerMetadata?.updatedAtMs ?? decodedEmpty.updatedAtMs,
                    previewText: appServerMetadata?.previewText ?? decodedEmpty.previewText,
                }),
                truncated: false,
            };
        }

        return { items: [], nextCursor: null, truncated: false };
    }

    const streams = await collectCodexExternalTranscriptRolloutStreams({
        codexHome: bestEntry.entry.codexHome,
        remoteSessionId: params.remoteSessionId,
        initialRolloutFiles: bestEntry.files,
    });
    if (params.cursor === 'tail') {
        return {
            items: [],
            nextCursor: await buildStreamVectorTailCursorFromStreams(streams),
            truncated: false,
        };
    }

    const decoded = decodeCodexExternalForwardCursor(params.cursor);
    const cursorProgressByStreamId = decodeStreamVectorCursor(decoded);
    if (!cursorProgressByStreamId) {
        return {
            items: [],
            nextCursor: await buildStreamVectorTailCursorFromStreams(streams),
            truncated: true,
        };
    }

    const streamsById = new Map(streams.map((stream) => [stream.fileRelPath, stream] as const));
    const streamQueue = [...streams];
    const seenThreadIds = new Set(streams.map((stream) => stream.threadId));
    const records: CodexProjectedTranscriptRecord[] = [];
    const baseProgressByStreamId = new Map(cursorProgressByStreamId);
    const semanticTrackerByStreamId = new Map<string, ReturnType<typeof createCodexRolloutSemanticTracker>>();
    const maxBytes = Math.max(1, Math.trunc(params.maxBytes));
    const maxItems = Math.max(1, Math.trunc(params.maxItems));

    for (let queueIndex = 0; queueIndex < streamQueue.length; queueIndex += 1) {
        const stream = streamQueue[queueIndex]!;
        const fileSize = await statFileSize(stream.filePath) ?? 0;
        const progress = cursorProgressByStreamId.get(stream.fileRelPath) ?? { nextOffsetBytes: 0, subIndex: 0 };
        const offsetBytes = Math.min(fileSize, normalizeOffsetBytes(progress.nextOffsetBytes));
        if (offsetBytes >= fileSize) continue;

        const semanticTracker = semanticTrackerByStreamId.get(stream.fileRelPath) ?? createCodexRolloutSemanticTracker();
        semanticTrackerByStreamId.set(stream.fileRelPath, semanticTracker);
        const page = await readJsonlFileForward({
            filePath: stream.filePath,
            offsetBytes,
            maxBytes,
            maxItems: Math.max(maxItems * 2, 1),
        });

        for (const line of page.items) {
            const projected = projectCodexRolloutParsedLine({
                stream,
                lineStartOffsetBytes: line.startOffsetBytes,
                lineEndOffsetBytes: line.endOffsetBytes,
                lineValue: line.value,
                semanticTracker,
            });
            if (projected.records.length === 0) {
                baseProgressByStreamId.set(stream.fileRelPath, {
                    nextOffsetBytes: line.endOffsetBytes,
                    subIndex: 0,
                });
            }
            for (const record of projected.records) {
                if (record.lineStartOffsetBytes === offsetBytes && record.subIndex < progress.subIndex) continue;
                records.push(record);
            }
            for (const threadId of projected.discoveredChildThreadIds) {
                if (seenThreadIds.has(threadId)) continue;
                seenThreadIds.add(threadId);
                const childFiles = await collectCodexSessionRolloutFiles({ codexHome: bestEntry.entry.codexHome, remoteSessionId: threadId });
                for (const file of childFiles) {
                    const childStream: CodexExternalTranscriptRolloutStream = { ...file, threadId, sidechainId: threadId };
                    if (streamsById.has(childStream.fileRelPath)) continue;
                    streamsById.set(childStream.fileRelPath, childStream);
                    streamQueue.push(childStream);
                }
            }
        }
    }

    records.sort(compareProjectedRecordsOldestFirst);
    const orderedStreams = [...streamsById.values()].sort((left, right) =>
        left.sortMs - right.sortMs
        || left.mtimeMs - right.mtimeMs
        || left.fileRelPath.localeCompare(right.fileRelPath),
    );
    const items: ExternalSessionTranscriptRawMessageV1[] = [];
    let usedBytes = 0;
    let truncated = false;
    const progressByStreamId = new Map(baseProgressByStreamId);

    for (let index = 0; index < records.length; index += 1) {
        const record = records[index]!;
        const itemBytes = measureDirectTranscriptItemBytes(record.item);
        if (items.length > 0 && (items.length >= maxItems || usedBytes + itemBytes > maxBytes)) {
            truncated = true;
            break;
        }
        items.push(record.item);
        usedBytes += itemBytes;
        progressByStreamId.set(
            record.streamId,
            record.subIndex + 1 >= record.lineRecordCount
                ? { nextOffsetBytes: record.lineEndOffsetBytes, subIndex: 0 }
                : { nextOffsetBytes: record.lineStartOffsetBytes, subIndex: record.subIndex + 1 },
        );
        if (items.length >= maxItems || usedBytes >= maxBytes) {
            truncated = index + 1 < records.length;
            break;
        }
    }

    return {
        items,
        nextCursor: buildStreamVectorCursorFromEntries(
            orderedStreams.map((stream): CodexRolloutStreamVectorEntry => {
                const progress = progressByStreamId.get(stream.fileRelPath);
                return {
                    fileRelPath: stream.fileRelPath,
                    nextOffsetBytes: progress?.nextOffsetBytes ?? 0,
                    subIndex: progress?.subIndex ?? 0,
                };
            }),
            true,
        ),
        truncated,
    };
}

export function pageCodexRolloutExternalTranscriptSnapshot(
    snapshot: CodexRolloutExternalTranscriptSnapshot,
    params: CodexRolloutExternalSessionTranscriptPageParams,
): CodexRolloutExternalSessionTranscriptPageResult {
    if (snapshot.rolloutHome === null) {
        const previewItem = snapshot.appServerMetadata
            ? mapCodexExternalSessionAppServerPreviewToMessage({
                remoteSessionId: snapshot.remoteSessionId,
                metadata: snapshot.appServerMetadata,
            })
            : null;
        const tailCursor = snapshot.appServerMetadata ? buildAppServerPreviewCursor(snapshot.appServerMetadata) : null;
        return {
            items: previewItem ? [previewItem] : [],
            nextCursor: null,
            tailCursor,
            hasMore: false,
            truncated: false,
        };
    }

    const tailCursor = buildStreamVectorCursor(snapshot.streamStates, false);
    if (params.direction !== 'older') {
        return { items: [], nextCursor: null, tailCursor, hasMore: false, truncated: false };
    }

    const decoded = decodeBackwardCursor(params.cursor);
    const maxBytes = Math.max(1, Math.trunc(params.maxBytes));
    const maxItems = Math.max(1, Math.trunc(params.maxItems));

    let endIndex = snapshot.mergedRecords.length;
    let truncated = false;
    if (decoded?.v === 2) {
        endIndex = Math.min(Math.max(0, decoded.endIndex), snapshot.mergedRecords.length);
    } else if (decoded?.v === 3 && decoded.beforeId) {
        const foundIndex = snapshot.mergedRecords.findIndex((record) => record.item.id === decoded.beforeId);
        if (foundIndex === -1) {
            truncated = true;
            endIndex = snapshot.mergedRecords.length;
        } else {
            endIndex = foundIndex;
        }
    }

    const selectedReversed: CodexProjectedTranscriptRecord[] = [];
    let usedBytes = 0;
    for (let index = endIndex - 1; index >= 0; index -= 1) {
        const record = snapshot.mergedRecords[index]!;
        const itemBytes = measureDirectTranscriptItemBytes(record.item);
        if (selectedReversed.length > 0 && (selectedReversed.length >= maxItems || usedBytes + itemBytes > maxBytes)) {
            break;
        }
        selectedReversed.push(record);
        usedBytes += itemBytes;
        if (selectedReversed.length >= maxItems || usedBytes >= maxBytes) {
            break;
        }
    }

    const selected = selectedReversed.reverse();
    const items = selected.map((record) => record.item);
    const nextCursor = selected.length > 0 && endIndex - selected.length > 0
        ? encodeBackwardCursor({
            v: 3,
            kind: 'codexBackwardMerged',
            beforeId: selected[0]!.item.id,
        })
        : null;
    return {
        items,
        nextCursor,
        tailCursor,
        hasMore: nextCursor !== null,
        truncated,
    };
}

export function readAfterCodexRolloutExternalTranscriptSnapshot(
    snapshot: CodexRolloutExternalTranscriptSnapshot,
    params: CodexRolloutExternalSessionTranscriptReadAfterParams,
): CodexRolloutExternalSessionTranscriptReadAfterResult {
    if (snapshot.rolloutHome === null) {
        if (params.cursor === 'tail' && snapshot.appServerMetadata) {
            return {
                items: [],
                nextCursor: buildAppServerPreviewCursor(snapshot.appServerMetadata),
                truncated: false,
            };
        }

        const decodedEmpty = params.cursor === 'tail' ? null : decodeCodexExternalForwardCursor(params.cursor);
        if (decodedEmpty?.kind === 'codexForwardAppServer') {
            const previousCursor = encodeCodexExternalForwardCursor(decodedEmpty);
            const nextCursor = snapshot.appServerMetadata ? buildAppServerPreviewCursor(snapshot.appServerMetadata) : previousCursor;
            const changed = snapshot.appServerMetadata ? nextCursor !== previousCursor : false;
            const previewItem = changed && snapshot.appServerMetadata
                ? mapCodexExternalSessionAppServerPreviewToMessage({
                    remoteSessionId: snapshot.remoteSessionId,
                    metadata: snapshot.appServerMetadata,
                })
                : null;
            return { items: previewItem ? [previewItem] : [], nextCursor, truncated: false };
        }

        return { items: [], nextCursor: null, truncated: false };
    }

    if (params.cursor === 'tail') {
        return {
            items: [],
            nextCursor: buildStreamVectorCursor(snapshot.streamStates, true),
            truncated: false,
        };
    }

    const decoded = decodeCodexExternalForwardCursor(params.cursor);
    const cursorOffsets = decodeStreamVectorCursor(decoded);
    if (!cursorOffsets) {
        return {
            items: [],
            nextCursor: buildStreamVectorCursor(snapshot.streamStates, true),
            truncated: true,
        };
    }

    for (const [streamId, offsetBytes] of cursorOffsets.entries()) {
        const state = snapshot.streamStates.find((candidate) => candidate.stream.fileRelPath === streamId);
        if (state && state.nextOffsetBytes < offsetBytes.nextOffsetBytes) {
            return {
                items: [],
                nextCursor: buildStreamVectorCursor(snapshot.streamStates, true),
                truncated: true,
            };
        }
    }

    const maxBytes = Math.max(1, Math.trunc(params.maxBytes));
    const maxItems = Math.max(1, Math.trunc(params.maxItems));
    const items: ExternalSessionTranscriptRawMessageV1[] = [];
    let usedBytes = 0;
    let truncated = false;
    const progressByStreamId = new Map(cursorOffsets);

    for (const record of snapshot.mergedRecords) {
        const streamOffset = progressByStreamId.get(record.streamId) ?? { nextOffsetBytes: 0, subIndex: 0 };
        if (record.lineStartOffsetBytes < streamOffset.nextOffsetBytes) continue;
        if (record.lineStartOffsetBytes === streamOffset.nextOffsetBytes && record.subIndex < streamOffset.subIndex) continue;
        const itemBytes = measureDirectTranscriptItemBytes(record.item);
        if (items.length > 0 && (items.length >= maxItems || usedBytes + itemBytes > maxBytes)) {
            truncated = true;
            break;
        }
        items.push(record.item);
        usedBytes += itemBytes;
        progressByStreamId.set(record.streamId, {
            nextOffsetBytes: record.lineStartOffsetBytes,
            subIndex: record.subIndex + 1,
        });
        if (items.length >= maxItems || usedBytes >= maxBytes) {
            truncated = snapshot.mergedRecords.some((candidate) => {
                const candidateProgress = progressByStreamId.get(candidate.streamId) ?? { nextOffsetBytes: 0, subIndex: 0 };
                if (candidate.lineStartOffsetBytes < candidateProgress.nextOffsetBytes) return false;
                if (
                    candidate.lineStartOffsetBytes === candidateProgress.nextOffsetBytes
                    && candidate.subIndex < candidateProgress.subIndex
                ) {
                    return false;
                }
                return true;
            });
            break;
        }
    }

    if (!truncated) {
        for (const state of snapshot.streamStates) {
            progressByStreamId.set(state.stream.fileRelPath, {
                nextOffsetBytes: state.nextOffsetBytes,
                subIndex: 0,
            });
        }
    }

    if (items.length === 0) {
        return {
            items,
            nextCursor: buildReadAfterCursorFromProgress({
                snapshot,
                progressByStreamId,
            }),
            truncated,
        };
    }

    return {
        items,
        nextCursor: buildReadAfterCursorFromProgress({
            snapshot,
            progressByStreamId,
        }),
        truncated,
    };
}
