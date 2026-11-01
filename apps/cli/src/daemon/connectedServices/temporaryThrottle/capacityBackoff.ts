export function computeCapacityBackoffMs(failureCount: number, random: () => number = Math.random): number {
  const base = Math.min(300_000, 5_000 * (2 ** Math.min(6, Math.max(0, failureCount - 1))));
  const value = Math.min(1, Math.max(0, random()));
  return Math.round(base * (0.8 + value * 0.4));
}
