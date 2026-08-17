import {
    isVoiceTextTurnRejectedBeforeEffectError,
    type VoiceAdapterController,
} from '@/voice/session/types';
import { randomUUID } from '@/platform/randomUUID';
import { sync } from '@/sync/sync';
import type { PendingMessageEnqueueResultV2 } from '@/sync/engine/pending/pendingQueueV2';
import type { PendingDeliveryBlockedReason } from '@happier-dev/protocol';
import {
    buildRealtimeConversationTurnMeta,
    type RealtimeConversationTurnSource,
} from '@/voice/transcript/voiceConversationTranscript';

import { voiceSessionBindingStore } from './voiceConversationBindingStore';
import { resolveVoiceSessionComposerRouting } from './voiceSessionComposerRouting';

export type VoiceTextTurnPendingPort = Readonly<{
    enqueuePendingMessage(params: Readonly<{
        conversationSessionId: string;
        text: string;
        localId: string;
        source?: RealtimeConversationTurnSource;
    }>): Promise<PendingMessageEnqueueResultV2>;
    blockPendingDelivery(params: Readonly<{
        conversationSessionId: string;
        localId: string;
        reason: PendingDeliveryBlockedReason;
    }>): Promise<void>;
    markPendingDeliveryHandled(params: Readonly<{
        conversationSessionId: string;
        localId: string;
    }>): Promise<void>;
}>;

export type DurableVoiceTextTurnResult =
    | Readonly<{
        ok: true;
        localId: string;
        disposition: 'pending' | 'settled' | 'ambiguous';
        message?: string;
    }>
    | Readonly<{
        ok: false;
        reason: 'send_failed' | 'cancelled' | 'terminal_rejected';
        localId: string;
        message?: string;
    }>;

export const voiceTextTurnPendingPort: VoiceTextTurnPendingPort = {
    enqueuePendingMessage: async ({ conversationSessionId, text, localId, source }) =>
        await sync.enqueuePendingMessage(conversationSessionId, text, undefined, buildRealtimeConversationTurnMeta(source), {
            localId,
            deliveryMode: 'external_handoff',
            requestedAction: { v: 1, kind: 'send_now' },
        }),
    blockPendingDelivery: async ({ conversationSessionId, localId, reason }) =>
        await sync.blockPendingDelivery(conversationSessionId, localId, reason),
    markPendingDeliveryHandled: async ({ conversationSessionId, localId }) =>
        await sync.markPendingDeliveryHandled(conversationSessionId, localId),
};

function readVoiceTextTurnErrorMessage(error: unknown): string | undefined {
    return error instanceof Error && error.message.trim() ? error.message : undefined;
}

function combineVoiceTextTurnSettlementError(
    dispatchError: unknown,
    settlementError: unknown,
): string | undefined {
    const dispatchMessage = readVoiceTextTurnErrorMessage(dispatchError);
    const settlementMessage = readVoiceTextTurnErrorMessage(settlementError);
    if (!settlementMessage) return dispatchMessage;
    const settlementDetail = `pending settlement failed: ${settlementMessage}`;
    return dispatchMessage ? `${dispatchMessage}; ${settlementDetail}` : settlementDetail;
}

export async function submitDurableVoiceTextTurn(params: Readonly<{
    conversationSessionId: string;
    text: string;
    localId?: string;
    source?: RealtimeConversationTurnSource;
    pendingPort?: VoiceTextTurnPendingPort;
    dispatch(params: Readonly<{
        localId: string;
        deliveryCommand: 'interrupt_and_send';
        onAccepted(): Promise<void>;
    }>): Promise<void>;
}>): Promise<DurableVoiceTextTurnResult> {
    const requestedLocalId = typeof params.localId === 'string' && params.localId.trim().length > 0
        ? params.localId
        : '';
    const localId = requestedLocalId || randomUUID();
    const pendingPort = params.pendingPort ?? voiceTextTurnPendingPort;
    let enqueueResult: Awaited<ReturnType<VoiceTextTurnPendingPort['enqueuePendingMessage']>>;
    try {
        enqueueResult = await pendingPort.enqueuePendingMessage({
            conversationSessionId: params.conversationSessionId,
            text: params.text,
            localId,
            ...(params.source ? { source: params.source } : {}),
        });
    } catch (error) {
        return {
            ok: false,
            reason: 'send_failed',
            localId,
            ...(error instanceof Error && error.message.trim() ? { message: error.message } : {}),
        };
    }
    if (enqueueResult.localId !== localId) {
        return { ok: false, reason: 'send_failed', localId, message: 'voice_pending_local_id_mismatch' };
    }
    if (enqueueResult.cancelled === true) return { ok: false, reason: 'cancelled', localId };
    if (enqueueResult.terminal === true) {
        return enqueueResult.accepted
            ? { ok: true, localId, disposition: 'settled' }
            : { ok: false, reason: 'terminal_rejected', localId };
    }
    if (enqueueResult.settled === true) return { ok: true, localId, disposition: 'settled' };
    if (enqueueResult.accepted === false) return { ok: true, localId, disposition: 'pending' };
    if (enqueueResult.externalHandoffClaimed !== true) {
        return {
            ok: false,
            reason: 'send_failed',
            localId,
            message: 'voice_pending_external_handoff_not_claimed',
        };
    }

    let acceptanceStarted = false;
    let acceptanceSettled = false;
    let acceptanceSettlementError: unknown;
    let acceptancePromise: Promise<void> | null = null;
    /** Resolves once the durable settlement write finished, success or failure. */
    let acceptanceCompletion: Promise<void> = Promise.resolve();
    const onAccepted = (): Promise<void> => {
        if (acceptancePromise) return acceptancePromise;
        acceptanceStarted = true;
        acceptancePromise = pendingPort.markPendingDeliveryHandled({
            conversationSessionId: params.conversationSessionId,
            localId,
        }).then(() => {
            acceptanceSettled = true;
        }, (error: unknown) => {
            acceptanceSettlementError = error;
            throw error;
        });
        acceptanceCompletion = acceptancePromise.catch(() => undefined);
        return acceptancePromise;
    };

    let dispatchFailure: Readonly<{ error: unknown }> | null = null;
    try {
        await params.dispatch({ localId, deliveryCommand: 'interrupt_and_send', onAccepted });
        if (!acceptanceStarted) throw new Error('voice_turn_acceptance_not_reported');
    } catch (error) {
        dispatchFailure = { error };
    }
    // A dispatcher may acknowledge acceptance without awaiting the durable
    // settlement write (or abandon it on abort), so the write can still be in
    // flight here. Settlement is only known once that write resolved.
    await acceptanceCompletion;

    if (dispatchFailure) {
        const { error } = dispatchFailure;
        if (acceptanceSettled) {
            return {
                ok: true,
                localId,
                disposition: 'settled',
                ...(readVoiceTextTurnErrorMessage(error)
                    ? { message: readVoiceTextTurnErrorMessage(error) }
                    : {}),
            };
        }
        const typedBeforeEffectRejection = isVoiceTextTurnRejectedBeforeEffectError(error)
            ? error
            : null;
        const definiteRejection = typedBeforeEffectRejection !== null;
        let settlementError: unknown;
        try {
            await pendingPort.blockPendingDelivery({
                conversationSessionId: params.conversationSessionId,
                localId,
                reason: typedBeforeEffectRejection?.pendingDeliveryBlockedReason
                    ?? 'delivery_outcome_uncertain',
            });
        } catch (blockError) {
            settlementError = blockError;
        }
        const message = combineVoiceTextTurnSettlementError(error, settlementError);
        if (definiteRejection) {
            return {
                ok: false,
                reason: 'terminal_rejected',
                localId,
                ...(message ? { message } : {}),
            };
        }
        return {
            ok: true,
            localId,
            disposition: 'ambiguous',
            ...(message ? { message } : {}),
        };
    }
    if (!acceptanceSettled) {
        const message = combineVoiceTextTurnSettlementError(undefined, acceptanceSettlementError);
        return {
            ok: true,
            localId,
            disposition: 'ambiguous',
            ...(message ? { message } : {}),
        };
    }
    return { ok: true, localId, disposition: 'settled' };
}

export async function sendVoiceSessionComposerText(params: Readonly<{
    conversationSessionId: string;
    text: string;
    store?: typeof voiceSessionBindingStore;
    sessionMetadata?: unknown;
    getAdapter: (adapterId: string) => VoiceAdapterController | null;
    localId?: string;
    pendingPort?: VoiceTextTurnPendingPort;
}>): Promise<
    | DurableVoiceTextTurnResult
    | { ok: false; reason: 'not_voice_session' | 'adapter_unavailable'; message?: string }
> {
    const routing = resolveVoiceSessionComposerRouting({
        conversationSessionId: params.conversationSessionId,
        store: params.store,
        sessionMetadata: params.sessionMetadata,
    });
    if (!routing) return { ok: false, reason: 'not_voice_session' };

    const adapter = params.getAdapter(routing.binding.adapterId);
    if (!adapter?.sendTextTurn) return { ok: false, reason: 'adapter_unavailable' };

    return await submitDurableVoiceTextTurn({
        conversationSessionId: routing.binding.conversationSessionId,
        text: params.text,
        localId: params.localId,
        ...(adapter.transcriptSource ? { source: adapter.transcriptSource } : {}),
        pendingPort: params.pendingPort,
        dispatch: async ({ localId, deliveryCommand, onAccepted }) => {
            await adapter.sendTextTurn!({
                controlSessionId: routing.binding.controlSessionId,
                conversationSessionId: routing.binding.conversationSessionId,
                text: params.text,
                localId,
                deliveryCommand,
                onAccepted,
            });
        },
    });
}
