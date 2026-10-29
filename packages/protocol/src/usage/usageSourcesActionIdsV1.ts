
/** Action identity leaf: schema modules and the registry share these constants. */
/** V1 source operations are closed at every boundary; package SemVer is independent. */
export const USAGE_SOURCE_ACTION_IDS = [
  'usage.sources.discover', 'usage.sources.get', 'usage.sources.dismiss',
  'usage.sources.consent.set', 'usage.sources.stop', 'usage.sources.root.set', 'usage.sources.history.delete',
] as const;
