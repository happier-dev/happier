import type { CanonicalAgentId } from './types.js';
import { AGENT_IDS } from './types.js';
import { AGENTS_CORE } from './manifest.js';
import { resolveLegacyConfiguredBackendCompatAgentIdFromFlavor } from './compat/legacyConfiguredBackend.js';

function normalizeFlavor(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

export function resolveCanonicalAgentIdFromFlavor(flavor: unknown): CanonicalAgentId | null {
  const normalized = normalizeFlavor(flavor);
  if (!normalized) {
    return null;
  }

  if (resolveLegacyConfiguredBackendCompatAgentIdFromFlavor(normalized)) {
    return null;
  }

  for (const id of AGENT_IDS) {
    if (id.toLowerCase() === normalized) {
      return id;
    }
  }

  for (const id of AGENT_IDS) {
    const entry = AGENTS_CORE[id];
    const aliases = 'flavorAliases' in entry ? entry.flavorAliases ?? [] : [];
    if (aliases.some((value: string) => value.trim().toLowerCase() === normalized)) {
      return id;
    }
  }

  return null;
}

export function resolveAgentIdFromFlavor(flavor: unknown): CanonicalAgentId | null {
  const normalized = normalizeFlavor(flavor);
  if (!normalized) {
    return null;
  }

  if (resolveLegacyConfiguredBackendCompatAgentIdFromFlavor(normalized)) {
    return null;
  }

  return resolveCanonicalAgentIdFromFlavor(normalized);
}
