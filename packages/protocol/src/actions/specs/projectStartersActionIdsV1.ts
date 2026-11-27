export const PROJECT_STARTER_CREATE_ACTION_ID_V1 = 'projects.starters.create' as const;
export const PROJECT_STARTER_ACTION_IDS_V1 = [PROJECT_STARTER_CREATE_ACTION_ID_V1] as const;

export const PROJECT_STARTER_CHILD_ACTION_IDS_V1 = {
  listStarters: 'registries.items.list',
  readStarter: 'registries.items.read',
  resolveAddress: 'scm.hostingRepository.resolveAddress',
  describePublishTargets: 'scm.hostingRepository.describePublishTargets',
  browseDirectory: 'daemon.filesystem.browseDirectory',
  clone: 'scm.repository.clone',
  createDirectory: 'daemon.filesystem.createDirectory',
  init: 'scm.repository.init',
  publish: 'scm.hostingRepository.publish',
  readSource: 'projects.sources.read',
  saveSource: 'projects.sources.create',
  openProject: 'projects.open',
} as const;
