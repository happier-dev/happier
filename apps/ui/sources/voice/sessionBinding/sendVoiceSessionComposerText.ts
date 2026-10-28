import type { VoiceAdapterController } from '@/voice/session/types';
import { randomUUID } from '@/platform/randomUUID';
import { sync } from '@/sync/sync';
import type { PendingMessageEnqueueResultV2 } from '@/sync/engine/pending/pendingQueueV2';
import { isRpcMethodNotAvailableError } from '@happier-dev/protocol/rpcErrors';

import { voiceSessionBindingStore } from './voiceSessionBindingStore';
import { resolveVoiceSessionComposerRouting } from './voiceSessionComposerRouting';

export type VoiceTextTurnPendingPort = Readonly<{
  enqueuePendingMessage: (params: Readonly<{
    conversationSessionId: string;
    text: string;
    localId: string;
  }>) => Promise<PendingMessageEnqueueResultV2>;
  blockPendingDelivery: (params: Readonly<{
    conversationSessionId: string;
    localId: string;
    reason: 'provider_unavailable_before_acceptance' | 'delivery_outcome_uncertain';
  }>) => Promise<void>;
  markPendingDeliveryHandled: (params: Readonly<{
    conversationSessionId: string;
    localId: string;
  }>) => Promise<void>;
}>;

export type DurableVoiceTextTurnResult =
  | {
      ok: true;
      localId: string;
      disposition: 'pending' | 'settled' | 'handoff_acknowledged' | 'ambiguous';
      message?: string;
    }
  | {
      ok: false;
      reason: 'send_failed' | 'terminal_rejected' | 'cancelled';
      localId: string;
      message?: string;
    };

export const voiceTextTurnPendingPort: VoiceTextTurnPendingPort = {
  enqueuePendingMessage: async ({ conversationSessionId, text, localId }) =>
    await sync.enqueuePendingMessage(conversationSessionId, text, undefined, undefined, {
      localId,
      deliveryMode: 'external_handoff',
      requestedAction: { v: 1, kind: 'send_now' },
    }),
  blockPendingDelivery: async ({ conversationSessionId, localId, reason }) =>
    await sync.blockPendingDelivery(conversationSessionId, localId, reason),
  markPendingDeliveryHandled: async ({ conversationSessionId, localId }) =>
    await sync.markPendingDeliveryHandled(conversationSessionId, localId),
};

export async function submitDurableVoiceTextTurn(params: Readonly<{
  conversationSessionId: string;
  text: string;
  localId?: string;
  pendingPort?: VoiceTextTurnPendingPort;
  dispatch: (params: Readonly<{
    localId: string;
    handoffMode: 'interrupt_and_send';
  }>) => Promise<void>;
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
      ...(error instanceof Error && error.message.trim().length > 0 ? { message: error.message } : {}),
    };
  }

  if (enqueueResult.localId !== localId) {
    return {
      ok: false,
      reason: 'send_failed',
      localId,
      message: 'voice_pending_local_id_mismatch',
    };
  }
  if (enqueueResult.cancelled === true) {
    return { ok: false, reason: 'cancelled', localId };
  }
  if (enqueueResult.settled === true) {
    return { ok: true, localId, disposition: 'settled' };
  }
  if (enqueueResult.terminal === true) {
    return enqueueResult.accepted
      ? { ok: true, localId, disposition: 'settled' }
      : {
          ok: false,
          reason: 'terminal_rejected',
          localId,
        };
  }
  if (enqueueResult.accepted === false) {
    return { ok: true, localId, disposition: 'pending' };
  }
  if (enqueueResult.externalHandoffClaimed !== true) {
    return {
      ok: false,
      reason: 'send_failed',
      localId,
      message: 'voice_pending_external_handoff_not_claimed',
    };
  }

  let handoffAcknowledged = false;
  try {
    await params.dispatch({ localId, handoffMode: 'interrupt_and_send' });
    handoffAcknowledged = true;
    // External voice handoffs have no runner claim to settle. Reuse the Pending
    // owner to commit the user transcript and retire this exact row atomically.
    await pendingPort.markPendingDeliveryHandled({
      conversationSessionId: params.conversationSessionId,
      localId,
    });
  } catch (error) {
    const providerEffectIsDefinitelyFalse = !handoffAcknowledged && isRpcMethodNotAvailableError(error);
    const message = error instanceof Error && error.message.trim().length > 0
      ? error.message
      : undefined;
    try {
      await pendingPort.blockPendingDelivery({
        conversationSessionId: params.conversationSessionId,
        localId,
        reason: providerEffectIsDefinitelyFalse
          ? 'provider_unavailable_before_acceptance'
          : 'delivery_outcome_uncertain',
      });
    } catch (settlementError) {
      if (providerEffectIsDefinitelyFalse) {
        return {
          ok: false,
          reason: 'send_failed',
          localId,
          message: settlementError instanceof Error && settlementError.message.trim().length > 0
            ? settlementError.message
            : message,
        };
      }
    }
    if (providerEffectIsDefinitelyFalse) {
      return {
        ok: false,
        reason: 'send_failed',
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
  | {
      ok: false;
      reason: 'not_voice_session' | 'adapter_unavailable' | 'send_failed' | 'terminal_rejected' | 'cancelled';
      localId?: string;
      message?: string;
    }
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
    dispatch: async ({ localId, handoffMode }) => {
      await adapter.sendTextTurn!({
        controlSessionId: routing.binding.controlSessionId,
        conversationSessionId: routing.binding.conversationSessionId,
        text: params.text,
        localId,
        handoffMode,
      });
    },
  });
}
