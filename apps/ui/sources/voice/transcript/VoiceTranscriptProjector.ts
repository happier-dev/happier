import {
    deriveVoiceAgentTurnLocalId,
    deriveVoiceAgentTurnProvisionalLocalId,
    readVoiceAgentTurnPayloadFromMeta,
    readVoiceAgentTurnProvisionalLocalId,
    type VoiceAgentTurnV1,
} from '@happier-dev/protocol';

import { readStoredSessionMessages } from '@/sync/domains/messages/readStoredSessionMessages';
import { storage } from '@/sync/domains/state/storage';
import type { NormalizedMessage } from '@/sync/typesRaw';
import { normalizeNonEmptyString } from '@/voice/shared/normalizeNonEmptyString';
import { VOICE_TRANSCRIPT_UNRECONCILED_EVENT_RING_MAX } from './voiceTranscriptBounds';
import type { VoiceTranscriptTurn } from './voiceTranscriptEvents';
import { buildVoiceTranscriptNoteMeta } from './voiceTranscriptNoteMeta';

type VoiceTranscriptStateLike = Readonly<{
    sessionMessages?: Record<string, Readonly<{ messages?: ReadonlyArray<unknown> }>>;
    applyMessagesLoaded?: (sessionId: string) => void;
    applyMessages?: (sessionId: string, messages: NormalizedMessage[]) => void;
}>;

type VoiceTranscriptProjectorDeps = Readonly<{
    getState: () => VoiceTranscriptStateLike;
    nowMs?: () => number;
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
        if (messageMatchesProvisionalTurn(existing, conversationSessionId, text, turn)) {
            promoteProvisionalMessage(existing, message);
            return {
                message,
                appliedNew: false,
                reconciledProvisionalId: readProvisionalRecordId(readRecord(existing)),
            };
        }
        return { message, appliedNew: false, reconciledProvisionalId: null };
    }
    state.applyMessagesLoaded?.(conversationSessionId);
    state.applyMessages?.(conversationSessionId, [message]);
    return { message, appliedNew: true, reconciledProvisionalId: null };
}

/**
 * Truncate `fullText` to the prefix that was actually heard, snapping back to the
 * nearest preceding word boundary so a partially-spoken word is not surfaced.
 */
export function truncateTextToPlayedBoundary(fullText: string, playedMs: number, spokenDurationMs: number): string {
    if (!Number.isFinite(spokenDurationMs) || spokenDurationMs <= 0) return fullText;
    const fraction = playedMs / spokenDurationMs;
    if (!Number.isFinite(fraction) || fraction >= 1) return fullText;
    if (fraction <= 0) return '';
    const cut = Math.floor(fraction * fullText.length);
    if (cut >= fullText.length) return fullText;
    if (cut <= 0) return '';
    const head = fullText.slice(0, cut);
    const lastBoundary = head.search(/\s+\S*$/);
    const snapped = lastBoundary > 0 ? head.slice(0, lastBoundary) : head;
    return snapped.trimEnd();
}

export function createVoiceTranscriptProjector(deps: VoiceTranscriptProjectorDeps) {
    const nowMs = deps.nowMs ?? (() => Date.now());
    let localProjectionSequence = 0;

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
    }>): NormalizedMessage | null => {
        const conversationSessionId = normalizeNonEmptyString(params.conversationSessionId);
        const text = normalizeText(params.text);
        if (!conversationSessionId || !text) return null;
        const turn = params.turn ?? null;
        const createdAt = turn?.ts ?? nowMs();
        const localSequence = turn ? null : ++localProjectionSequence;
        const id = deriveVoiceTranscriptOptimisticId({
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
                ...(buildVoiceTurnMeta(turn) ? { meta: buildVoiceTurnMeta(turn) } : {}),
            }
            : {
                id,
                localId: id,
                createdAt,
                isSidechain: false,
                role: 'agent',
                content: [{ type: 'text', text, uuid: id, parentUUID: null }],
                ...(
                    params.role === 'note'
                        ? { meta: buildVoiceTranscriptNoteMeta() }
                        : buildVoiceTurnMeta(turn)
                            ? { meta: buildVoiceTurnMeta(turn) }
                            : {}
                ),
            };
        const result = upsertProjectedMessage(deps.getState(), conversationSessionId, message, text, turn);

        // Retire any provisional projection that this canonical turn reconciled, and
        // track a freshly applied unreconciled (no-turn) projection in the bounded ring.
        retireUnreconciledProjection(result.reconciledProvisionalId);
        if (result.appliedNew && !turn) {
            trackUnreconciledProjection(message.localId ?? message.id ?? null);
        }
        return result.message;
    };

    return {
        projectUserText: (params: Readonly<{ conversationSessionId: string; text: string; turn?: VoiceTranscriptTurn | null }>) =>
            projectTextMessage({ ...params, role: 'user' }),
        projectAssistantText: (params: Readonly<{ conversationSessionId: string; text: string; turn?: VoiceTranscriptTurn | null }>) =>
            projectTextMessage({ ...params, role: 'assistant' }),
        projectNoteText: (params: Readonly<{ conversationSessionId: string; text: string }>) =>
            projectTextMessage({ ...params, role: 'note' }),
        /**
         * Count of still-unreconciled in-memory projections (bounded by
         * {@link VOICE_TRANSCRIPT_UNRECONCILED_EVENT_RING_MAX}). Exposed for the
         * perf-bound regression test and ring observability.
         */
        unreconciledProjectionCount: (): number => unreconciledProjectionIds.length,
        /**
         * Truncate assistant transcript text to the prefix that was actually heard.
         * Method-only hook: barge-in wires this to the real `playedMs` later.
         */
        truncateToPlayedBoundary: (params: Readonly<{ fullText: string; playedMs: number; spokenDurationMs: number }>): string =>
            truncateTextToPlayedBoundary(params.fullText, params.playedMs, params.spokenDurationMs),
    };
}

export const voiceTranscriptProjector = createVoiceTranscriptProjector({
    getState: () => storage.getState() as VoiceTranscriptStateLike,
});
