const DAY_MS = 86_400_000;

export type SessionRetentionRule = Readonly<{
  retentionDays: number;
  floorAt: number;
  noticeDays?: number;
}>;

export function computeSessionLeavesAt(activityMs: number, rule: SessionRetentionRule): number {
  return Math.max(activityMs + rule.retentionDays * DAY_MS, rule.floorAt);
}
