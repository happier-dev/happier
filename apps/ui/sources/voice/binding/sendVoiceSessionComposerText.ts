import type { VoiceAdapterController } from '@/voice/session/types';
import { randomUUID } from '@/platform/randomUUID';
import { sync } from '@/sync/sync';
import type { PendingMessageEnqueueResultV2 } from '@/sync/engine/pending/pendingQueueV2';
import type { PendingDeliveryBlockedReason } from '@happier-dev/protocol';
import { isRpcMethodNotAvailableError } from '@happier-dev/protocol/rpcErrors';

import { voiceSessionBindingStore } from './voiceConversationBindingStore';
import { resolveVoiceSessionComposerRouting } from './voiceSessionComposerRouting';

export type VoiceTextTurnPendingPort = Readonly<{
    enqueuePendingMessage(params: Readonly<{
        conversationSessionId: string;
        text: string;
        localId: string;
    }>): Promise<PendingMessageEnqueueResultV2>;
    blockPendingDelivery(params: Readonly<{
        conversationSessionId: string;
        localId: string;
        reason: PendingDeliveryBlockedReason;
    }>): Promise<void>;
}>;

export type DurableVoiceTextTurnResult =
    | Readonly<{
        ok: true;
        localId: string;
        disposition: 'pending' | 'settled' | 'handoff_acknowledged' | 'ambiguous';
        message?: string;
    }>
    | Readonly<{
        ok: false;
        reason: 'send_failed' | 'cancelled' | 'terminal_rejected';
        localId: string;
        message?: string;
    }>;

export const voiceTextTurnPendingPort: VoiceTextTurnPendingPort = {
    enqueuePendingMessage: async ({ conversationSessionId, text, localId }) =>
        await sync.enqueuePendingMessage(conversationSessionId, text, undefined, undefined, {
            localId,
            deliveryMode: 'external_handoff',
            requestedAction: { v: 1, kind: 'send_now' },
        }),
    blockPendingDelivery: async ({ conversationSessionId, localId, reason }) =>
        await sync.blockPendingDelivery(conversationSessionId, localId, reason),
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
    pendingPort?: VoiceTextTurnPendingPort;
    dispatch(params: Readonly<{
        localId: string;
        deliveryCommand: 'interrupt_and_send';
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

    try {
        await params.dispatch({ localId, deliveryCommand: 'interrupt_and_send' });
    } catch (error) {
        const definiteRejection = isRpcMethodNotAvailableError(error);
        let settlementError: unknown;
        try {
            await pendingPort.blockPendingDelivery({
                conversationSessionId: params.conversationSessionId,
                localId,
                reason: definiteRejection
                    ? 'provider_unavailable_before_acceptance'
                    : 'delivery_outcome_uncertain',
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
    return { ok: true, localId, disposition: 'handoff_acknowledged' };
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
        pendingPort: params.pendingPort,
        dispatch: async ({ localId, deliveryCommand }) => {
            await adapter.sendTextTurn!({
                controlSessionId: routing.binding.controlSessionId,
                conversationSessionId: routing.binding.conversationSessionId,
                text: params.text,
                localId,
                deliveryCommand,
            });
        },
    });
}
