
/** Action identity leaf: schema modules and the registry share these constants. */
export const MACHINE_WORK_SUMMARY_ACTION_IDS = ['machines.work.summary.get'] as const;
export const MACHINE_ACCESS_GRANTS_LIST_ACTION_ID_V1 = 'machines.access.grants.list';
export const MACHINE_ACCESS_GRANT_SET_ACTION_ID_V1 = 'machines.access.grant.set';
export const MACHINE_ACCESS_ACTION_IDS = [
  MACHINE_ACCESS_GRANTS_LIST_ACTION_ID_V1, MACHINE_ACCESS_GRANT_SET_ACTION_ID_V1, 'machines.access.grant.remove',
  'machines.access.leave', 'machines.access.prepareKeys',
] as const;

/** Account HTTP transport also serves presence; permission-management policy keeps its narrower family. */
export const MACHINE_ACCESS_HTTP_ACTION_IDS = [...MACHINE_ACCESS_ACTION_IDS, 'machines.presence.read'] as const;
