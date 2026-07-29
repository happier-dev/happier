import {
    REALTIME_CONVERSATION_VOICE_TURN_ORIGIN_V1,
    deriveVoiceAgentTurnLocalId,
    deriveVoiceAgentTurnProvisionalLocalId,
    readVoiceAgentTurnPayloadFromMeta,
    readVoiceAgentTurnProvisionalLocalId,
    type ConversationTurnOriginV1,
    type VoiceAgentTurnV1,
    type VoiceTranscriptCanonicalEventV1,
} from '@happier-dev/protocol';

import { readStoredSessionMessages } from '@/sync/domains/messages/readStoredSessionMessages';
import type { PersistSessionTranscriptMessageInput } from '@/sync/domains/messages/persistSessionTranscriptMessage';
import { storage } from '@/sync/domains/state/storage';
import type { NormalizedMessage, RawRecord } from '@/sync/typesRaw';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { normalizeNonEmptyString } from '@/voice/shared/normalizeNonEmptyString';
import {
    VOICE_TRANSCRIPT_SELECTOR_CACHE_MAX,
    VOICE_TRANSCRIPT_UNRECONCILED_EVENT_RING_MAX,
} from './voiceTranscriptBounds';
import type { VoiceTranscriptTurn } from './voiceTranscriptEvents';
import { buildVoiceTranscriptNoteMeta } from './voiceTranscriptNoteMeta';
import {
    createCanonicalVoiceTranscriptProjector,
    deriveCanonicalVoiceTranscriptEntryId,
    type CanonicalVoiceTranscriptItem,
} from './canonicalProjector';
export { deriveCanonicalVoiceTranscriptEntryId } from './canonicalProjector';

type VoiceTranscriptStateLike = Readonly<{
    sessionMessages?: Record<string, Readonly<{ messages?: ReadonlyArray<unknown> }>>;
    applyMessagesLoaded?: (sessionId: string) => void;
    applyMessages?: (sessionId: string, messages: NormalizedMessage[]) => void;
}>;

type VoiceTranscriptProjectorDeps = Readonly<{
    getState: () => VoiceTranscriptStateLike;
    persistFinal?: (input: PersistSessionTranscriptMessageInput) => void | Promise<unknown>;
    nowMs?: () => number;
    maxCanonicalConversations?: number;
}>;

type RealtimeConversationTurnSource =
    NonNullable<Extract<
        ConversationTurnOriginV1,
        { channel: 'realtime_conversation' }
    >['source']>;

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
    if (!value || typeof value !== 'object') return null;
    return value as Readonly<Record<string, unknown>>;
}

function extractAssistantText(content: unknown): string | null {
    if (!Array.isArray(content)) return null;
    for (const entry of content) {
        const record = readRecord(entry);
        if (!record || record.type !== 'text' || typeof record.text !== 'string') continue;
        return normalizeNonEmptyString(record.text);
    }
    return null;
}

function normalizeText(value: unknown): string | null {
    return normalizeNonEmptyString(typeof value === 'string' ? value : String(value ?? ''));
}

function readProjectedMessageText(record: Readonly<Record<string, unknown>>): string {
    if (record.role === 'user') {
        const content = readRecord(record.content);
        if (content?.type === 'text' && typeof content.text === 'string') {
            return String(content.text).trim();
        }
        return '';
    }
    if (record.role === 'agent') {
        return extractAssistantText(record.content) ?? '';
    }
    return '';
}

function buildVoiceTurnMeta(turn: VoiceTranscriptTurn | null): NormalizedMessage['meta'] | undefined {
    if (!turn) return undefined;
    const runId = normalizeNonEmptyString(turn.runId);
    const streamId = normalizeNonEmptyString(turn.streamId);
    const requestId = normalizeNonEmptyString(turn.requestId);
    return {
        happier: {
            kind: 'voice_agent_turn.v1',
            payload: {
                v: 1,
                epoch: turn.epoch,
                role: turn.role,
                ts: turn.ts,
                voiceAgentId: turn.voiceAgentId,
                ...(runId ? { runId } : {}),
                ...(streamId ? { streamId } : {}),
                ...(requestId ? { requestId } : {}),
            } satisfies VoiceAgentTurnV1,
        },
    };
}

function buildRealtimeConversationTurnMeta(
    source?: RealtimeConversationTurnSource,
): NormalizedMessage['meta'] {
    return {
        happier: {
            kind: 'conversation_turn.v1',
            payload: { v: 1 },
            conversationTurnOriginV1: {
                ...REALTIME_CONVERSATION_VOICE_TURN_ORIGIN_V1,
                ...(source ? { source } : {}),
            },
        },
    };
}

function buildRealtimeConversationRawRecord(params: Readonly<{
    id: string;
    role: 'user' | 'assistant';
    text: string;
    source?: RealtimeConversationTurnSource;
}>): RawRecord {
    const meta = buildRealtimeConversationTurnMeta(params.source);
    return params.role === 'user'
        ? {
            role: 'user',
            content: { type: 'text', text: params.text },
            meta,
        }
        : {
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'assistant',
                    uuid: params.id,
                    message: {
                        role: 'assistant',
                        content: [{ type: 'text', text: params.text }],
                        usage: undefined,
                    },
                },
            },
            meta,
        };
}

export function deriveVoiceTranscriptOptimisticId(params: Readonly<{
    conversationSessionId: string;
    role: 'user' | 'assistant' | 'note';
    text: string;
    turn?: VoiceTranscriptTurn | null;
    localSequence?: number | null;
}>): string {
    const conversationSessionId = normalizeNonEmptyString(params.conversationSessionId) ?? 'unknown';
    const text = normalizeText(params.text) ?? 'empty';
    const turn = params.turn ?? null;
    if (turn) {
        return deriveVoiceAgentTurnLocalId(turn);
    }
    const localSequence = Number.isFinite(params.localSequence) ? Math.trunc(params.localSequence ?? 0) : 0;
    if (params.role === 'user' || params.role === 'assistant') {
        return deriveVoiceAgentTurnProvisionalLocalId({
            transcriptSessionId: conversationSessionId,
            role: params.role,
            sequence: localSequence,
        });
    }
    return [
        'voice-local',
        conversationSessionId,
        params.role,
        localSequence,
    ].join(':');
}

function messageMatchesTurn(message: unknown, nextText: string, nextTurn: VoiceTranscriptTurn | null): boolean {
    if (!nextTurn) return false;
    const record = readRecord(message);
    if (!record) return false;
    const payload = readVoiceAgentTurnPayloadFromMeta(record.meta) as Partial<VoiceAgentTurnV1> | null;
    if (!payload) return false;
    if (payload.voiceAgentId !== nextTurn.voiceAgentId) return false;
    if (payload.epoch !== nextTurn.epoch) return false;
    if (payload.role !== nextTurn.role) return false;
    if (payload.ts !== nextTurn.ts) return false;
    if (nextTurn.runId && payload.runId !== nextTurn.runId) return false;
    if (nextTurn.streamId && payload.streamId !== nextTurn.streamId) return false;
    if (nextTurn.requestId && payload.requestId !== nextTurn.requestId) return false;
    return readProjectedMessageText(record) === nextText;
}

function messageMatchesProvisionalTurn(
    message: unknown,
    conversationSessionId: string,
    nextText: string,
    nextTurn: VoiceTranscriptTurn | null,
): boolean {
    if (!nextTurn) return false;
    const record = readRecord(message);
    if (!record) return false;
    if (readVoiceAgentTurnPayloadFromMeta(record.meta)) return false;

    const provisionalId = readVoiceAgentTurnProvisionalLocalId(
        typeof record.localId === 'string'
            ? record.localId
            : typeof record.id === 'string'
                ? record.id
                : null,
    );
    if (!provisionalId) return false;
    if (provisionalId.transcriptSessionId !== conversationSessionId) return false;
    if (provisionalId.role !== nextTurn.role) return false;
    return readProjectedMessageText(record) === nextText;
}

function promoteProvisionalMessage(existing: unknown, message: NormalizedMessage): void {
    const record = readRecord(existing);
    if (!record) return;
    if (typeof message.id === 'string' && message.id.trim()) {
        (record as Record<string, unknown>).realID = message.id;
    }
    if (message.meta !== undefined) {
        (record as Record<string, unknown>).meta = message.meta;
    }
}

type UpsertProjectedMessageResult = Readonly<{
    message: NormalizedMessage;
    appliedNew: boolean;
    reconciledProvisionalId: string | null;
}>;

function readProvisionalRecordId(record: Readonly<Record<string, unknown>> | null): string | null {
    if (!record) return null;
    if (typeof record.localId === 'string' && record.localId.trim()) return record.localId;
    if (typeof record.id === 'string' && record.id.trim()) return record.id;
    return null;
}

function upsertProjectedMessage(
    state: VoiceTranscriptStateLike,
    conversationSessionId: string,
    message: NormalizedMessage,
    text: string,
    turn: VoiceTranscriptTurn | null,
    replaceExisting: boolean,
): UpsertProjectedMessageResult {
    const existingMessages = readStoredSessionMessages(state as any, conversationSessionId);
    const existing = existingMessages.find((candidate: unknown) => {
        const candidateRecord = readRecord(candidate);
        return (
            candidateRecord?.id === message.id
            || candidateRecord?.localId === message.localId
            || messageMatchesTurn(candidate, text, turn)
            || messageMatchesProvisionalTurn(candidate, conversationSessionId, text, turn)
        );
    });
    if (existing) {
        const existingRecord = readRecord(existing);
        if (messageMatchesProvisionalTurn(existing, conversationSessionId, text, turn)) {
            promoteProvisionalMessage(existing, message);
            return {
                message,
                appliedNew: false,
                reconciledProvisionalId: readProvisionalRecordId(readRecord(existing)),
            };
        }
        if (replaceExisting && readProjectedMessageText(existingRecord ?? {}) !== text) {
            const replacement = typeof existingRecord?.createdAt === 'number' && Number.isFinite(existingRecord.createdAt)
                ? { ...message, createdAt: existingRecord.createdAt } as NormalizedMessage
                : message;
            state.applyMessages?.(conversationSessionId, [replacement]);
            return { message: replacement, appliedNew: false, reconciledProvisionalId: null };
        }
        return { message, appliedNew: false, reconciledProvisionalId: null };
    }
    state.applyMessagesLoaded?.(conversationSessionId);
    state.applyMessages?.(conversationSessionId, [message]);
    return { message, appliedNew: true, reconciledProvisionalId: null };
}

export function createVoiceTranscriptProjector(deps: VoiceTranscriptProjectorDeps) {
    const nowMs = deps.nowMs ?? (() => Date.now());
    const maxCanonicalConversations = Number.isFinite(deps.maxCanonicalConversations)
        ? Math.max(1, Math.floor(deps.maxCanonicalConversations ?? VOICE_TRANSCRIPT_SELECTOR_CACHE_MAX))
        : VOICE_TRANSCRIPT_SELECTOR_CACHE_MAX;
    let localProjectionSequence = 0;
    let lastLocalProjectionCreatedAt = Number.NEGATIVE_INFINITY;
    const pendingCanonicalPersistenceByRow = new Map<string, Promise<void>>();

    const canonicalPersistenceRowKey = (input: Readonly<{
        sessionId: string;
        localId: string;
    }>): string => `${input.sessionId.length}:${input.sessionId}${input.localId}`;

    const persistCanonicalFinal = (input: PersistSessionTranscriptMessageInput): void => {
        if (!deps.persistFinal) return;
        const rowKey = canonicalPersistenceRowKey(input);
        const invoke = (): Promise<void> => {
            try {
                return Promise.resolve(deps.persistFinal?.(input)).then(() => undefined);
            } catch (error) {
                return Promise.reject(error);
            }
        };
        const previous = pendingCanonicalPersistenceByRow.get(rowKey);
        const pending = previous
            ? previous.catch(() => undefined).then(invoke)
            : invoke();
        pendingCanonicalPersistenceByRow.set(rowKey, pending);
        void pending.then(
            () => {
                if (pendingCanonicalPersistenceByRow.get(rowKey) === pending) {
                    pendingCanonicalPersistenceByRow.delete(rowKey);
                }
            },
            () => {
                if (pendingCanonicalPersistenceByRow.get(rowKey) === pending) {
                    pendingCanonicalPersistenceByRow.delete(rowKey);
                }
            },
        );
        fireAndForget(pending, { tag: 'VoiceTranscriptProjector.persistFinal' });
    };

    /**
     * In-memory ring of still-unreconciled (provisional/ephemeral) projection ids.
     * Reconciled ephemerals are retired immediately when their canonical turn lands
     * (see {@link upsertProjectedMessage}'s `reconciledProvisionalId`); this ring only
     * bounds the still-pending set, retiring the oldest once it exceeds the cap so a
     * long call cannot grow the unreconciled set without bound.
     */
    const unreconciledProjectionIds: string[] = [];

    const retireUnreconciledProjection = (provisionalId: string | null): void => {
        if (!provisionalId) return;
        const index = unreconciledProjectionIds.indexOf(provisionalId);
        if (index >= 0) unreconciledProjectionIds.splice(index, 1);
    };

    const trackUnreconciledProjection = (provisionalId: string | null): void => {
        if (!provisionalId) return;
        unreconciledProjectionIds.push(provisionalId);
        while (unreconciledProjectionIds.length > VOICE_TRANSCRIPT_UNRECONCILED_EVENT_RING_MAX) {
            unreconciledProjectionIds.shift();
        }
    };

    const projectTextMessage = (params: Readonly<{
        conversationSessionId: string;
        text: string;
        role: 'user' | 'assistant' | 'note';
        turn?: VoiceTranscriptTurn | null;
        canonicalItem?: Pick<
            CanonicalVoiceTranscriptItem,
            'attemptIdentity' | 'itemId' | 'revision'
        > | null;
        source?: RealtimeConversationTurnSource;
    }>): NormalizedMessage | null => {
        const conversationSessionId = normalizeNonEmptyString(params.conversationSessionId);
        const text = normalizeText(params.text);
        if (!conversationSessionId || !text) return null;
        const turn = params.turn ?? null;
        const createdAt = turn?.ts ?? Math.max(nowMs(), lastLocalProjectionCreatedAt + 1);
        if (!turn) lastLocalProjectionCreatedAt = createdAt;
        const localSequence = turn ? null : ++localProjectionSequence;
        const canonicalItem = params.canonicalItem ?? null;
        const id = canonicalItem && params.role !== 'note'
            ? deriveCanonicalVoiceTranscriptEntryId({
                attemptIdentity: canonicalItem.attemptIdentity,
                itemId: canonicalItem.itemId,
                role: params.role,
            })
            : deriveVoiceTranscriptOptimisticId({
                conversationSessionId,
                role: params.role,
                text,
                turn,
                localSequence,
            });
        const message: NormalizedMessage = params.role === 'user'
            ? {
                id,
                localId: id,
                createdAt,
                isSidechain: false,
                role: 'user',
                content: { type: 'text', text },
                ...(
                    canonicalItem
                        ? { meta: buildRealtimeConversationTurnMeta(params.source) }
                        : buildVoiceTurnMeta(turn)
                            ? { meta: buildVoiceTurnMeta(turn) }
                            : {}
                ),
            }
            : {
                id,
                localId: id,
                createdAt,
                isSidechain: false,
                role: 'agent',
                content: [{ type: 'text', text, uuid: id, parentUUID: null }],
                ...(
                    canonicalItem
                        ? { meta: buildRealtimeConversationTurnMeta(params.source) }
                        : params.role === 'note'
                        ? { meta: buildVoiceTranscriptNoteMeta() }
                        : buildVoiceTurnMeta(turn)
                            ? { meta: buildVoiceTurnMeta(turn) }
                            : {}
                ),
        };
        if (canonicalItem && params.role !== 'note' && deps.persistFinal) {
            persistCanonicalFinal({
                sessionId: conversationSessionId,
                localId: id,
                createdAt: message.createdAt,
                rawRecord: buildRealtimeConversationRawRecord({
                    id,
                    role: params.role,
                    text,
                    source: params.source,
                }),
                messageRole: params.role === 'user' ? 'user' : 'agent',
            });
            return message;
        }
        const result = upsertProjectedMessage(
            deps.getState(),
            conversationSessionId,
            message,
            text,
            turn,
            canonicalItem !== null,
        );

        // Retire any provisional projection that this canonical turn reconciled, and
        // track a freshly applied unreconciled (no-turn) projection in the bounded ring.
        retireUnreconciledProjection(result.reconciledProvisionalId);
        if (result.appliedNew && !turn) {
            trackUnreconciledProjection(message.localId ?? message.id ?? null);
        }
        return result.message;
    };

    const EMPTY_CANONICAL_ITEMS: readonly CanonicalVoiceTranscriptItem[] = Object.freeze([]);
    const canonicalProjectors = new Map<string, ReturnType<typeof createCanonicalVoiceTranscriptProjector>>();
    const canonicalSnapshots = new Map<string, readonly CanonicalVoiceTranscriptItem[]>();
    const canonicalListeners = new Map<string, Set<() => void>>();
    const canonicalSourceByConversation = new Map<string, RealtimeConversationTurnSource>();

    const publishCanonicalSnapshot = (conversationSessionId: string): void => {
        const projector = canonicalProjectors.get(conversationSessionId);
        const next = projector?.snapshot() ?? EMPTY_CANONICAL_ITEMS;
        canonicalSnapshots.set(conversationSessionId, next);
        for (const listener of canonicalListeners.get(conversationSessionId) ?? []) listener();
    };

    const evictInactiveCanonicalProjector = (): boolean => {
        for (const conversationSessionId of canonicalProjectors.keys()) {
            if ((canonicalListeners.get(conversationSessionId)?.size ?? 0) > 0) continue;
            canonicalProjectors.delete(conversationSessionId);
            canonicalSnapshots.delete(conversationSessionId);
            canonicalSourceByConversation.delete(conversationSessionId);
            return true;
        }
        return false;
    };
    const getCanonicalProjector = (conversationSessionId: string) => {
        const existing = canonicalProjectors.get(conversationSessionId);
        if (existing) {
            canonicalProjectors.delete(conversationSessionId);
            canonicalProjectors.set(conversationSessionId, existing);
            return existing;
        }
        const created = createCanonicalVoiceTranscriptProjector({
            persistFinal: (item) => {
                projectTextMessage({
                    conversationSessionId,
                    text: item.text,
                    role: item.role,
                    canonicalItem: item,
                    source: canonicalSourceByConversation.get(conversationSessionId),
                });
            },
        });
        canonicalProjectors.set(conversationSessionId, created);
        canonicalSnapshots.set(conversationSessionId, EMPTY_CANONICAL_ITEMS);
        while (canonicalProjectors.size > maxCanonicalConversations) {
            if (!evictInactiveCanonicalProjector()) break;
        }
        return created;
    };

    return {
        projectUserText: (params: Readonly<{ conversationSessionId: string; text: string; turn?: VoiceTranscriptTurn | null }>) =>
            projectTextMessage({ ...params, role: 'user' }),
        projectAssistantText: (params: Readonly<{ conversationSessionId: string; text: string; turn?: VoiceTranscriptTurn | null }>) =>
            projectTextMessage({ ...params, role: 'assistant' }),
        projectNoteText: (params: Readonly<{ conversationSessionId: string; text: string }>) =>
            projectTextMessage({ ...params, role: 'note' }),
        projectCanonicalEvent: (params: Readonly<{
            conversationSessionId: string;
            event: VoiceTranscriptCanonicalEventV1;
            source?: RealtimeConversationTurnSource;
        }>) => {
            if (params.source) {
                canonicalSourceByConversation.set(params.conversationSessionId, params.source);
            } else {
                canonicalSourceByConversation.delete(params.conversationSessionId);
            }
            const result = getCanonicalProjector(params.conversationSessionId).project(params.event);
            if (result.status === 'applied') publishCanonicalSnapshot(params.conversationSessionId);
            return result;
        },
        beginCanonicalAttempt: (conversationSessionId: string): number => {
            const epoch = getCanonicalProjector(conversationSessionId).beginAttempt();
            publishCanonicalSnapshot(conversationSessionId);
            return epoch;
        },
        resetCanonicalEpoch: (conversationSessionId: string, epoch: number): boolean => {
            const reset = getCanonicalProjector(conversationSessionId).resetEpoch(epoch);
            if (reset) {
                publishCanonicalSnapshot(conversationSessionId);
            }
            return reset;
        },
        releaseCanonicalConversation: (conversationSessionId: string): void => {
            const listeners = canonicalListeners.get(conversationSessionId);
            canonicalProjectors.delete(conversationSessionId);
            canonicalSnapshots.delete(conversationSessionId);
            canonicalListeners.delete(conversationSessionId);
            canonicalSourceByConversation.delete(conversationSessionId);
            for (const listener of listeners ?? []) listener();
        },
        canonicalSnapshot: (conversationSessionId: string): readonly CanonicalVoiceTranscriptItem[] => {
            const existing = canonicalProjectors.get(conversationSessionId);
            if (!existing) return EMPTY_CANONICAL_ITEMS;
            canonicalProjectors.delete(conversationSessionId);
            canonicalProjectors.set(conversationSessionId, existing);
            return canonicalSnapshots.get(conversationSessionId) ?? EMPTY_CANONICAL_ITEMS;
        },
        subscribeCanonical: (conversationSessionId: string, listener: () => void): (() => void) => {
            let listeners = canonicalListeners.get(conversationSessionId);
            if (!listeners) {
                listeners = new Set();
                canonicalListeners.set(conversationSessionId, listeners);
            }
            listeners.add(listener);
            return () => {
                const current = canonicalListeners.get(conversationSessionId);
                current?.delete(listener);
                if (current?.size === 0) canonicalListeners.delete(conversationSessionId);
            };
        },
        canonicalProjectorCount: (): number => canonicalProjectors.size,
        /**
         * Count of still-unreconciled in-memory projections (bounded by
         * {@link VOICE_TRANSCRIPT_UNRECONCILED_EVENT_RING_MAX}). Exposed for the
         * perf-bound regression test and ring observability.
         */
        unreconciledProjectionCount: (): number => unreconciledProjectionIds.length,
    };
}

export const voiceTranscriptProjector = createVoiceTranscriptProjector({
    getState: () => storage.getState() as VoiceTranscriptStateLike,
    persistFinal: (input) => import('@/sync/sync')
        .then(({ sync }) => sync.persistSessionTranscriptMessage(input))
        .then(() => undefined),
});
