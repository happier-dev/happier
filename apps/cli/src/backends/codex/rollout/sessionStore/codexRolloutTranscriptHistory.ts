import { stat } from 'node:fs/promises';

import type { DirectSessionsSource, DirectTranscriptRawMessageV1 } from '@happier-dev/protocol';

import { readJsonlFileForward } from '@/api/session/fileBackedTranscripts/jsonl/readJsonlForward';

import {
    decodeCodexDirectForwardCursor,
    encodeCodexDirectForwardCursor,
    type CodexDirectForwardCursor,
} from '../../directSessions/codexDirectForwardCursor';
import {
    mapCodexDirectSessionAppServerPreviewToMessage,
    resolveCodexDirectSessionAppServerMetadata,
} from '../../directSessions/resolveCodexDirectSessionAppServerMetadata';
import { readCodexSessionTitleFromRollout } from '../../directSessions/readCodexSessionTitleFromRollout';
import { resolveCodexHomeEntriesForDirectSessionsSource } from '../../directSessions/resolveCodexHomeEntriesForDirectSessionsSource';
import { mapCodexRolloutLineToDirectMessages } from '../../directSessions/mapCodexRolloutLineToDirectMessages';
import { createCodexRolloutSemanticTracker } from '../createCodexRolloutSemanticTracker';
import { collectCodexSessionRolloutFiles, type CodexRolloutFile } from '../discovery/collectCodexSessionRolloutFiles';
import { mapCodexRolloutEventToActions } from '../projection/mapCodexRolloutEventToActions';

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

type CodexBackwardMergedCursor = CodexBackwardMergedCursorV2 | CodexBackwardMergedCursorV3;

type CodexDirectTranscriptRolloutStream = CodexRolloutFile & Readonly<{
    threadId: string;
    sidechainId: string | null;
}>;

type CodexRolloutStreamVectorEntry = Readonly<{
    fileRelPath: string;
    nextOffsetBytes: number;
    subIndex: number;
}>;

type CodexProjectedTranscriptRecord = Readonly<{
    item: DirectTranscriptRawMessageV1;
    streamId: string;
    lineStartOffsetBytes: number;
    lineEndOffsetBytes: number;
    subIndex: number;
}>;

type CodexRolloutReadProgressEntry = Readonly<{
    nextOffsetBytes: number;
    subIndex: number;
}>;

type CodexRolloutDirectTranscriptStreamState = Readonly<{
    stream: CodexDirectTranscriptRolloutStream;
    nextOffsetBytes: number;
    fileSizeBytes: number;
    records: readonly CodexProjectedTranscriptRecord[];
    discoveredChildThreadIds: readonly string[];
    sessionMetaCwd: string | null;
    sessionMetaTimestampMs: number | null;
    semanticTracker: ReturnType<typeof createCodexRolloutSemanticTracker>;
}>;

type CodexRolloutDirectTranscriptSnapshot = Readonly<{
    remoteSessionId: string;
    mergedRecords: readonly CodexProjectedTranscriptRecord[];
    rolloutHome: string | null;
    rolloutSource: DirectSessionsSource | null;
    rolloutSignature: string | null;
    appServerMetadata: Awaited<ReturnType<typeof resolveCodexDirectSessionAppServerMetadata>> | null;
    title: string | null;
    workingDirectory: string | null;
    lastActivityAtMs: number | null;
    createdAtMs: number | null;
    primaryRolloutFilePath: string | null;
    streamStates: readonly CodexRolloutDirectTranscriptStreamState[];
}>;

type CodexResolvedStreamState = Readonly<{
    state: CodexRolloutDirectTranscriptStreamState;
    appendedRecords: readonly CodexProjectedTranscriptRecord[];
    replacedExistingRecords: boolean;
}>;

export type CodexRolloutDirectTranscriptPageParams = Readonly<{
    direction: 'older' | 'newer';
    cursor?: string;
    maxBytes: number;
    maxItems: number;
}>;

export type CodexRolloutDirectTranscriptPageResult = Readonly<{
    items: DirectTranscriptRawMessageV1[];
    nextCursor: string | null;
    tailCursor: string | null;
    hasMore: boolean;
    truncated: boolean;
}>;

export type CodexRolloutDirectTranscriptReadAfterParams = Readonly<{
    cursor: string;
    maxBytes: number;
    maxItems: number;
}>;

export type CodexRolloutDirectTranscriptReadAfterResult = Readonly<{
    items: DirectTranscriptRawMessageV1[];
    nextCursor: string | null;
    truncated: boolean;
}>;

function encodeBackwardCursor(value: CodexBackwardMergedCursor): string {
    return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decodeBackwardCursor(raw: string | undefined): CodexBackwardMergedCursor | null {
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
        return null;
    } catch {
        return null;
    }
}

function measureDirectTranscriptItemBytes(item: DirectTranscriptRawMessageV1): number {
    return Buffer.byteLength(JSON.stringify(item), 'utf8');
}

function compareDirectTranscriptItemsOldestFirst(left: DirectTranscriptRawMessageV1, right: DirectTranscriptRawMessageV1): number {
    if (left.createdAtMs !== right.createdAtMs) return left.createdAtMs - right.createdAtMs;
    return left.id.localeCompare(right.id);
}

function compareProjectedRecordsOldestFirst(left: CodexProjectedTranscriptRecord, right: CodexProjectedTranscriptRecord): number {
    return compareDirectTranscriptItemsOldestFirst(left.item, right.item);
}

function buildAppServerPreviewCursor(metadata: NonNullable<CodexRolloutDirectTranscriptSnapshot['appServerMetadata']>): string {
    return encodeCodexDirectForwardCursor({
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
    return encodeCodexDirectForwardCursor({
        v: 4,
        kind: 'codexForwardStreamVector',
        streams,
    });
}

function buildStreamVectorCursor(
    streamStates: readonly CodexRolloutDirectTranscriptStreamState[],
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

function decodeStreamVectorCursor(
    cursor: CodexDirectForwardCursor | null,
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
    snapshot: CodexRolloutDirectTranscriptSnapshot;
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
    stream: CodexDirectTranscriptRolloutStream;
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
    stream: CodexDirectTranscriptRolloutStream;
    offsetBytes: number;
    semanticTracker: ReturnType<typeof createCodexRolloutSemanticTracker>;
}>): Promise<Readonly<{
    nextOffsetBytes: number;
    fileSizeBytes: number;
    records: readonly CodexProjectedTranscriptRecord[];
    discoveredChildThreadIds: readonly string[];
    sessionMetaCwd: string | null;
    sessionMetaTimestampMs: number | null;
}>> {
    const fileSizeBytes = (await statFileSize(params.stream.filePath)) ?? 0;
    const records: CodexProjectedTranscriptRecord[] = [];
    const discoveredChildThreadIds = new Set<string>();
    let nextOffsetBytes = normalizeOffsetBytes(params.offsetBytes);
    let sessionMetaCwd: string | null = null;
    let sessionMetaTimestampMs: number | null = null;

    while (true) {
        const page = await readJsonlFileForward({
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
                sessionMetaCwd,
                sessionMetaTimestampMs,
            };
        }

        for (const line of page.items) {
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
                }
            }

            const mappedItems = mapCodexRolloutLineToDirectMessages({
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
        sessionMetaCwd,
        sessionMetaTimestampMs,
    };
}

async function resolveStreamState(
    stream: CodexDirectTranscriptRolloutStream,
    previousState: CodexRolloutDirectTranscriptStreamState | null,
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
            sessionMetaCwd: read.sessionMetaCwd ?? previousState.sessionMetaCwd,
            sessionMetaTimestampMs: read.sessionMetaTimestampMs ?? previousState.sessionMetaTimestampMs,
            semanticTracker: previousState.semanticTracker,
        },
        appendedRecords: read.records,
        replacedExistingRecords: false,
    };
}

function buildRolloutSignature(streams: readonly CodexDirectTranscriptRolloutStream[]): string | null {
    if (streams.length === 0) return null;
    return streams
        .map((stream) => `${stream.fileRelPath}:${stream.sortMs}:${stream.mtimeMs}:${stream.threadId}:${stream.sidechainId ?? ''}`)
        .join('|');
}

function selectBestCodexHomeWithFiles<TEntry extends Readonly<{ codexHome: string }>>(
    entries: readonly TEntry[],
    perHomeFiles: readonly (readonly CodexRolloutFile[])[],
): TEntry | null {
    let bestEntry: TEntry | null = null;
    let bestLatestMtimeMs = -1;
    for (let index = 0; index < entries.length; index += 1) {
        const entry = entries[index]!;
        const files = perHomeFiles[index] ?? [];
        if (files.length === 0) continue;
        const latestMtimeMs = Math.max(...files.map((file) => file.mtimeMs));
        if (latestMtimeMs > bestLatestMtimeMs) {
            bestLatestMtimeMs = latestMtimeMs;
            bestEntry = entry;
        }
    }
    return bestEntry;
}

async function collectCodexDirectTranscriptStreamStates(params: Readonly<{
    codexHome: string;
    remoteSessionId: string;
    previousSnapshot?: CodexRolloutDirectTranscriptSnapshot | null;
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

        const files = await collectCodexSessionRolloutFiles({
            codexHome: params.codexHome,
            remoteSessionId: current.threadId,
        });
        if (files.length === 0) continue;

        const sortedStreams = files
            .map((file): CodexDirectTranscriptRolloutStream => ({
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
    previousSnapshot?: CodexRolloutDirectTranscriptSnapshot | null;
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
    streamStates: readonly CodexRolloutDirectTranscriptStreamState[],
): Promise<string | null> {
    const primaryRootStream = [...streamStates]
        .filter((state) => state.stream.sidechainId === null)
        .sort((left, right) =>
            resolveRolloutChronologyMs(left.stream) - resolveRolloutChronologyMs(right.stream)
            || left.stream.mtimeMs - right.stream.mtimeMs
            || left.stream.fileRelPath.localeCompare(right.stream.fileRelPath),
        )[0];
    if (!primaryRootStream) return null;
    return readCodexSessionTitleFromRollout(primaryRootStream.stream.filePath);
}

function resolveSnapshotWorkingDirectory(
    streamStates: readonly CodexRolloutDirectTranscriptStreamState[],
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
    streamStates: readonly CodexRolloutDirectTranscriptStreamState[],
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

function resolveSnapshotActivity(streamStates: readonly CodexRolloutDirectTranscriptStreamState[]): number | null {
    if (streamStates.length === 0) return null;
    return Math.max(...streamStates.map((state) => Math.max(0, Math.trunc(state.stream.mtimeMs))));
}

function resolvePrimaryRolloutFilePath(
    streamStates: readonly CodexRolloutDirectTranscriptStreamState[],
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

function resolveRolloutChronologyMs(stream: CodexDirectTranscriptRolloutStream): number {
    const name = stream.filePath.split(/[/\\]/).pop() ?? '';
    const match = /^rollout-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})/.exec(name);
    if (!match) {
        return Math.max(0, Math.trunc(stream.sortMs));
    }
    const isoLike = match[1].replace(/T(\d{2})-(\d{2})-(\d{2})$/, 'T$1:$2:$3');
    const parsed = Date.parse(`${isoLike}Z`);
    return Number.isFinite(parsed) ? Math.trunc(parsed) : Math.max(0, Math.trunc(stream.sortMs));
}

export async function resolveCodexRolloutDirectTranscriptSnapshot(params: Readonly<{
    source: DirectSessionsSource;
    activeServerDir: string;
    env?: NodeJS.ProcessEnv;
    remoteSessionId: string;
    previousSnapshot?: CodexRolloutDirectTranscriptSnapshot | null;
}>): Promise<CodexRolloutDirectTranscriptSnapshot> {
    const env = params.env ?? process.env;
    const homeEntries = await resolveCodexHomeEntriesForDirectSessionsSource({
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
        const appServerMetadata = await resolveCodexDirectSessionAppServerMetadata({
            source: params.source,
            activeServerDir: params.activeServerDir,
            remoteSessionId: params.remoteSessionId,
            env,
        });
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

    const resolvedStates = await collectCodexDirectTranscriptStreamStates({
        codexHome: bestEntry.codexHome,
        remoteSessionId: params.remoteSessionId,
        previousSnapshot:
            params.previousSnapshot?.rolloutHome === bestEntry.codexHome
                ? params.previousSnapshot
                : null,
    });
    const streamStates = resolvedStates.map((resolved) => resolved.state);
    const rolloutSignature = buildRolloutSignature(streamStates.map((state) => state.stream));
    if (
        params.previousSnapshot
        && params.previousSnapshot.rolloutHome === bestEntry.codexHome
        && params.previousSnapshot.rolloutSignature === rolloutSignature
    ) {
        return params.previousSnapshot;
    }

    const mergedRecords = buildMergedRecords({
        previousSnapshot:
            params.previousSnapshot?.rolloutHome === bestEntry.codexHome
                ? params.previousSnapshot
                : null,
        resolvedStates,
        rolloutHome: bestEntry.codexHome,
    });
    const title = await resolveSnapshotTitle(streamStates);
    return {
        remoteSessionId: params.remoteSessionId,
        mergedRecords,
        rolloutHome: bestEntry.codexHome,
        rolloutSource: bestEntry.source,
        rolloutSignature,
        appServerMetadata: null,
        title,
        workingDirectory: resolveSnapshotWorkingDirectory(streamStates),
        lastActivityAtMs: resolveSnapshotActivity(streamStates),
        createdAtMs: resolveSnapshotCreatedAtMs(streamStates),
        primaryRolloutFilePath: resolvePrimaryRolloutFilePath(streamStates),
        streamStates,
    };
}

export function pageCodexRolloutDirectTranscriptSnapshot(
    snapshot: CodexRolloutDirectTranscriptSnapshot,
    params: CodexRolloutDirectTranscriptPageParams,
): CodexRolloutDirectTranscriptPageResult {
    if (snapshot.rolloutHome === null) {
        const previewItem = snapshot.appServerMetadata
            ? mapCodexDirectSessionAppServerPreviewToMessage({
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

export function readAfterCodexRolloutDirectTranscriptSnapshot(
    snapshot: CodexRolloutDirectTranscriptSnapshot,
    params: CodexRolloutDirectTranscriptReadAfterParams,
): CodexRolloutDirectTranscriptReadAfterResult {
    if (snapshot.rolloutHome === null) {
        if (params.cursor === 'tail' && snapshot.appServerMetadata) {
            return {
                items: [],
                nextCursor: buildAppServerPreviewCursor(snapshot.appServerMetadata),
                truncated: false,
            };
        }

        const decodedEmpty = params.cursor === 'tail' ? null : decodeCodexDirectForwardCursor(params.cursor);
        if (decodedEmpty?.kind === 'codexForwardAppServer') {
            const previousCursor = encodeCodexDirectForwardCursor(decodedEmpty);
            const nextCursor = snapshot.appServerMetadata ? buildAppServerPreviewCursor(snapshot.appServerMetadata) : previousCursor;
            const changed = snapshot.appServerMetadata ? nextCursor !== previousCursor : false;
            const previewItem = changed && snapshot.appServerMetadata
                ? mapCodexDirectSessionAppServerPreviewToMessage({
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

    const decoded = decodeCodexDirectForwardCursor(params.cursor);
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
    const items: DirectTranscriptRawMessageV1[] = [];
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

    if (items.length === 0) {
        return {
            items,
            nextCursor: params.cursor,
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
