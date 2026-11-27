
/** Action identity leaf: schema modules and the registry share these constants. */
export const USAGE_SOURCE_DISCOVER_ACTION_ID = 'usage.sources.discover' as const;
export const USAGE_SOURCE_GET_ACTION_ID = 'usage.sources.get' as const;
export const USAGE_SOURCE_DISMISS_ACTION_ID = 'usage.sources.dismiss' as const;
/** V1 source operations are closed at every boundary; package SemVer is independent. */
export const USAGE_SOURCE_ACTION_IDS = [
  USAGE_SOURCE_DISCOVER_ACTION_ID, USAGE_SOURCE_GET_ACTION_ID, USAGE_SOURCE_DISMISS_ACTION_ID,
  'usage.sources.consent.set', 'usage.sources.stop', 'usage.sources.root.set', 'usage.sources.history.delete',
] as const;
