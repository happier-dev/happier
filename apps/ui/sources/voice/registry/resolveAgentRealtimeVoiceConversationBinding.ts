import type { VoiceMachineErrorKind } from '@/voice/runtime/machine/voiceConversationRuntimeTypes';
import type { VoiceAdapterConversationBinding } from '@/voice/session/types';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';

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
  sessionAddress: SessionAddress;
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

/** Exact Session Voice continues that Session; only Global Voice creates another Agent Session. */
export function canAgentRealtimeVoiceStartNewConversation(scope: 'global' | 'session'): boolean {
  return scope === 'global';
}

export async function resolveAgentRealtimeVoiceConversationBinding(input: Readonly<{
  conversationSelection?: import('@/voice/binding/voiceConversationBindingTypes').VoiceConversationSelection;
  onConversationSelection?: (selection: import('@/voice/binding/voiceConversationBindingTypes').VoiceConversationSelection) => void;
  provider: AgentRealtimeContributionRef;
  agent: AgentRealtimeContributionRef;
  controlSessionId: string;
  globalSessionId: string;
  requestedTargetSessionAddress: SessionAddress | null;
  globalConversationServerId: string;
  inspect: InspectAgentRealtimeSession;
  ensureGlobalConversation(input: Readonly<{
    agent: AgentRealtimeContributionRef;
  }>): Promise<string>;
}>): Promise<VoiceAdapterConversationBinding | null> {
  const bind = (conversationSessionAddress: SessionAddress): VoiceAdapterConversationBinding =>
    Object.freeze({
      conversationSessionAddress,
      transcriptMode: 'native_session' as const,
      targetSessionAddress: input.requestedTargetSessionAddress,
    });
  const settle = (
    conversationSessionAddress: SessionAddress,
    availability: AgentRealtimeSessionAvailability,
  ): VoiceAdapterConversationBinding | null => {
    if (availability.available) return bind(conversationSessionAddress);
    if (availability.code) throw agentRealtimeVoiceBindingDeclined(availability.code);
    return null;
  };

  const scope = input.controlSessionId === input.globalSessionId ? 'global' : 'session';
  if (input.conversationSelection?.kind === 'new' && !canAgentRealtimeVoiceStartNewConversation(scope)) {
    throw agentRealtimeVoiceBindingDeclined('unsupported_runtime');
  }
  if (scope === 'session') {
    const conversationSessionAddress = input.requestedTargetSessionAddress;
    if (!conversationSessionAddress || conversationSessionAddress.sessionId !== input.controlSessionId) {
      throw agentRealtimeVoiceBindingDeclined('session_unavailable');
    }
    input.onConversationSelection?.({ kind: 'continue', conversationSessionAddress });
    return settle(conversationSessionAddress, await input.inspect({
      sessionAddress: conversationSessionAddress,
      provider: input.provider,
      agent: input.agent,
    }));
  }

  const conversationSessionId = await input.ensureGlobalConversation({
    agent: input.agent,
  });
  const conversationSessionAddress = {
    serverId: input.globalConversationServerId,
    sessionId: conversationSessionId,
  };
  return settle(conversationSessionAddress, await input.inspect({
    sessionAddress: conversationSessionAddress,
    provider: input.provider,
    agent: input.agent,
  }));
}
