import { systemTasks } from '@happier-dev/cli-common';
import { normalizeBootstrapChannel } from '../taskRuntime.js';

import {
  readDaemonStatus,
  startService,
  restartService,
  stopService,
} from '../localDaemonCli.js';

function resolveReleaseRingFromChannel(channel: unknown) {
  const normalized = String(channel ?? '').trim();
  if (!normalized) return undefined;
  return normalizeBootstrapChannel(normalized).releaseChannel;
}

export function createDaemonServiceStatusHandler() {
  const kind = systemTasks.createDaemonServiceStatusTaskKind({
    readStatus: async (params) => await readDaemonStatus({ releaseRing: resolveReleaseRingFromChannel(params.channel) }),
    startService: async (params) => await startService({ releaseRing: resolveReleaseRingFromChannel(params.channel) }),
    stopService: async (params) => await stopService({ releaseRing: resolveReleaseRingFromChannel(params.channel) }),
    restartService: async (params) => await restartService({ releaseRing: resolveReleaseRingFromChannel(params.channel) }),
  });
  return systemTasks.createExecutionRunnerFromKind(kind);
}

export function createDaemonServiceStartHandler() {
  const kind = systemTasks.createDaemonServiceStartTaskKind({
    readStatus: async (params) => await readDaemonStatus({ releaseRing: resolveReleaseRingFromChannel(params.channel) }),
    startService: async (params) => await startService({ releaseRing: resolveReleaseRingFromChannel(params.channel) }),
    stopService: async (params) => await stopService({ releaseRing: resolveReleaseRingFromChannel(params.channel) }),
    restartService: async (params) => await restartService({ releaseRing: resolveReleaseRingFromChannel(params.channel) }),
  });
  return systemTasks.createExecutionRunnerFromKind(kind);
}

export function createDaemonServiceStopHandler() {
  const kind = systemTasks.createDaemonServiceStopTaskKind({
    readStatus: async (params) => await readDaemonStatus({ releaseRing: resolveReleaseRingFromChannel(params.channel) }),
    startService: async (params) => await startService({ releaseRing: resolveReleaseRingFromChannel(params.channel) }),
    stopService: async (params) => await stopService({ releaseRing: resolveReleaseRingFromChannel(params.channel) }),
    restartService: async (params) => await restartService({ releaseRing: resolveReleaseRingFromChannel(params.channel) }),
  });
  return systemTasks.createExecutionRunnerFromKind(kind);
}

export function createDaemonServiceRestartHandler() {
  const kind = systemTasks.createDaemonServiceRestartTaskKind({
    readStatus: async (params) => await readDaemonStatus({ releaseRing: resolveReleaseRingFromChannel(params.channel) }),
    startService: async (params) => await startService({ releaseRing: resolveReleaseRingFromChannel(params.channel) }),
    stopService: async (params) => await stopService({ releaseRing: resolveReleaseRingFromChannel(params.channel) }),
    restartService: async (params) => await restartService({ releaseRing: resolveReleaseRingFromChannel(params.channel) }),
  });
  return systemTasks.createExecutionRunnerFromKind(kind);
}
