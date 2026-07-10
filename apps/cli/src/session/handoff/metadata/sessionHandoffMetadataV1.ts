import type { SessionHandoffMetadataV1 } from '@/api/types';

type SessionHandoffMetadataV1Input = Omit<SessionHandoffMetadataV1, 'v'>;

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function readIdentity(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

export function buildSessionHandoffMetadataV1(
  input: SessionHandoffMetadataV1Input,
): SessionHandoffMetadataV1 {
  return {
    v: 1,
    ...input,
  };
}

/**
 * Reads the canonical handoff agent identity while retaining narrow compatibility with
 * pre-agent-rename local overlays that persisted `providerId`.
 */
export function readSessionHandoffAgentId(value: unknown): string | null {
  const record = asRecord(value);
  if (!record || record.v !== 1) {
    return null;
  }

  const hasAgentId = Object.hasOwn(record, 'agentId');
  const hasProviderId = Object.hasOwn(record, 'providerId');
  const agentId = hasAgentId ? readIdentity(record.agentId) : null;
  const providerId = hasProviderId ? readIdentity(record.providerId) : null;

  if ((hasAgentId && !agentId) || (hasProviderId && !providerId)) {
    return null;
  }
  if (agentId && providerId && agentId !== providerId) {
    return null;
  }

  return agentId ?? providerId;
}
