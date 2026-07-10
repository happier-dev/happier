function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function isUnsupportedProviderSessionStatePublication(error: unknown): boolean {
  if (!isRecord(error)) return false;
  if (error.code !== 'execution_run_session_state_unsupported') return false;
  const result = error.result;
  if (!isRecord(result)) return false;
  return result.reason === 'no_session_target' || result.reason === 'scope_not_supported';
}
