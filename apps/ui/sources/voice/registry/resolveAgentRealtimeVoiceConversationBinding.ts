import type { VoiceAdapterConversationBinding } from '@happier-dev/bundled-voice-runtime-contract';

export type AgentRealtimeContributionRef = Readonly<{
  pluginId: string;
  localId: string;
}>;

type InspectAgentRealtimeSession = (input: Readonly<{
  sessionId: string;
  provider: AgentRealtimeContributionRef;
  agent: AgentRealtimeContributionRef;
}>) => Promise<boolean>;

export async function resolveAgentRealtimeVoiceConversationBinding(input: Readonly<{
  provider: AgentRealtimeContributionRef;
  agent: AgentRealtimeContributionRef;
  controlSessionId: string;
  globalSessionId: string;
  requestedTargetSessionId: string | null;
  inspect: InspectAgentRealtimeSession;
  ensureGlobalConversation(input: Readonly<{
    agent: AgentRealtimeContributionRef;
    isReusableSession(input: Readonly<{ sessionId: string }>): Promise<boolean>;
  }>): Promise<string>;
}>): Promise<VoiceAdapterConversationBinding | null> {
  if (input.controlSessionId !== input.globalSessionId) {
    const available = await input.inspect({
      sessionId: input.controlSessionId,
      provider: input.provider,
      agent: input.agent,
    });
    return available
      ? Object.freeze({
          conversationSessionId: input.controlSessionId,
          transcriptMode: 'native_session' as const,
          targetSessionId: input.requestedTargetSessionId,
        })
      : null;
  }

  const conversationSessionId = await input.ensureGlobalConversation({
    agent: input.agent,
    isReusableSession: ({ sessionId }) => input.inspect({
      sessionId,
      provider: input.provider,
      agent: input.agent,
    }),
  });
  const available = await input.inspect({
    sessionId: conversationSessionId,
    provider: input.provider,
    agent: input.agent,
  });
  return available
    ? Object.freeze({
        conversationSessionId,
        transcriptMode: 'native_session' as const,
        targetSessionId: input.requestedTargetSessionId,
      })
    : null;
}
