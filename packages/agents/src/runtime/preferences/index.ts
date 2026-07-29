import type { AgentId } from '../../types.js';
import { getAgentCliRuntimeSpec } from '../../cli/runtime.js';
import { getAgentRuntimeKindsManifest } from '../../runtimeKinds.js';
import type { RuntimePreferencesAdapter } from '../adjunctAdapters/types.js';

export {
  CLAUDE_UNIFIED_TERMINAL_RESUME_CHOICES,
  CLAUDE_UNIFIED_TERMINAL_WORKSPACE_TRUST_POLICIES,
  DEFAULT_CLAUDE_UNIFIED_TERMINAL_RESUME_CHOICE,
  DEFAULT_CLAUDE_UNIFIED_TERMINAL_WORKSPACE_TRUST_POLICY,
  normalizeClaudeUnifiedTerminalResumeChoice,
  normalizeClaudeUnifiedTerminalWorkspaceTrustPolicy,
  type ClaudeUnifiedTerminalResumeChoice,
  type ClaudeUnifiedTerminalWorkspaceTrustPolicy,
} from './claude.js';

export function getProviderRuntimePreferencesAdapter(agentId: AgentId): RuntimePreferencesAdapter {
  const runtimeSpec = getAgentCliRuntimeSpec(agentId);
  const defaultRuntimeKind = getAgentRuntimeKindsManifest(agentId)?.defaultKind ?? null;

  return {
    sourcePreference: {
      default: runtimeSpec.sourcePreferenceDefault,
    },
    ...(defaultRuntimeKind ? { defaultRuntimeKind: { default: defaultRuntimeKind } } : {}),
  };
}
