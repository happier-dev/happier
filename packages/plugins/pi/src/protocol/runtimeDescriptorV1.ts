type PiAgentRuntimeDescriptorAgentPayload = Readonly<{
  resumeStrategy: 'sessionFileBySessionId' | 'sessionFileAbsolutePreferred';
  providerSessionId?: string;
  vendorSessionId?: string; // legacy vendorSessionId read-compat
  sessionFile?: string;
}>;

export type PiAgentRuntimeDescriptorV1 = Readonly<{
  v: 1;
  agentId: 'pi';
  agent: PiAgentRuntimeDescriptorAgentPayload;
} & Record<string, unknown>>;

export type CanonicalPiAgentRuntimeDescriptorV1 = Readonly<{
  agentId: 'pi';
  resumeStrategy: 'sessionFileBySessionId' | 'sessionFileAbsolutePreferred' | null;
  providerSessionId: string | null;
  sessionFile: string | null;
}>;

function normalizeTrimmedString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readAgentIdCompat(record: Readonly<Record<string, unknown>>): string | null {
  const hasAgentId = Object.hasOwn(record, 'agentId');
  const hasProviderId = Object.hasOwn(record, 'providerId');
  const agentId = normalizeTrimmedString(record.agentId);
  const providerId = normalizeTrimmedString(record.providerId);
  if ((hasAgentId && !agentId) || (hasProviderId && !providerId)) return null;
  if (agentId && providerId && agentId !== providerId) return null;
  return agentId ?? providerId;
}

function readProviderSessionIdCompat(record: Readonly<Record<string, unknown>>): string | null {
  return normalizeTrimmedString(record.providerSessionId)
    ?? normalizeTrimmedString(record.vendorSessionId); // legacy vendorSessionId read-compat
}

export function buildPiAgentRuntimeDescriptorV1(params: Readonly<{
  resumeStrategy: 'sessionFileBySessionId' | 'sessionFileAbsolutePreferred';
  providerSessionId?: string | null;
  sessionFile?: string | null;
}>): PiAgentRuntimeDescriptorV1 {
  return {
    v: 1,
    agentId: 'pi',
    agent: {
      resumeStrategy: params.resumeStrategy,
      ...(params.providerSessionId ? { providerSessionId: params.providerSessionId } : {}),
      ...(params.sessionFile ? { sessionFile: params.sessionFile } : {}),
    },
  };
}

export function readCanonicalPiAgentRuntimeDescriptorV1(
  descriptor: unknown,
): CanonicalPiAgentRuntimeDescriptorV1 | null {
  const record = asRecord(descriptor);
  if (!record || record.v !== 1 || readAgentIdCompat(record) !== 'pi') return null;
  const agentPayload = asRecord(record.agent) ?? asRecord(record.provider); // legacy `provider` payload-key read-compat
  if (!agentPayload) return null;

  return {
    agentId: 'pi',
    resumeStrategy: agentPayload.resumeStrategy === 'sessionFileBySessionId'
      || agentPayload.resumeStrategy === 'sessionFileAbsolutePreferred'
      ? agentPayload.resumeStrategy
      : null,
    providerSessionId: readProviderSessionIdCompat(agentPayload),
    sessionFile: normalizeTrimmedString(agentPayload.sessionFile),
  };
}
