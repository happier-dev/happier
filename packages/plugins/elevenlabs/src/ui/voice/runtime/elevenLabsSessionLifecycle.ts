import type { ElevenLabsPreparedSession } from './elevenLabsSessionTypes.js';
import type { PluginVoiceHostedConversationService } from '@happier-dev/plugin-sdk/runtime';

type ActiveSession = Readonly<{
  controlSessionId: string;
  conversationId: string;
  attemptId: number;
  prepared: ElevenLabsPreparedSession;
}>;

export function createElevenLabsSessionLifecycle(input: Readonly<{
  takeHostedConversation: (
    leaseId: string,
  ) => Pick<PluginVoiceHostedConversationService, 'complete' | 'abort'> | null;
}>) {
  let active: ActiveSession | null = null;
  const preparedHostedConversations = new Map<
    number,
    Pick<PluginVoiceHostedConversationService, 'complete' | 'abort'>
  >();

  const prepared = (attemptId: number, session: ElevenLabsPreparedSession): void => {
    const state = session.sessionState;
    if (state.billingMode !== 'happier' || !state.leaseId) return;
    const hostedConversation = input.takeHostedConversation(state.leaseId);
    if (hostedConversation) preparedHostedConversations.set(attemptId, hostedConversation);
  };

  const releasePrepared = async (
    attemptId: number,
    session: ElevenLabsPreparedSession,
  ): Promise<void> => {
    const state = session.sessionState;
    if (state.billingMode !== 'happier' || !state.leaseId) return;
    const hostedConversation = preparedHostedConversations.get(attemptId)
      ?? input.takeHostedConversation(state.leaseId);
    preparedHostedConversations.delete(attemptId);
    await hostedConversation?.abort();
  };

  const started = (next: ActiveSession): void => {
    active = next;
  };

  const ended = async (): Promise<void> => {
    const endedSession = active;
    active = null;
    if (!endedSession) {
      const unstarted = [...preparedHostedConversations.values()];
      preparedHostedConversations.clear();
      await Promise.all(unstarted.map(async (conversation) => {
        await conversation.abort();
      }));
      return;
    }
    const state = endedSession.prepared.sessionState;
    if (state.billingMode !== 'happier' || !state.leaseId) return;
    const hostedConversation = preparedHostedConversations.get(endedSession.attemptId)
      ?? input.takeHostedConversation(state.leaseId);
    preparedHostedConversations.delete(endedSession.attemptId);
    try {
      await hostedConversation?.complete({
        providerConversationId: endedSession.conversationId,
      });
    } catch {
      // Provider usage completion is best-effort during teardown. A failed
      // verification write leaves the canonical server lease bounded and
      // conservatively quota-counted.
    }
  };

  return Object.freeze({ prepared, releasePrepared, started, ended });
}

export type ElevenLabsSessionLifecycle = ReturnType<typeof createElevenLabsSessionLifecycle>;
