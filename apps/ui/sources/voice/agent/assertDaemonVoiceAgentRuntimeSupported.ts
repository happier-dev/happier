import type { FeatureDecision } from '@happier-dev/protocol';
import { resolveRuntimeFeatureDecision } from '@/sync/domains/features/featureDecisionInputs';
import { storage } from '@/sync/domains/state/storage';

type DaemonVoiceAgentUnavailableReason = Readonly<{
  /** Local voice error code rendered by `formatLocalVoiceErrorMessage`. */
  localVoiceErrorCode: string;
  /** Developer-facing detail; the localized text comes from the error code. */
  detail: string | null;
}>;

function resolveDaemonVoiceAgentUnavailableReason(decision: FeatureDecision): DaemonVoiceAgentUnavailableReason {
  if (decision.blockedBy === 'local_policy' && decision.blockerCode === 'flag_disabled') {
    return {
      localVoiceErrorCode: 'voice_agent_feature_disabled',
      detail: 'enable Settings > Features > Experimental > Voice agent before starting local voice.',
    };
  }
  if (decision.blockedBy === 'dependency' && decision.blockerCode === 'dependency_disabled') {
    if (decision.diagnostics.includes('dependency:execution.runs:disabled')) {
      return {
        localVoiceErrorCode: 'voice_agent_requires_subagents',
        detail: 'enable Settings > Features > Experimental > Subagents before starting local voice.',
      };
    }
    if (decision.diagnostics.includes('dependency:voice:disabled')) {
      return {
        localVoiceErrorCode: 'voice_agent_requires_voice',
        detail: 'enable Settings > Features > Experimental > Voice before starting local voice.',
      };
    }
  }
  return { localVoiceErrorCode: 'voice_agent_unavailable', detail: null };
}

export async function assertDaemonVoiceAgentRuntimeSupported(): Promise<void> {
  const decision = await resolveRuntimeFeatureDecision({
    featureId: 'voice.agent',
    settings: (storage.getState() as any).settings,
  });
  if (decision.state === 'enabled') return;

  const reason = resolveDaemonVoiceAgentUnavailableReason(decision);
  const message = reason.detail
    ? `voice_agent_daemon_backend_unavailable: ${reason.detail}`
    : 'voice_agent_daemon_backend_unavailable';
  throw Object.assign(new Error(message), {
    code: 'VOICE_AGENT_RUNTIME_UNAVAILABLE',
    featureDecision: decision,
    localVoiceErrorCode: reason.localVoiceErrorCode,
  });
}
