function normalizeEpochMs(value: number): number {
  // Heuristic: tolerate seconds timestamps by converting to ms.
  // (Seconds are ~1e9; ms are ~1e12+.)
  return value < 10_000_000_000 ? value * 1000 : value;
}

export function formatSessionUpdatedAtForCli(updatedAt: number, nowMs: number): string {
  const updatedAtMs = normalizeEpochMs(updatedAt);
  if (!Number.isFinite(updatedAtMs) || updatedAtMs <= 0) return '';

  // If the timestamp is implausibly old/new, prefer an absolute date.
  if (updatedAtMs < 1_000_000_000_000 || updatedAtMs > nowMs + 365 * 24 * 60 * 60_000) {
    try {
      return new Date(updatedAtMs).toISOString().slice(0, 10);
    } catch {
      return String(updatedAt);
    }
  }

  const diffMs = Math.max(0, nowMs - updatedAtMs);
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return `${diffSec}s`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 48) return `${diffHr}h`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d`;
}

export function shortenSessionIdForCli(id: string): string {
  const trimmed = id.trim();
  return trimmed.length <= 12 ? trimmed : trimmed.slice(0, 12);
}

