export type CodexRuntimeQuotaProbeSupport =
  | Readonly<{ supported: true }>
  | Readonly<{
    supported: false;
    reason: 'codex_quota_probe_unsupported_for_backend_mode';
  }>;

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function resolveCodexRuntimeQuotaProbeSupport(selection: unknown): CodexRuntimeQuotaProbeSupport {
  const record = readRecord(selection);
  const provider = readRecord(record?.provider);
  const backendMode = readString(record?.backendMode ?? provider?.backendMode);
  if (backendMode && backendMode !== 'appServer') {
    return {
      supported: false,
      reason: 'codex_quota_probe_unsupported_for_backend_mode',
    };
  }
  return { supported: true };
}
