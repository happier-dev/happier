const ALWAYS_ACP_PROVIDERS = new Set(['auggie', 'qwen', 'kimi', 'kilo', 'gemini', 'copilot']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readProviderIdFromMetadataEntry(metadata: Record<string, unknown>, key: string): string | null {
  const entry = metadata[key];
  if (!isRecord(entry)) return null;
  const provider = entry.provider;
  return typeof provider === 'string' ? provider : null;
}

export function isAcpForkEligibleForProvider(params: Readonly<{ providerId: string; metadata: unknown }>): boolean {
  const providerId = params.providerId.trim();
  if (!providerId) return false;

  if (!isRecord(params.metadata)) return false;
  const metadata = params.metadata;

  // OpenCode has explicit backend modes (server vs ACP).
  if (providerId === 'opencode') {
    return metadata.opencodeBackendMode === 'acp';
  }

  // Providers that are integrated only via ACP today.
  if (ALWAYS_ACP_PROVIDERS.has(providerId)) return true;

  return (
    readProviderIdFromMetadataEntry(metadata, 'acpSessionModesV1') === providerId ||
    readProviderIdFromMetadataEntry(metadata, 'acpSessionModelsV1') === providerId ||
    readProviderIdFromMetadataEntry(metadata, 'acpConfigOptionsV1') === providerId ||
    readProviderIdFromMetadataEntry(metadata, 'acpHistoryImportV1') === providerId
  );
}
