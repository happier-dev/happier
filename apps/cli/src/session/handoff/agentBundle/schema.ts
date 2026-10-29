import { lazyZodSchema } from '@happier-dev/protocol/lazyZodSchema';
import { z } from 'zod/mini';

// Internal (CLI-only) contract for the agent bundle file transferred during session handoff.
// This is intentionally not part of the shared protocol surface.
// Read-compat: pre-rename bundles carry `providerId` (providers-first-class R.17).
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

export const SessionHandoffAgentBundleSchema = lazyZodSchema(() => (<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform(normalizeLegacyAgentBundleIdentity), z.looseObject({
      agentId: z.string().check(z.minLength(1)),
    })));

/**
 * Project the canonical Agent-owned bundle onto the strict predecessor archive wire shape.
 *
 * Provenance: remote-dev 1b32cdc6 and preview 4913c1e used providerId-only archives.
 * Remove after those readers and rollback paths are outside the supported frontier.
 */
export function projectSessionHandoffAgentBundleForPredecessor(
  value: unknown,
): Readonly<Record<string, unknown>> {
  const canonical = SessionHandoffAgentBundleSchema.parse(value);
  const { agentId, providerId: _legacyProviderId, ...payload } = canonical;
  return {
    providerId: agentId,
    ...payload,
  };
}
