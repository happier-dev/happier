const SAFE_VOICE_RUNTIME_FAILURE_CODE_PATTERN = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/;

export function readSafeVoiceRuntimeFailureCode(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  const code = (error as Readonly<{ code?: unknown }>).code;
  if (typeof code !== 'string') return null;
  const normalized = code.trim();
  return SAFE_VOICE_RUNTIME_FAILURE_CODE_PATTERN.test(normalized) ? normalized : null;
}

export function normalizeVoiceRuntimeFailureCode(code: unknown): string {
  if (typeof code !== 'string') return 'voice_connection_failed';
  const normalized = code.trim();
  return SAFE_VOICE_RUNTIME_FAILURE_CODE_PATTERN.test(normalized)
    ? normalized
    : 'voice_connection_failed';
}
