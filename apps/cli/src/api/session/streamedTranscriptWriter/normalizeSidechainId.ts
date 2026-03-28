export function normalizeSidechainId(input: unknown): string | null {
  if (input === null || input === undefined) return null;
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  return trimmed ? trimmed : null;
}
