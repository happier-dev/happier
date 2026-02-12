export function normalizeBaseUrl(url: string): string {
  const trimmed = String(url ?? '').trim();
  if (!trimmed) return '';

  // Treat base URLs as origins/paths, not full request URLs (strip hash/query).
  // This avoids generating routes like `https://host/path?x=y/v1/features`.
  const withoutFragment = trimmed.split('#', 1)[0] ?? trimmed;
  const withoutQuery = withoutFragment.split('?', 1)[0] ?? withoutFragment;
  return withoutQuery.replace(/\/+$/, '');
}

export async function withAbortTimeout<T>(
  timeoutMs: number,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1_000, timeoutMs));
  try {
    return await run(controller.signal);
  } finally {
    clearTimeout(timeout);
  }
}
