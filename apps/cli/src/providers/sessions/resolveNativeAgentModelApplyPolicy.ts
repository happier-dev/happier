import type { ModelSelectionApplyPolicy } from '@happier-dev/protocol';
import type { AgentModelConfig } from '@happier-dev/agents';

export function resolveNativeAgentModelApplyPolicy(
  modelConfig: Pick<
    AgentModelConfig,
    'supportsSelection' | 'nonAcpApplyScope' | 'acpApplyBehavior'
  >,
): Extract<
  ModelSelectionApplyPolicy,
  'live' | 'restart_session' | 'unsupported'
> {
  if (!modelConfig.supportsSelection) return 'unsupported';
  if (
    modelConfig.nonAcpApplyScope === 'spawn_only'
    || modelConfig.acpApplyBehavior === 'restart_session'
  ) {
    return 'restart_session';
  }
  return 'live';
}
