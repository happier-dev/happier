import type { Message } from "@happier-dev/session-core/messages";
import { isSessionFollowWakeEventLocalId } from '@happier-dev/protocol/sessions/follow/sessionFollowTransportV1';
import { readHostFollowInputMeta } from '@/sync/domains/session/input/hostAuthoredInput';
import { indexFollowWorkerCardsByInputLocalId } from './followWorkerCardDelivery';

export type TranscriptEventEmphasis = 'normal' | 'deemphasized';
export type TranscriptEventEmphasisByMessageId = Readonly<Record<string, TranscriptEventEmphasis>>;

const EMPTY_TRANSCRIPT_EVENT_EMPHASIS_BY_MESSAGE_ID: TranscriptEventEmphasisByMessageId = Object.freeze({});

export function resolveTranscriptEventEmphasisByMessageId(input: Readonly<{
    messageIdsOldestFirst: readonly string[];
    messagesById: Readonly<Record<string, Message>>;
    sessionActive: boolean;
}>): TranscriptEventEmphasisByMessageId {
    if (!input.sessionActive) return EMPTY_TRANSCRIPT_EVENT_EMPHASIS_BY_MESSAGE_ID;

    let latestReadyIndex = -1;
    input.messageIdsOldestFirst.forEach((messageId, index) => {
        const message = input.messagesById[messageId];
        if (message?.kind === 'agent-event' && message.event.type === 'ready') {
            latestReadyIndex = index;
        }
    });
    if (latestReadyIndex < 0) return EMPTY_TRANSCRIPT_EVENT_EMPHASIS_BY_MESSAGE_ID;

    const emphasisByMessageId: Record<string, TranscriptEventEmphasis> = {};
    for (let index = 0; index < latestReadyIndex; index += 1) {
        const messageId = input.messageIdsOldestFirst[index]!;
        const message = input.messagesById[messageId];
        if (message?.kind === 'agent-event' && message.event.type !== 'ready') {
            emphasisByMessageId[messageId] = 'deemphasized';
        }
    }
    return emphasisByMessageId;
}

export type TranscriptHostWakeCountByMessageId = Readonly<Record<string, number>>;

const EMPTY_TRANSCRIPT_HOST_WAKE_COUNT_BY_MESSAGE_ID: TranscriptHostWakeCountByMessageId = Object.freeze({});

/**
 * Adjacency never proves acceptance. Count only original inputs or legacy
 * batches whose canonical server projection proves a wake, with one presenter
 * for a consecutive update run and exact input/batch correlation to its cards.
 */
export function resolveTranscriptHostWakeCountByMessageId(input: Readonly<{
    messageIdsOldestFirst: readonly string[];
    messagesById: Readonly<Record<string, Message>>;
}>): TranscriptHostWakeCountByMessageId {
    const acceptedBatches = new Set<string>();
    const cardByInputId = indexFollowWorkerCardsByInputLocalId(input.messagesById, input.messageIdsOldestFirst);
    for (const messageId of input.messageIdsOldestFirst) {
        const message = input.messagesById[messageId];
        if (message?.kind === 'agent-event'
            && isSessionFollowWakeEventLocalId(message.localId)
            && 'followDeliveryProjection' in message
            && message.followDeliveryProjection?.status === 'woke') {
            acceptedBatches.add(message.localId);
        }
    }
    let counts: Record<string, number> | null = null;
    const openerByBatch = new Map<string, string>();
    for (const messageId of input.messageIdsOldestFirst) {
        const message = input.messagesById[messageId];
        if (message?.kind !== 'agent-event' || message.event.type !== 'worker-update') continue;
        const batchId = message.event.followWakeEventLocalId;
        if (!batchId || !acceptedBatches.has(batchId)) continue;
        counts ??= {};
        const openerId = openerByBatch.get(batchId);
        if (!openerId) {
            openerByBatch.set(batchId, messageId);
            counts[messageId] = 1;
        } else {
            counts[openerId] = (counts[openerId] ?? 0) + 1;
        }
    }
    // Original-input deliveries already carry exact server acceptance. A run of
    // consecutive updates gets one notice, on its first correlated card when
    // available, otherwise on its first input. Proximity never proves a wake.
    let originals: Extract<Message, { kind: 'user-text' }>[] = [];
    const flushOriginals = () => {
        if (originals.length === 0) return;
        const cardId = originals.map(message => message.localId ? cardByInputId.get(message.localId) : undefined).find(Boolean);
        counts ??= {};
        const noticeId = cardId ?? originals[0]!.id;
        counts[noticeId] = (counts[noticeId] ?? 0) + originals.length;
        originals = [];
    };
    for (const messageId of input.messageIdsOldestFirst) {
        const message = input.messagesById[messageId];
        if (message?.kind === 'user-text' && message.followDeliveryProjection?.status === 'woke'
            && readHostFollowInputMeta(message.meta)) {
            originals.push(message);
        } else if (message?.kind !== 'agent-event' || message.event.type !== 'worker-update') flushOriginals();
    }
    flushOriginals();
    return counts ?? EMPTY_TRANSCRIPT_HOST_WAKE_COUNT_BY_MESSAGE_ID;
}
