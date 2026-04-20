function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readLegacyCodexRuntimeAffinityCompatCarrier(
  extra: Record<string, unknown>,
): Record<string, unknown> | null {
  // Delete once persisted/providerExtra carriers no longer need to tolerate
  // the legacy `runtimeAffinity` field name.
  return asRecord(extra.runtimeAffinity);
}

export function readCodexRuntimeHandleCompatCarrier(value: unknown): Record<string, unknown> | null {
  const extra = asRecord(value);
  if (!extra || extra.v !== 1) return null;

  return asRecord(extra.runtimeHandle) ?? readLegacyCodexRuntimeAffinityCompatCarrier(extra);
}
