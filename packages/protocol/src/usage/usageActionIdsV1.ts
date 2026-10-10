/** ID-only vocabulary: foundational Action admission must not load payload schemas. */
export const USAGE_ACTION_IDS = ['usage.query', 'usage.prices.get', 'usage.prices.refresh', 'usage.export', 'usage.calendar.export', 'usage.recap.compose', 'usage.recap.export'] as const;
export type UsageActionId = typeof USAGE_ACTION_IDS[number];

export const USAGE_COACH_ACTION_IDS = ['usage.coach.apply', 'usage.coach.undo', 'usage.coach.dismiss', 'usage.coach.snooze'] as const;
export type UsageCoachActionId = typeof USAGE_COACH_ACTION_IDS[number];
