import { z } from 'zod';

// Internal (CLI-only) contract for the agent bundle file transferred during session handoff.
// This is intentionally not part of the shared protocol surface.
// Read-compat: pre-rename bundles carry `providerId` (providers-first-class R.17);
// writes always use `agentId`.
function normalizeLegacyAgentBundleIdentity(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  const normalizeIdentity = (identity: unknown): string | null => {
    if (typeof identity !== 'string') return null;
    const normalized = identity.trim();
    return normalized || null;
  };
  const agentId = normalizeIdentity(record.agentId);
  if (!Object.hasOwn(record, 'providerId')) {
    return agentId ? { ...record, agentId } : undefined;
  }
  const { providerId: legacyProviderId, ...rest } = record;
  const providerId = normalizeIdentity(legacyProviderId);
  if (!providerId || (Object.hasOwn(record, 'agentId') && agentId !== providerId)) {
    return undefined;
  }
  return { ...rest, agentId: agentId ?? providerId };
}

export const SessionHandoffAgentBundleSchema = z.preprocess(
  normalizeLegacyAgentBundleIdentity,
  z
    .object({
      agentId: z.string().min(1),
    })
    .passthrough(),
);
