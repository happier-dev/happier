
/** Action identity leaf: schema modules and the registry share these constants. */
export const PROJECT_SOURCE_READ_ACTION_ID_V1 = 'projects.sources.read';
export const PROJECT_SOURCE_ACTION_IDS_V1 = [
  'projects.sources.list', PROJECT_SOURCE_READ_ACTION_ID_V1, 'projects.sources.create',
  'projects.sources.update', 'projects.sources.delete', 'projects.sources.moveToTeam',
  'projects.deploymentDefaults.set',
] as const;
