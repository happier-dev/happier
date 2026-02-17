import { DEFAULT_AGENT_ID } from '@happier-dev/agents';
import { isAgentId } from '@/agents/registry/registryCore';
import type { AgentId } from '@/agents/catalog/catalog';

function normalizeNonEmptyString(value: unknown): string | null {
  const text = typeof value === 'string' ? value.trim() : '';
  return text.length > 0 ? text : null;
}

export function resolveSpawnAgentIdFromState(state: any): AgentId {
  const lastUsedAgent = normalizeNonEmptyString(state?.settings?.lastUsedAgent);
  if (lastUsedAgent && isAgentId(lastUsedAgent)) return lastUsedAgent as AgentId;
  return DEFAULT_AGENT_ID as AgentId;
}

