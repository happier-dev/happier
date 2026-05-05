export type ResolveManualUnreadCursorBoundaryInput = Readonly<{
  sessionSeq: number | null | undefined;
  lastViewedSessionSeq?: number | null | undefined;
}>;

function normalizeSessionSeq(value: number | null | undefined): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.trunc(value))
    : 0;
}

function normalizeCursor(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.trunc(value))
    : null;
}

export function resolveManualUnreadCursorBoundary(
  input: ResolveManualUnreadCursorBoundaryInput,
): number {
  const lastViewedSessionSeq = normalizeCursor(input.lastViewedSessionSeq);
  if (lastViewedSessionSeq !== null) {
    return lastViewedSessionSeq;
  }

  return Math.max(0, normalizeSessionSeq(input.sessionSeq) - 1);
}
