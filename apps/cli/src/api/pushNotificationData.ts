function normalizeServerUrl(raw: string): string | null {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return null;
  return trimmed.replace(/\/+$/, '');
}

export function withServerUrlInPushData(params: Readonly<{
  baseUrl: string;
  data?: Record<string, unknown> | undefined;
}>): Record<string, unknown> {
  const normalizedBase = normalizeServerUrl(params.baseUrl);
  const input = params.data ?? {};
  if (!normalizedBase) return { ...input };

  const existingRaw = typeof (input as any).serverUrl === 'string'
    ? String((input as any).serverUrl)
    : typeof (input as any).server === 'string'
      ? String((input as any).server)
      : '';
  const normalizedExisting = normalizeServerUrl(existingRaw);

  // If caller already provided a matching serverUrl, preserve it (but normalize).
  if (normalizedExisting && normalizedExisting === normalizedBase) {
    const { server, serverUrl, ...rest } = input as any;
    return { ...rest, serverUrl: normalizedBase };
  }

  const { server, serverUrl, ...rest } = input as any;
  return { ...rest, serverUrl: normalizedBase };
}

