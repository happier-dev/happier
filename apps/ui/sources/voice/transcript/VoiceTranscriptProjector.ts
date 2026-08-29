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

import {
    readStoredSessionMessages,
    type SessionMessagesStateLike,
} from '@/sync/domains/messages/readStoredSessionMessages';
import type { PersistSessionTranscriptMessageInput } from '@/sync/domains/messages/persistSessionTranscriptMessage';
import { storage } from '@/sync/domains/state/storage';
import type { NormalizedMessage, RawRecord } from '@/sync/typesRaw';
import { fireAndForget } from '@/utils/system/fireAndForget';
import {
    readSafeVoiceRuntimeFailureCode,
    recordVoiceRuntimeFailure,
} from '@/voice/runtime/voiceRuntimeFailureCode';
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
    type CanonicalVoiceTranscriptAttempt,
    type CanonicalVoiceTranscriptPersistenceAdmission,
    type CanonicalVoiceTranscriptItem,
    isCanonicalVoiceTranscriptPersistenceEvent,
} from './canonicalProjector';
export { deriveCanonicalVoiceTranscriptEntryId } from './canonicalProjector';

type VoiceTranscriptStateLike = Readonly<{
    sessionMessages?: Record<string, SessionMessagesStateLike<unknown>>;
    applyMessagesLoaded?: (sessionId: string) => void;
    applyMessages?: (sessionId: string, messages: NormalizedMessage[]) => void;
}>;

type VoiceTranscriptProjectorDeps = Readonly<{
    getState: () => VoiceTranscriptStateLike;
    persistFinal?: (input: PersistSessionTranscriptMessageInput) => void | Promise<unknown>;
    nowMs?: () => number;
    maxCanonicalConversations?: number;
}>;

export type RealtimeConversationTurnSource =
    NonNullable<Extract<
        ConversationTurnOriginV1,
        { channel: 'realtime_conversation' }
    >['source']>;

/** Opaque exact persistence-event custody owned by this canonical transcript projector. */
declare const admittedCanonicalVoiceTranscriptPersistenceEvent: unique symbol;
export type AdmittedCanonicalVoiceTranscriptPersistenceEvent = Readonly<{
    readonly [admittedCanonicalVoiceTranscriptPersistenceEvent]: true;
}>;

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

export function buildRealtimeConversationTurnMeta(
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

export function buildRealtimeConversationRawRecord(params: Readonly<{
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
    const existingMessages = readStoredSessionMessages(state, conversationSessionId);
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
    // The server assigns transcript sequence in request-arrival order, so one
    // attempt-local tail must order every final row, not only corrections that
    // share a local id. Keeping only the tail also bounds projector bookkeeping
    // while End Voice can still drain exactly the attempt it releases.
    const pendingCanonicalPersistenceTailByAttempt = new Map<string, Promise<void>>();

    const canonicalPersistenceAttemptKey = (input: Readonly<{
        sessionId: string;
        attemptIdentity: string;
    }>): string => `${input.sessionId.length}:${input.sessionId}${input.attemptIdentity}`;

    const persistCanonicalFinal = (
        input: PersistSessionTranscriptMessageInput,
        attemptIdentity: string,
        source?: RealtimeConversationTurnSource | null,
    ): void => {
        if (!deps.persistFinal) return;
        const attemptKey = canonicalPersistenceAttemptKey({
            sessionId: input.sessionId,
            attemptIdentity,
        });
        const invoke = (): Promise<void> => {
            try {
                return Promise.resolve(deps.persistFinal?.(input)).then(() => undefined);
            } catch (error) {
                return Promise.reject(error);
            }
        };
        const previous = pendingCanonicalPersistenceTailByAttempt.get(attemptKey);
        const pending = previous
            ? previous.catch(() => undefined).then(invoke)
            : invoke();
        pendingCanonicalPersistenceTailByAttempt.set(attemptKey, pending);
        const retireSettledTail = (): void => {
            if (pendingCanonicalPersistenceTailByAttempt.get(attemptKey) === pending) {
                pendingCanonicalPersistenceTailByAttempt.delete(attemptKey);
            }
        };
        void pending.then(
            retireSettledTail,
            retireSettledTail,
        );
        fireAndForget(pending, {
            tag: 'VoiceTranscriptProjector.persistFinal',
            // A rejected write leaves no row anywhere: a canonical final is never
            // projected optimistically, so the authoritative turn simply vanishes.
            onError: (error) => nameCanonicalTranscriptDrop(
                input.sessionId,
                'transcript_persist_failed',
                readSafeVoiceRuntimeFailureCode(error) ?? 'voice_transcript_persist_failed',
                source,
            ),
        });
    };

    const settleCanonicalAttempt = async (input: Readonly<{
        conversationSessionId: string;
        attemptIdentity: string;
    }>): Promise<void> => {
        const attemptKey = canonicalPersistenceAttemptKey({
            sessionId: input.conversationSessionId,
            attemptIdentity: input.attemptIdentity,
        });
        for (;;) {
            const admittedTail = pendingCanonicalPersistenceTailByAttempt.get(attemptKey);
            if (!admittedTail) return;
            // Loop so a same-attempt final admitted while the observed tail is
            // settling is included without waiting on another attempt.
            await Promise.allSettled([admittedTail]);
            if (pendingCanonicalPersistenceTailByAttempt.get(attemptKey) === admittedTail) {
                pendingCanonicalPersistenceTailByAttempt.delete(attemptKey);
                return;
            }
        }
    };

    const settleAdmittedCanonicalPersistence = async (input: Readonly<{
        conversationSessionId: string;
        attemptIdentity: string;
    }>): Promise<void> => {
        const attemptKey = canonicalPersistenceAttemptKey({
            sessionId: input.conversationSessionId,
            attemptIdentity: input.attemptIdentity,
        });
        // Capture the tail synchronously after projection. Later finals must not
        // indefinitely postpone an identity notification for the row whose
        // persistence was already admitted.
        const admittedTail = pendingCanonicalPersistenceTailByAttempt.get(attemptKey);
        if (!admittedTail) return;
        await Promise.allSettled([admittedTail]);
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
        source?: RealtimeConversationTurnSource | null;
    }>): NormalizedMessage | null => {
        const conversationSessionId = normalizeNonEmptyString(params.conversationSessionId);
        const text = normalizeText(params.text);
        if (!conversationSessionId || !text) {
            // An authoritative final with no text is the last silent way a turn
            // can vanish: no row is written and no other owner observes it.
            if (conversationSessionId && params.canonicalItem && params.role !== 'note') {
                nameCanonicalTranscriptDrop(
                    conversationSessionId,
                    'transcript_final_text_empty',
                    'voice_transcript_final_text_empty',
                    params.source,
                );
            }
            return null;
        }
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
                        ? { meta: buildRealtimeConversationTurnMeta(params.source ?? undefined) }
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
                        ? { meta: buildRealtimeConversationTurnMeta(params.source ?? undefined) }
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
                    source: params.source ?? undefined,
                }),
                messageRole: params.role === 'user' ? 'user' : 'agent',
            }, canonicalItem.attemptIdentity, params.source);
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
    const canonicalAttemptByConversation = new Map<string, CanonicalVoiceTranscriptAttempt>();
    type AdmittedCanonicalPersistenceEvent = Readonly<{
        canonicalAdmission: CanonicalVoiceTranscriptPersistenceAdmission;
        conversationSessionId: string;
        projector: ReturnType<typeof createCanonicalVoiceTranscriptProjector>;
        sourceKey: string;
        source: RealtimeConversationTurnSource | null;
    }>;
    const admittedCanonicalPersistenceEvents = new WeakMap<
        AdmittedCanonicalVoiceTranscriptPersistenceEvent,
        AdmittedCanonicalPersistenceEvent
    >();
    // Commit temporarily projects the admission's exact captured source onto
    // its durable row identity so the synchronous low-level persistence
    // callback cannot accidentally read a newer generation's mutable source.
    // Keeping this scoped to commit also lets a pending final and correction
    // share one row without overwriting each other's custody.
    const admittedCanonicalPersistenceEventSourceByKey = new Map<
        string,
        RealtimeConversationTurnSource | null
    >();
    const admittedCanonicalPersistenceEventSourceKey = (
        conversationSessionId: string,
        item: Pick<CanonicalVoiceTranscriptItem, 'attemptIdentity' | 'itemId' | 'role'>,
    ): string => `${conversationSessionId.length}:${conversationSessionId}${deriveCanonicalVoiceTranscriptEntryId({
        attemptIdentity: item.attemptIdentity,
        itemId: item.itemId,
        role: item.role,
    })}`;
    /**
     * Guards already named for the current attempt of each conversation.
     *
     * A refused or unwritable authoritative final repeats for every later event
     * of the same turn, so the record is bounded to one line per guard per
     * attempt — the same discipline the provider runtime uses — and is cleared
     * when the next attempt begins.
     */
    const namedCanonicalDropsByConversation = new Map<string, Set<string>>();

    /**
     * Name an authoritative transcript event this owner refused or failed to
     * write. Nothing else observes these outcomes: a rejected projection and a
     * failed write both leave the conversation running with no row and no
     * distinction from a provider that never spoke.
     */
    const nameCanonicalTranscriptDrop = (
        conversationSessionId: string,
        kind: string,
        reason: string,
        sourceOverride?: RealtimeConversationTurnSource | null,
    ): void => {
        let named = namedCanonicalDropsByConversation.get(conversationSessionId);
        if (!named) {
            named = new Set();
            namedCanonicalDropsByConversation.set(conversationSessionId, named);
        }
        if (named.has(kind)) return;
        named.add(kind);
        const source = sourceOverride === undefined
            ? canonicalSourceByConversation.get(conversationSessionId)
            : sourceOverride;
        recordVoiceRuntimeFailure(
            source ? `${source.pluginId}/${source.contributionId}` : 'voice.transcript',
            'transcript_dropped',
            kind,
            reason,
        );
    };

    const sourceForCanonicalItem = (
        conversationSessionId: string,
        item: CanonicalVoiceTranscriptItem,
    ): RealtimeConversationTurnSource | null | undefined => {
        const sourceKey = admittedCanonicalPersistenceEventSourceKey(conversationSessionId, item);
        return admittedCanonicalPersistenceEventSourceByKey.has(sourceKey)
            ? admittedCanonicalPersistenceEventSourceByKey.get(sourceKey) ?? null
            : canonicalSourceByConversation.get(conversationSessionId);
    };

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
            canonicalAttemptByConversation.delete(conversationSessionId);
            namedCanonicalDropsByConversation.delete(conversationSessionId);
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
                    source: sourceForCanonicalItem(conversationSessionId, item),
                });
            },
            onDiagnostic: (diagnostic) => {
                nameCanonicalTranscriptDrop(
                    conversationSessionId,
                    `transcript_projection_${diagnostic.code}`,
                    'voice_transcript_projection_rejected',
                );
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
            if (result.status === 'applied') {
                if (result.item) {
                    canonicalAttemptByConversation.set(params.conversationSessionId, Object.freeze({
                        epoch: result.item.epoch,
                        attemptIdentity: result.item.attemptIdentity,
                    }));
                }
                publishCanonicalSnapshot(params.conversationSessionId);
            }
            return result;
        },
        admitCanonicalPersistenceEvent: (params: Readonly<{
            conversationSessionId: string;
            event: VoiceTranscriptCanonicalEventV1;
            source?: RealtimeConversationTurnSource;
        }>): AdmittedCanonicalVoiceTranscriptPersistenceEvent | null => {
            if (!isCanonicalVoiceTranscriptPersistenceEvent(params.event)) return null;
            if (params.source) {
                canonicalSourceByConversation.set(params.conversationSessionId, params.source);
            } else {
                canonicalSourceByConversation.delete(params.conversationSessionId);
            }
            const projector = getCanonicalProjector(params.conversationSessionId);
            const canonicalAdmission = projector.admitPersistenceEvent(params.event);
            if (!canonicalAdmission) return null;
            const attempt = projector.currentAttempt();
            if (!attempt || attempt.epoch !== params.event.epoch) {
                projector.releaseAdmittedPersistenceEvent(canonicalAdmission);
                return null;
            }
            const sourceKey = admittedCanonicalPersistenceEventSourceKey(
                params.conversationSessionId,
                {
                    attemptIdentity: attempt.attemptIdentity,
                    itemId: params.event.itemId,
                    role: params.event.role,
                },
            );
            const admission = Object.freeze({}) as AdmittedCanonicalVoiceTranscriptPersistenceEvent;
            admittedCanonicalPersistenceEvents.set(admission, Object.freeze({
                canonicalAdmission,
                conversationSessionId: params.conversationSessionId,
                projector,
                sourceKey,
                source: params.source ?? null,
            }));
            return admission;
        },
        commitAdmittedCanonicalPersistenceEvent: (
            admission: AdmittedCanonicalVoiceTranscriptPersistenceEvent,
        ): string | null => {
            const admitted = admittedCanonicalPersistenceEvents.get(admission);
            if (!admitted) return null;
            const hadPreviousSource = admittedCanonicalPersistenceEventSourceByKey.has(admitted.sourceKey);
            const previousSource = admittedCanonicalPersistenceEventSourceByKey.get(admitted.sourceKey);
            admittedCanonicalPersistenceEventSourceByKey.set(admitted.sourceKey, admitted.source);
            try {
                const committed = admitted.projector.commitAdmittedPersistenceEvent(
                    admitted.canonicalAdmission,
                );
                if (!committed) return null;
                if (
                    committed.appliedToCurrentSnapshot
                    && canonicalProjectors.get(admitted.conversationSessionId) === admitted.projector
                ) {
                    canonicalAttemptByConversation.set(admitted.conversationSessionId, Object.freeze({
                        epoch: committed.item.epoch,
                        attemptIdentity: committed.item.attemptIdentity,
                    }));
                    publishCanonicalSnapshot(admitted.conversationSessionId);
                }
                return deriveCanonicalVoiceTranscriptEntryId({
                    attemptIdentity: committed.item.attemptIdentity,
                    itemId: committed.item.itemId,
                    role: committed.item.role,
                });
            } finally {
                admittedCanonicalPersistenceEvents.delete(admission);
                if (hadPreviousSource) {
                    admittedCanonicalPersistenceEventSourceByKey.set(
                        admitted.sourceKey,
                        previousSource ?? null,
                    );
                } else {
                    admittedCanonicalPersistenceEventSourceByKey.delete(admitted.sourceKey);
                }
            }
        },
        releaseAdmittedCanonicalPersistenceEvent: (
            admission: AdmittedCanonicalVoiceTranscriptPersistenceEvent,
        ): boolean => {
            const admitted = admittedCanonicalPersistenceEvents.get(admission);
            if (!admitted) return false;
            admittedCanonicalPersistenceEvents.delete(admission);
            return admitted.projector.releaseAdmittedPersistenceEvent(admitted.canonicalAdmission);
        },
        beginCanonicalAttempt: (conversationSessionId: string): CanonicalVoiceTranscriptAttempt => {
            const attempt = getCanonicalProjector(conversationSessionId).beginAttempt();
            namedCanonicalDropsByConversation.delete(conversationSessionId);
            canonicalAttemptByConversation.set(conversationSessionId, attempt);
            publishCanonicalSnapshot(conversationSessionId);
            return attempt;
        },
        resetCanonicalEpoch: (conversationSessionId: string, epoch: number): boolean => {
            const projector = getCanonicalProjector(conversationSessionId);
            const reset = projector.resetEpoch(epoch);
            if (reset) {
                const attempt = projector.currentAttempt();
                if (attempt) canonicalAttemptByConversation.set(conversationSessionId, attempt);
                publishCanonicalSnapshot(conversationSessionId);
            }
            return reset;
        },
        releaseCanonicalConversation: async (
            conversationSessionId: string,
            attemptIdentity: string,
        ): Promise<boolean> => {
            await settleCanonicalAttempt({ conversationSessionId, attemptIdentity });
            if (
                canonicalAttemptByConversation.get(conversationSessionId)?.attemptIdentity
                !== attemptIdentity
            ) {
                return false;
            }
            const listeners = canonicalListeners.get(conversationSessionId);
            canonicalProjectors.delete(conversationSessionId);
            canonicalSnapshots.delete(conversationSessionId);
            canonicalListeners.delete(conversationSessionId);
            canonicalSourceByConversation.delete(conversationSessionId);
            canonicalAttemptByConversation.delete(conversationSessionId);
            namedCanonicalDropsByConversation.delete(conversationSessionId);
            for (const listener of listeners ?? []) listener();
            return true;
        },
        settleAdmittedCanonicalPersistence,
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
    getState: () => storage.getState(),
    persistFinal: (input) => import('@/sync/sync')
        .then(({ sync }) => sync.persistSessionTranscriptMessage(input))
        .then(() => undefined),
});
