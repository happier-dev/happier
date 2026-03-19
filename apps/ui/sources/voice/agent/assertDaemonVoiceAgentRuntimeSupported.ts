import type { FeatureDecision } from '@happier-dev/protocol';
import { resolveRuntimeFeatureDecision } from '@/sync/domains/features/featureDecisionInputs';
import { storage } from '@/sync/domains/state/storage';

function formatDaemonVoiceAgentUnavailableMessage(decision: FeatureDecision): string {
  if (decision.blockedBy === 'local_policy' && decision.blockerCode === 'flag_disabled') {
    return 'voice_agent_daemon_backend_unavailable: enable the Experimental Features > Voice Agent toggle before starting local voice.';
  }
  if (decision.blockedBy === 'dependency' && decision.blockerCode === 'dependency_disabled') {
    if (decision.diagnostics.includes('dependency:execution.runs:disabled')) {
      return 'voice_agent_daemon_backend_unavailable: enable the Experimental Features > Execution Runs toggle before starting local voice.';
    }
    if (decision.diagnostics.includes('dependency:voice:disabled')) {
      return 'voice_agent_daemon_backend_unavailable: enable the Experimental Features > Voice toggle before starting local voice.';
    }
  }
  return 'voice_agent_daemon_backend_unavailable';
}

export async function assertDaemonVoiceAgentRuntimeSupported(): Promise<void> {
  const decision = await resolveRuntimeFeatureDecision({
    featureId: 'voice.agent',
    settings: (storage.getState() as any).settings,
  });
  if (decision.state === 'enabled') return;

  throw Object.assign(new Error(formatDaemonVoiceAgentUnavailableMessage(decision)), {
    code: 'VOICE_AGENT_RUNTIME_UNAVAILABLE',
    featureDecision: decision,
  });
}
