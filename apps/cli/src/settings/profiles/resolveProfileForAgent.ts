import { AGENT_IDS, type AgentId } from '@happier-dev/agents';
import { buildBackendTargetKey, isProfileCompatibleWithAgent, isProfileCompatibleWithBackendTarget, resolveBackendProfile, type AIBackendProfile, type BackendTargetRefV1 } from '@happier-dev/protocol';

function formatCandidatesList(candidates: ReadonlyArray<Readonly<{ id: string; name: string }>>): string {
  return candidates.map((c) => `${c.id} (${c.name})`).join(', ');
}

export function resolveProfileForAgent(params: Readonly<{
  agentId: AgentId;
  query: string;
  customProfiles: ReadonlyArray<AIBackendProfile>;
}>): AIBackendProfile {
  return resolveProfileForBackendTarget({ backendTarget: { kind: 'builtInAgent', agentId: params.agentId }, query: params.query, customProfiles: params.customProfiles });
}

export function resolveProfileForBackendTarget(params: Readonly<{
  backendTarget: BackendTargetRefV1;
  query: string;
  customProfiles: ReadonlyArray<AIBackendProfile>;
}>): AIBackendProfile {
  const resolved = resolveBackendProfile({ query: params.query, customProfiles: params.customProfiles });
  if (!resolved.ok) {
    if (resolved.reason === 'ambiguous_name') {
      throw new Error(
        `Ambiguous profile name "${params.query}". Matches: ${formatCandidatesList(resolved.candidates)}. Use --profile <id>.`,
      );
    }
    throw new Error(`Unknown profile "${params.query}". Run "happier profiles list" to see available profiles.`);
  }

  assertProfileCompatibleWithBackendTarget(resolved.profile, params.backendTarget);
  return resolved.profile;
}

export function assertProfileCompatibleWithBackendTarget(profile: AIBackendProfile, backendTarget: BackendTargetRefV1): void {
  if (isProfileCompatibleWithBackendTarget(profile, backendTarget)) return;

  const supportedAgentIds = AGENT_IDS.filter((agentId) => isProfileCompatibleWithAgent(profile, agentId));
  const supportedList = supportedAgentIds.length > 0 ? supportedAgentIds.join(', ') : '(none)';
  const firstSuggestion = supportedAgentIds.length > 0 ? supportedAgentIds[0] : null;
  const hint = firstSuggestion
    ? ` Try: happier ${firstSuggestion} --profile ${profile.id}`
    : '';
  const label = backendTarget.kind === 'builtInAgent' ? backendTarget.agentId : buildBackendTargetKey(backendTarget);
  throw new Error(`Profile "${profile.name}" (${profile.id}) is not compatible with ${label}. Supported agents: ${supportedList}.${hint}`);
}
