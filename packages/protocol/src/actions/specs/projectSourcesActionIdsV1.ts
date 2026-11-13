
/** Action identity leaf: schema modules and the registry share these constants. */
export const PROJECT_SOURCE_READ_ACTION_ID_V1 = 'projects.sources.read';
export const PROJECT_SOURCE_UPDATE_ACTION_ID_V1 = 'projects.sources.update';
export const PROJECT_SOURCE_MOVE_TO_TEAM_ACTION_ID_V1 = 'projects.sources.moveToTeam';
export const PROJECT_SOURCE_ACTION_IDS_V1 = [
  'projects.sources.list', PROJECT_SOURCE_READ_ACTION_ID_V1, 'projects.sources.create',
  PROJECT_SOURCE_UPDATE_ACTION_ID_V1, 'projects.sources.delete', PROJECT_SOURCE_MOVE_TO_TEAM_ACTION_ID_V1,
  'projects.deploymentDefaults.set',
] as const;

export function isProjectSourceActionIdV1(value: unknown): value is typeof PROJECT_SOURCE_ACTION_IDS_V1[number] {
  return typeof value === 'string' && PROJECT_SOURCE_ACTION_IDS_V1.some(actionId => actionId === value);
}
