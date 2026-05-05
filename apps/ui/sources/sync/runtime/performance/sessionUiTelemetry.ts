import type { NormalizedMessage } from '@/sync/typesRaw';
import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';

type StreamingTelemetrySource = 'socketMessage' | 'transcriptStreamSegment';

type StreamingMessageMark = Readonly<{
    messages: number;
    source: StreamingTelemetrySource;
    startedAtMs: number;
}>;

const MAX_PENDING_STREAMING_MARKS_PER_SESSION = 200;

const streamingMarksBySessionId = new Map<string, Map<string, StreamingMessageMark[]>>();

export function readSessionUiTelemetryNowMs(): number {
    const perf = (globalThis as unknown as { performance?: { now?: () => number } }).performance;
    if (typeof perf?.now === 'function') {
        return perf.now();
    }
    return Date.now();
}

function readMessageIds(messages: readonly Pick<NormalizedMessage, 'id'>[]): string[] {
    const ids: string[] = [];
    for (const message of messages) {
        const id = typeof message.id === 'string' ? message.id.trim() : '';
        if (id.length > 0) {
            ids.push(id);
        }
    }
    return ids;
}

function countMarks(sessionMarks: ReadonlyMap<string, readonly StreamingMessageMark[]>): number {
    let total = 0;
    for (const marks of sessionMarks.values()) {
        total += marks.length;
    }
    return total;
}

function trimOldestSessionMarks(sessionMarks: Map<string, StreamingMessageMark[]>): void {
    while (countMarks(sessionMarks) > MAX_PENDING_STREAMING_MARKS_PER_SESSION) {
        const firstEntry = sessionMarks.entries().next().value as [string, StreamingMessageMark[]] | undefined;
        if (!firstEntry) return;
        const [messageId, marks] = firstEntry;
        marks.shift();
        if (marks.length === 0) {
            sessionMarks.delete(messageId);
        }
    }
}

export function clearSessionUiTelemetryMarks(sessionId?: string): void {
    if (typeof sessionId === 'string' && sessionId.length > 0) {
        streamingMarksBySessionId.delete(sessionId);
        return;
    }
    streamingMarksBySessionId.clear();
}

export function markStreamingMessagesAppliedForSessionUiTelemetry(params: Readonly<{
    messages: readonly Pick<NormalizedMessage, 'id'>[];
    sessionId: string;
    source: StreamingTelemetrySource;
}>): void {
    if (!syncPerformanceTelemetry.isEnabled()) return;
    const sessionId = params.sessionId.trim();
    if (!sessionId) return;
    const messageIds = readMessageIds(params.messages);
    if (messageIds.length === 0) return;

    let sessionMarks = streamingMarksBySessionId.get(sessionId);
    if (!sessionMarks) {
        sessionMarks = new Map<string, StreamingMessageMark[]>();
        streamingMarksBySessionId.set(sessionId, sessionMarks);
    }

    const startedAtMs = readSessionUiTelemetryNowMs();
    for (const messageId of messageIds) {
        const marks = sessionMarks.get(messageId) ?? [];
        marks.push({
            messages: 1,
            source: params.source,
            startedAtMs,
        });
        sessionMarks.set(messageId, marks);
    }

    trimOldestSessionMarks(sessionMarks);
}

export function recordStreamingVisibleUpdateForSessionUiTelemetry(params: Readonly<{
    committedMessages: number;
    latestMessageId: string | null;
    sessionId: string;
    transcriptLoaded: number;
    visibleItems: number;
}>): void {
    if (!syncPerformanceTelemetry.isEnabled()) return;
    if (params.transcriptLoaded !== 1) return;
    const sessionId = params.sessionId.trim();
    const latestMessageId = params.latestMessageId?.trim() ?? '';
    if (!sessionId || !latestMessageId) return;

    const sessionMarks = streamingMarksBySessionId.get(sessionId);
    const marks = sessionMarks?.get(latestMessageId);
    if (!sessionMarks || !marks || marks.length === 0) return;

    sessionMarks.delete(latestMessageId);
    if (sessionMarks.size === 0) {
        streamingMarksBySessionId.delete(sessionId);
    }

    const nowMs = readSessionUiTelemetryNowMs();
    const visibleItems = Math.max(0, Math.trunc(params.visibleItems));
    const committedMessages = Math.max(0, Math.trunc(params.committedMessages));

    for (const mark of marks) {
        syncPerformanceTelemetry.recordDuration(
            'ui.sessions.streaming.visibleUpdate',
            nowMs - mark.startedAtMs,
            {
                committedMessages,
                messages: mark.messages,
                sourceSocketMessage: mark.source === 'socketMessage' ? 1 : 0,
                sourceTranscriptStreamSegment: mark.source === 'transcriptStreamSegment' ? 1 : 0,
                transcriptLoaded: params.transcriptLoaded,
                visibleItems,
            },
        );
    }
}
