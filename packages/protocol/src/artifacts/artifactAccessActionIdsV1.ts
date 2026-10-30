
/** Action identity leaf: schema modules and the registry share these constants. */
/** Document grant wire epoch V1. Every identity, mutation and nested object is closed. */
export const ARTIFACT_ACCESS_ACTION_IDS_V1 = [
  'artifact.access.grants.list', 'artifact.access.grants.set', 'artifact.access.grants.remove',
] as const;
