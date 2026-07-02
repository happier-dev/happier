function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeSafeProviderErrorCode(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!/^[a-z][a-z0-9_.:-]{0,119}$/iu.test(trimmed)) return null;
  if (/\b(?:access|refresh|id)[_-]?token\b|secret|authorization|bearer|credential|password|api[_-]?key/iu.test(trimmed)) {
    return null;
  }
  return trimmed;
}

export function readSafeOauthProviderErrorCode(body: string): string | null {
  const trimmed = body.trim();
  if (!trimmed) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!isRecord(parsed)) return null;
    const error = parsed.error;
    const directErrorCode = normalizeSafeProviderErrorCode(error);
    if (directErrorCode) return directErrorCode;
    if (isRecord(error)) {
      const code = normalizeSafeProviderErrorCode(error.code);
      if (code) return code;
      const type = normalizeSafeProviderErrorCode(error.type);
      if (type) return type;
    }
  } catch {
    return null;
  }
  return null;
}

export function buildSafeOauthProviderFailureMessage(params: Readonly<{
  operation: string;
  status: number;
  statusText?: string;
  body: string;
}>): string {
  const safeError = readSafeOauthProviderErrorCode(params.body) ?? params.statusText ?? 'provider_error';
  return `${params.operation} failed (${params.status}): ${safeError}`;
}
