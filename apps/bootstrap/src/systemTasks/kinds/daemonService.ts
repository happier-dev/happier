import { systemTasks } from '@happier-dev/cli-common';

import {
  readDaemonStatus,
  startService,
  restartService,
  stopService,
} from '../localDaemonCli.js';

export function createDaemonServiceStatusHandler() {
  const kind = systemTasks.createDaemonServiceStatusTaskKind({
    readStatus: async () => await readDaemonStatus(),
    startService: async () => await startService(),
    stopService: async () => await stopService(),
    restartService: async () => await restartService(),
  });
  return systemTasks.createExecutionRunnerFromKind(kind);
}

export function createDaemonServiceStartHandler() {
  const kind = systemTasks.createDaemonServiceStartTaskKind({
    readStatus: async () => await readDaemonStatus(),
    startService: async () => await startService(),
    stopService: async () => await stopService(),
    restartService: async () => await restartService(),
  });
  return systemTasks.createExecutionRunnerFromKind(kind);
}

export function createDaemonServiceStopHandler() {
  const kind = systemTasks.createDaemonServiceStopTaskKind({
    readStatus: async () => await readDaemonStatus(),
    startService: async () => await startService(),
    stopService: async () => await stopService(),
    restartService: async () => await restartService(),
  });
  return systemTasks.createExecutionRunnerFromKind(kind);
}

export function createDaemonServiceRestartHandler() {
  const kind = systemTasks.createDaemonServiceRestartTaskKind({
    readStatus: async () => await readDaemonStatus(),
    startService: async () => await startService(),
    stopService: async () => await stopService(),
    restartService: async () => await restartService(),
  });
  return systemTasks.createExecutionRunnerFromKind(kind);
}
