type PiAgentRuntimeDescriptorProvider = Readonly<{
  resumeStrategy: 'sessionFileBySessionId';
  vendorSessionId?: string;
}>;

export type PiAgentRuntimeDescriptorV1 = Readonly<{
  v: 1;
  providerId: 'pi';
  provider: PiAgentRuntimeDescriptorProvider;
} & Record<string, unknown>>;

export type CanonicalPiAgentRuntimeDescriptorV1 = Readonly<{
  providerId: 'pi';
  resumeStrategy: 'sessionFileBySessionId' | null;
  vendorSessionId: string | null;
}>;

function normalizeTrimmedString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

export function buildPiAgentRuntimeDescriptorV1(params: Readonly<{
  resumeStrategy: 'sessionFileBySessionId';
  vendorSessionId?: string | null;
}>): PiAgentRuntimeDescriptorV1 {
  return {
    v: 1,
    providerId: 'pi',
    provider: {
      resumeStrategy: params.resumeStrategy,
      ...(params.vendorSessionId ? { vendorSessionId: params.vendorSessionId } : {}),
    },
  };
}

export function readCanonicalPiAgentRuntimeDescriptorV1(
  descriptor: PiAgentRuntimeDescriptorV1 | null,
): CanonicalPiAgentRuntimeDescriptorV1 | null {
  if (!descriptor) return null;
  return {
    providerId: 'pi',
    resumeStrategy: descriptor.provider.resumeStrategy === 'sessionFileBySessionId'
      ? 'sessionFileBySessionId'
      : null,
    vendorSessionId: normalizeTrimmedString(descriptor.provider.vendorSessionId),
  };
}
