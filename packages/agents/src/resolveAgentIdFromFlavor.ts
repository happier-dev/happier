import type { AgentId } from './types.js';
import { AGENT_IDS } from './types.js';
import { AGENTS_CORE } from './manifest.js';

export function resolveAgentIdFromFlavor(flavor: unknown): AgentId | null {
  if (typeof flavor !== 'string') return null;

  const normalized = flavor.trim().toLowerCase();
  if (!normalized) return null;

  if (normalized.startsWith('acp:')) {
    return 'customAcp';
  }

  for (const id of AGENT_IDS) {
    if (id.toLowerCase() === normalized) return id;
  }

  for (const id of AGENT_IDS) {
    const aliases = AGENTS_CORE[id].flavorAliases ?? [];
    if (aliases.some((value) => value.trim().toLowerCase() === normalized)) {
      return id;
    }
  }

  return null;
}
