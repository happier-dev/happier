import type { ElevenLabsPreparedSession } from './sessionTypes.js';
import type { VoiceHostedConversationService } from '@happier-dev/plugin-sdk/voice/client';

type ActiveSession = Readonly<{
  controlSessionId: string;
  conversationId: string;
  attemptId: number;
  prepared: ElevenLabsPreparedSession;
}>;

export function createElevenLabsSessionLifecycle(input: Readonly<{
  takeHostedConversation: (
    leaseId: string,
  ) => Pick<VoiceHostedConversationService, 'complete' | 'abort'> | null;
  forgetHostedConversation?(leaseId: string): void;
}>) {
  let active: ActiveSession | null = null;
  const preparedHostedConversations = new Map<
    number,
    Readonly<{ service: Pick<VoiceHostedConversationService, 'complete' | 'abort'>; leaseId: string | null }>
  >();

  const preparing = (attemptId: number, service: VoiceHostedConversationService | null): void => {
    if (service) preparedHostedConversations.set(attemptId, { service, leaseId: null });
  };

  const forget = (attemptId: number): void => {
    const entry = preparedHostedConversations.get(attemptId);
    if (entry?.leaseId) input.forgetHostedConversation?.(entry.leaseId);
    preparedHostedConversations.delete(attemptId);
    if (active?.attemptId === attemptId) active = null;
  };

  const prepared = (attemptId: number, session: ElevenLabsPreparedSession): void => {
    const state = session.sessionState;
    if (state.billingMode !== 'happier' || !state.leaseId) return;
    const hostedConversation = preparedHostedConversations.get(attemptId)?.service
      ?? input.takeHostedConversation(state.leaseId);
    if (hostedConversation) preparedHostedConversations.set(attemptId, { service: hostedConversation, leaseId: state.leaseId });
  };

  const releasePrepared = async (
    attemptId: number,
    session?: ElevenLabsPreparedSession,
  ): Promise<void> => {
    const state = session?.sessionState;
    const hostedConversation = preparedHostedConversations.get(attemptId)?.service
      ?? (state?.billingMode === 'happier' && state.leaseId ? input.takeHostedConversation(state.leaseId) : null);
    await hostedConversation?.abort();
    forget(attemptId);
  };

  const started = (next: ActiveSession): void => {
    if (active && active.attemptId !== next.attemptId) throw new Error('elevenlabs_hosted_settlement_pending');
    active = next;
  };

  const ended = async (): Promise<void> => {
    const endedSession = active;
    if (!endedSession) {
      for (const [attemptId] of preparedHostedConversations) await releasePrepared(attemptId);
      return;
    }
    const state = endedSession.prepared.sessionState;
    if (state.billingMode !== 'happier' || !state.leaseId) {
      if (active === endedSession) active = null;
      return;
    }
    const hostedConversation = preparedHostedConversations.get(endedSession.attemptId)?.service
      ?? input.takeHostedConversation(state.leaseId);
    if (!hostedConversation) throw new Error('elevenlabs_hosted_settlement_unavailable');
    preparedHostedConversations.set(endedSession.attemptId, { service: hostedConversation, leaseId: state.leaseId });
    await hostedConversation.complete({ providerConversationId: endedSession.conversationId });
    forget(endedSession.attemptId);
  };

  return Object.freeze({ preparing, prepared, releasePrepared, started, ended });
}

export type ElevenLabsSessionLifecycle = ReturnType<typeof createElevenLabsSessionLifecycle>;
