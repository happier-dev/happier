/** ID-only vocabulary: foundational Action admission must not load payload schemas. */
export const USAGE_HISTORY_ACTION_IDS = { read: 'usage.history.read' } as const;
export const USAGE_PRICE_ACTION_IDS = { get: 'usage.prices.get', refresh: 'usage.prices.refresh' } as const;
export function isUsagePriceActionIdV1(value: string): value is typeof USAGE_PRICE_ACTION_IDS[keyof typeof USAGE_PRICE_ACTION_IDS] {
  return value === USAGE_PRICE_ACTION_IDS.get || value === USAGE_PRICE_ACTION_IDS.refresh;
}
export const USAGE_PUBLIC_RECAP_ACTION_IDS = {
  compose: 'usage.recap.compose', export: 'usage.recap.export', deliver: 'usage.recap.deliver',
} as const;
export const USAGE_PRIVATE_RECAP_ACTION_IDS = {
  compose: 'usage.recap.private.compose', export: 'usage.recap.private.export', deliver: 'usage.recap.private.deliver',
} as const;
export function isUsagePublicRecapActionIdV1(value: string): value is typeof USAGE_PUBLIC_RECAP_ACTION_IDS[keyof typeof USAGE_PUBLIC_RECAP_ACTION_IDS] {
  return value === USAGE_PUBLIC_RECAP_ACTION_IDS.compose || value === USAGE_PUBLIC_RECAP_ACTION_IDS.export
    || value === USAGE_PUBLIC_RECAP_ACTION_IDS.deliver;
}
export function isUsagePrivateRecapActionIdV1(value: string): value is typeof USAGE_PRIVATE_RECAP_ACTION_IDS[keyof typeof USAGE_PRIVATE_RECAP_ACTION_IDS] {
  return value === USAGE_PRIVATE_RECAP_ACTION_IDS.compose || value === USAGE_PRIVATE_RECAP_ACTION_IDS.export
    || value === USAGE_PRIVATE_RECAP_ACTION_IDS.deliver;
}
export const USAGE_ACTION_IDS = ['usage.query', USAGE_HISTORY_ACTION_IDS.read, USAGE_PRICE_ACTION_IDS.get, USAGE_PRICE_ACTION_IDS.refresh,
  'usage.export', 'usage.calendar.export', ...Object.values(USAGE_PUBLIC_RECAP_ACTION_IDS), ...Object.values(USAGE_PRIVATE_RECAP_ACTION_IDS)] as const;
export type UsageActionId = typeof USAGE_ACTION_IDS[number];
export function isUsageActionIdV1(value: string): value is UsageActionId {
  return USAGE_ACTION_IDS.some(id => id === value);
}

export const USAGE_COACH_ACTION_IDS = ['usage.coach.apply', 'usage.coach.undo', 'usage.coach.dismiss', 'usage.coach.snooze'] as const;
export type UsageCoachActionId = typeof USAGE_COACH_ACTION_IDS[number];
