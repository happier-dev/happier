
/** Action identity leaf: schema modules and the registry share these constants. */
export const LOCAL_CLI_PATH_EXPOSURE_SET_ACTION_ID_V1 = 'machines.local.service.pathExposure.set';
export const LOCAL_DAEMON_SERVICE_ACTION_IDS = [
  'machines.local.service.status', 'machines.local.service.start', 'machines.local.service.stop',
  'machines.local.service.restart', 'machines.local.service.autostart.set',
  'machines.local.service.update', 'machines.local.service.disconnect',
  LOCAL_CLI_PATH_EXPOSURE_SET_ACTION_ID_V1,
] as const;
