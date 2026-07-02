/**
 * GENERATED FILE CONTRACT (A.16y.6-runtime-descriptor-protocol-abi-codegen)
 *
 * This file is emitted by:
 * - `scripts/migrations/extensions/generateBundledPluginEntries.ts`
 */

type PiAgentRuntimeDescriptorProvider = Readonly<{
  resumeStrategy: 'sessionFileBySessionId' | 'sessionFileAbsolutePreferred';
  providerSessionId?: string;
  vendorSessionId?: string;
  sessionFile?: string;
}>;

export type PiAgentRuntimeDescriptorV1 = Readonly<{
  v: 1;
  providerId: 'pi';
  provider: PiAgentRuntimeDescriptorProvider;
} & Record<string, unknown>>;

export type CanonicalPiAgentRuntimeDescriptorV1 = Readonly<{
  providerId: 'pi';
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
    providerId: 'pi',
    provider: {
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
  if (!record || record.v !== 1 || record.providerId !== 'pi') return null;
  const provider = asRecord(record.provider);
  if (!provider) return null;

  return {
    providerId: 'pi',
    resumeStrategy: provider.resumeStrategy === 'sessionFileBySessionId'
      || provider.resumeStrategy === 'sessionFileAbsolutePreferred'
      ? provider.resumeStrategy
      : null,
    providerSessionId: readProviderSessionIdCompat(provider),
    sessionFile: normalizeTrimmedString(provider.sessionFile),
  };
}
