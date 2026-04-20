export function isAbortLikeError(error: unknown): boolean {
  if (!error) return false;
  if (typeof error === 'object' && !Array.isArray(error)) {
    const name = (error as { name?: unknown }).name;
    if (typeof name === 'string' && name === 'AbortError') return true;
  }
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const lowered = String(message ?? '').toLowerCase();
  if (!lowered) return false;
  return lowered.includes('abort') || lowered.includes('cancel');
}
