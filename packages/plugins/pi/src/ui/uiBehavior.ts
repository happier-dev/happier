function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function normalizeString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function readRuntimeDescriptorProvider(metadata: unknown, providerId: string): Record<string, unknown> | null {
  const record = asRecord(metadata);
  const descriptor = asRecord(record?.runtimeDescriptorV1) ?? asRecord(record?.agentRuntimeDescriptorV1);
  if (!descriptor || descriptor.v !== 1 || descriptor.agentId !== providerId) return null;
  return asRecord(descriptor.agent) ?? asRecord(descriptor.provider); // legacy `provider` payload-key read-compat
}

function createSessionArtifactPathResolver(opts: Readonly<{
  providerId: string;
  descriptorField: string;
  legacyMetadataField: string;
}>): (metadata: unknown) => string | null {
  return (metadata) => {
    const provider = readRuntimeDescriptorProvider(metadata, opts.providerId);
    const record = asRecord(metadata);
    if (provider) {
      return normalizeString(provider[opts.descriptorField])
        ?? normalizeString(record?.[opts.legacyMetadataField]);
    }
    const hasForeignDescriptor = asRecord(record?.runtimeDescriptorV1) ?? asRecord(record?.agentRuntimeDescriptorV1);
    if (hasForeignDescriptor) return null;
    return normalizeString(record?.[opts.legacyMetadataField]);
  };
}

const resolvePiSessionArtifactPath = createSessionArtifactPathResolver({
  providerId: 'pi',
  descriptorField: 'sessionFile',
  legacyMetadataField: 'piSessionFile',
});

export const PI_UI_BEHAVIOR_OVERRIDE = Object.freeze({
  debug: {
    resolveProviderSessionArtifactPath: ({ metadata }: { metadata: unknown }) => resolvePiSessionArtifactPath(metadata),
  },
});
