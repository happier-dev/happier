export const USAGE_PRICE_ACTION_IDS = { get: 'usage.prices.get', refresh: 'usage.prices.refresh' } as const;
export function isUsagePriceActionIdV1(value: string): value is typeof USAGE_PRICE_ACTION_IDS[keyof typeof USAGE_PRICE_ACTION_IDS] {
  return value === USAGE_PRICE_ACTION_IDS.get || value === USAGE_PRICE_ACTION_IDS.refresh;
}
/** ID-only vocabulary: foundational Action admission must not load payload schemas. */
export const USAGE_ACTION_IDS = ['usage.query', USAGE_PRICE_ACTION_IDS.get, USAGE_PRICE_ACTION_IDS.refresh, 'usage.export', 'usage.calendar.export', 'usage.recap.compose', 'usage.recap.export', 'usage.recap.deliver', 'usage.recap.private.compose', 'usage.recap.private.export', 'usage.recap.private.deliver'] as const;
export type UsageActionId = typeof USAGE_ACTION_IDS[number];

export const USAGE_COACH_ACTION_IDS = ['usage.coach.apply', 'usage.coach.undo', 'usage.coach.dismiss', 'usage.coach.snooze'] as const;
export type UsageCoachActionId = typeof USAGE_COACH_ACTION_IDS[number];
