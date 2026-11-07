import type { Message } from '@happier-dev/session-core/messages';
import { compareTranscriptMessagesOldestFirst } from '@happier-dev/session-core/messages';
import type { WorkerUpdateHeadlineFactsV1, WorkerUpdateV1 } from '@happier-dev/protocol/sessions/relations/workerUpdateV1';

export type LatestWorkerUpdate = Readonly<WorkerUpdateHeadlineFactsV1 & { messageId: string }>;
export type LatestWorkerUpdates = Readonly<{
    /** The latest nonempty delivered headline across worker kinds, in transcript order. */
    latestMessage: Readonly<{ messageId: string }> | null;
} & Partial<Record<WorkerUpdateV1['workerKind'], Readonly<Record<string, LatestWorkerUpdate>>>>>;

export const EMPTY_LATEST_WORKER_UPDATES: LatestWorkerUpdates = Object.freeze({ latestMessage: null });

function readUpdate(message: Message | undefined): WorkerUpdateV1 | null {
    return message?.kind === 'agent-event' && message.event.type === 'worker-update' ? message.event.update : null;
}

function projectUpdate(messageId: string, update: WorkerUpdateV1): LatestWorkerUpdate {
    // Spread preserves the discriminated worker kind/outcome relationship without retaining bodies.
    const { result: _result, deliverables: _deliverables, truncated: _truncated, transcriptPointer: _pointer,
        runtimeIssueV1: _issue, engine: _engine, canInspect: _inspect, v: _version, ...facts } = update;
    return { messageId, ...facts };
}

/** The same latest-message rule for stored transcripts and supplied read-only slices. */
export function buildLatestWorkerUpdates(messages: readonly Message[]): LatestWorkerUpdates {
    const latest = new Map<WorkerUpdateV1['workerKind'], Map<string, Message>>();
    let latestMessage: Message | null = null;
    for (const message of messages) {
        const update = readUpdate(message);
        if (!update) continue;
        if (update.headline.trim() && (!latestMessage || compareTranscriptMessagesOldestFirst(latestMessage, message) < 0)) latestMessage = message;
        let workers = latest.get(update.workerKind);
        if (!workers) latest.set(update.workerKind, workers = new Map());
        const before = workers.get(update.workerId);
        if (!before || compareTranscriptMessagesOldestFirst(before, message) < 0) workers.set(update.workerId, message);
    }
    if (latest.size === 0) return EMPTY_LATEST_WORKER_UPDATES;
    return { latestMessage: latestMessage ? { messageId: latestMessage.id } : null, ...Object.fromEntries([...latest].map(([kind, workers]) => [kind,
        Object.fromEntries([...workers].map(([id, message]) => [id, projectUpdate(message.id, readUpdate(message)!)])),
    ])) };
}

/**
 * Ordinary arrivals inspect changed rows only. Native events retain their source identity/content;
 * the transcript replacement owner starts an empty projection when history is replaced or removed.
 */
export function applyLatestWorkerUpdateChanges(input: Readonly<{
    previous: LatestWorkerUpdates | undefined;
    messages: Readonly<Record<string, Message>>;
    changed: readonly Message[];
}>): LatestWorkerUpdates {
    if (!input.previous) return buildLatestWorkerUpdates(Object.values(input.messages));
    let projected = input.previous;
    for (const message of input.changed) {
        const update = readUpdate(message);
        if (!update) continue;
        const latestMessage = projected.latestMessage ? input.messages[projected.latestMessage.messageId] : undefined;
        if (update.headline.trim() && (!latestMessage || compareTranscriptMessagesOldestFirst(latestMessage, message) < 0)
            && projected.latestMessage?.messageId !== message.id) projected = { ...projected, latestMessage: { messageId: message.id } };
        const current = projected[update.workerKind]?.[update.workerId];
        const currentMessage = current ? input.messages[current.messageId] : undefined;
        if (currentMessage && currentMessage.id !== message.id
            && compareTranscriptMessagesOldestFirst(currentMessage, message) >= 0) continue;
        if (current?.messageId === message.id && current.headline === update.headline
            && current.ownerState === update.ownerState && current.wake === update.wake) continue;
        projected = { ...projected, [update.workerKind]: {
            ...projected[update.workerKind], [update.workerId]: projectUpdate(message.id, update),
        } };
    }
    return projected;
}
