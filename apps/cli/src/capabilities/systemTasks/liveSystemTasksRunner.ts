import { randomUUID } from 'node:crypto';

import { SystemTaskSpecSchema } from '@happier-dev/protocol';
import {
  createRelayRuntimeInstallOrUpdateTaskKind,
  createRelayRuntimeStartTaskKind,
  createRelayRuntimeStatusTaskKind,
  createRelayRuntimeStopTaskKind,
  type RelayRuntimeStatusSnapshot,
  type RelayRuntimeTaskParams,
} from '@happier-dev/cli-common/systemTasks';
import {
  installOrUpdateLiveRelayRuntime,
  readLiveRelayRuntimeStatus,
  startLiveRelayRuntime,
  stopLiveRelayRuntime,
} from './relayRuntime/liveRelayRuntime';
import { createLiveRemoteSshBootstrapTaskKind } from './ssh/liveRemoteSshBootstrap';
import { createSystemTasksRunner } from './systemTasksRunner';

function requireLocalRelayRuntimeParams(params: RelayRuntimeTaskParams): Readonly<{
  mode?: 'user' | 'system';
  channel?: 'stable' | 'preview' | 'dev';
}> {
  if (params.target.kind !== 'local') {
    throw new Error('Live relay runtime tasks only support local targets');
  }
  return {
    mode: params.mode,
    channel: params.channel,
  };
}

function deriveBaseUrl(status: Awaited<ReturnType<typeof readLiveRelayRuntimeStatus>>): string {
  try {
    const url = new URL(status.health.url);
    return `${url.protocol}//${url.host}`;
  } catch {
    return 'http://127.0.0.1:3005';
  }
}

async function readLiveRelayRuntimeSnapshot(params: RelayRuntimeTaskParams): Promise<RelayRuntimeStatusSnapshot> {
  const localParams = requireLocalRelayRuntimeParams(params);
  const status = await readLiveRelayRuntimeStatus(localParams);
  return {
    installed: status.installed,
    version: status.version,
    service: {
      active: status.service.active,
      enabled: status.service.enabled,
    },
    baseUrl: deriveBaseUrl(status),
    healthy: status.health.reachable,
  };
}

type SystemTasksRunnerAdapter = Readonly<{
  start: (params: Record<string, unknown>) => Promise<unknown>;
  poll: (params: Record<string, unknown>) => Promise<unknown>;
  respond: (params: Record<string, unknown>) => Promise<void>;
}>;

let liveRunnerAdapter: SystemTasksRunnerAdapter | null = null;

export function getLiveSystemTasksRunnerAdapter(): SystemTasksRunnerAdapter {
  if (liveRunnerAdapter) {
    return liveRunnerAdapter;
  }

  const runner = createSystemTasksRunner({
    kinds: {
      'remote.ssh.bootstrapMachine.v1': createLiveRemoteSshBootstrapTaskKind(),
      'relay.runtime.installOrUpdate.v1': createRelayRuntimeInstallOrUpdateTaskKind({
        installOrUpdate: async (params) => {
          const localParams = requireLocalRelayRuntimeParams(params);
          await installOrUpdateLiveRelayRuntime(localParams);
          const status = await readLiveRelayRuntimeSnapshot(params);
          return {
            relayUrl: status.baseUrl,
            mode: params.mode === 'system' ? 'system' : 'user',
          };
        },
      }),
      'relay.runtime.start.v1': createRelayRuntimeStartTaskKind({
        control: async (params) => {
          const localParams = requireLocalRelayRuntimeParams(params);
          await startLiveRelayRuntime(localParams);
        },
        readStatus: readLiveRelayRuntimeSnapshot,
        checkHealth: async ({ baseUrl }) => {
          const snapshot = await readLiveRelayRuntimeSnapshot({
            target: { kind: 'local' },
            mode: 'user',
            channel: 'stable',
          });
          return snapshot.baseUrl === baseUrl && snapshot.healthy === true;
        },
      }),
      'relay.runtime.status.v1': createRelayRuntimeStatusTaskKind({
        readStatus: readLiveRelayRuntimeSnapshot,
        checkHealth: async ({ baseUrl }) => {
          const snapshot = await readLiveRelayRuntimeSnapshot({
            target: { kind: 'local' },
            mode: 'user',
            channel: 'stable',
          });
          return snapshot.baseUrl === baseUrl && snapshot.healthy === true;
        },
      }),
      'relay.runtime.stop.v1': createRelayRuntimeStopTaskKind({
        control: async (params) => {
          const localParams = requireLocalRelayRuntimeParams(params);
          await stopLiveRelayRuntime(localParams);
        },
      }),
    },
  });

  liveRunnerAdapter = {
    start: async (params) => {
      const spec = SystemTaskSpecSchema.parse(params.spec ?? null);
      return await runner.start({
        taskId: `system-task:${randomUUID()}`,
        kind: spec.kind,
        params: spec.params,
      });
    },
    poll: async (params) => {
      return await runner.poll({
        taskId: String(params.taskId ?? '').trim(),
        cursor: typeof params.cursor === 'number' ? params.cursor : Number(params.cursor ?? 0),
      });
    },
    respond: async (params) => {
      await runner.respond({
        taskId: String(params.taskId ?? '').trim(),
        answer: params.answer,
      });
    },
  };

  return liveRunnerAdapter;
}
