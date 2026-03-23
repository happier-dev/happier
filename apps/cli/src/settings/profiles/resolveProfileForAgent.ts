import { AGENT_IDS, type AgentId } from '@happier-dev/agents';
import { isProfileCompatibleWithAgent, resolveBackendProfile, type AIBackendProfile } from '@happier-dev/protocol';

function formatCandidatesList(candidates: ReadonlyArray<Readonly<{ id: string; name: string }>>): string {
  return candidates.map((c) => `${c.id} (${c.name})`).join(', ');
}

export function resolveProfileForAgent(params: Readonly<{
  agentId: AgentId;
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

  const profile = resolved.profile;
  if (isProfileCompatibleWithAgent(profile, params.agentId)) {
    return profile;
  }

  const supportedAgentIds = AGENT_IDS.filter((agentId) => isProfileCompatibleWithAgent(profile, agentId));
  const supportedList = supportedAgentIds.length > 0 ? supportedAgentIds.join(', ') : '(none)';
  const firstSuggestion = supportedAgentIds.length > 0 ? supportedAgentIds[0] : null;
  const hint = firstSuggestion
    ? ` Try: happier ${firstSuggestion} --profile ${profile.id}`
    : '';

  throw new Error(`Profile "${profile.name}" (${profile.id}) is not compatible with ${params.agentId}. Supported agents: ${supportedList}.${hint}`);
}

