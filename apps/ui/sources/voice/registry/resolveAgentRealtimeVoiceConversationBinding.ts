import type { VoiceMachineErrorKind } from '@/voice/runtime/machine/voiceConversationRuntimeTypes';
import type { VoiceAdapterConversationBinding } from '@/voice/session/types';

export type AgentRealtimeContributionRef = Readonly<{
  pluginId: string;
  localId: string;
}>;

/**
 * Why an Agent-realtime Voice conversation could not be bound.
 *
 * These are exactly the canonical Voice machine-error kinds, which is also the
 * daemon's own `AgentSessionRealtimeInspectResultV1` `reason` vocabulary. Naming
 * the decline in that vocabulary is what keeps the answer typed end to end: the
 * runtime's failure-code-to-kind conversion maps it losslessly, so each cause
 * keeps its own remediation policy and its own translated copy instead of
 * collapsing into the generic `voice_connection_failed` bucket. Declaring it as
 * a subset of {@link VoiceMachineErrorKind} makes any future protocol reason
 * without a machine kind a compile error rather than a silent generic failure.
 */
export type AgentRealtimeVoiceBindingDeclineCode = Extract<
  VoiceMachineErrorKind,
  | 'authentication_required'
  | 'session_unavailable'
  | 'unsupported_runtime'
  | 'update_required'
  | 'feature_unavailable'
>;

/**
 * Whether an Agent-realtime conversation can be bound to a session, and — when
 * it cannot — the typed cause.
 *
 * `code: null` is the deliberate "no typed answer exists" case: the inspect RPC
 * never returned, its result did not parse, or the daemon refused without
 * classifying itself. Those remain the generic unknown-host-error fallback
 * rather than being given an invented reason.
 */
export type AgentRealtimeSessionAvailability =
  | Readonly<{ available: true }>
  | Readonly<{ available: false; code: AgentRealtimeVoiceBindingDeclineCode | null }>;

type InspectAgentRealtimeSession = (input: Readonly<{
  sessionId: string;
  provider: AgentRealtimeContributionRef;
  agent: AgentRealtimeContributionRef;
}>) => Promise<AgentRealtimeSessionAvailability>;

/**
 * Sole conversion from a typed binding decline to the error the Voice runtime
 * reads. The controller recovers a Start failure code from `error.code`, so the
 * typed reason survives only when it is carried there.
 */
function agentRealtimeVoiceBindingDeclined(
  code: AgentRealtimeVoiceBindingDeclineCode,
): Error & Readonly<{ code: AgentRealtimeVoiceBindingDeclineCode }> {
  return Object.assign(new Error(code), { code });
}

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
  const bind = (conversationSessionId: string): VoiceAdapterConversationBinding =>
    Object.freeze({
      conversationSessionId,
      transcriptMode: 'native_session' as const,
      targetSessionId: input.requestedTargetSessionId,
    });
  const settle = (
    conversationSessionId: string,
    availability: AgentRealtimeSessionAvailability,
  ): VoiceAdapterConversationBinding | null => {
    if (availability.available) return bind(conversationSessionId);
    if (availability.code) throw agentRealtimeVoiceBindingDeclined(availability.code);
    return null;
  };

  if (input.controlSessionId !== input.globalSessionId) {
    return settle(input.controlSessionId, await input.inspect({
      sessionId: input.controlSessionId,
      provider: input.provider,
      agent: input.agent,
    }));
  }

  const conversationSessionId = await input.ensureGlobalConversation({
    agent: input.agent,
    // Reuse is a yes/no question about a candidate the caller may replace, not
    // a Start refusal: an unusable candidate means "make another one".
    isReusableSession: async ({ sessionId }) => (await input.inspect({
      sessionId,
      provider: input.provider,
      agent: input.agent,
    })).available,
  });
  return settle(conversationSessionId, await input.inspect({
    sessionId: conversationSessionId,
    provider: input.provider,
    agent: input.agent,
  }));
}
