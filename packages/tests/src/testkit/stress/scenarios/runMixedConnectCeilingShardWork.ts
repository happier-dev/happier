import { waitFor } from '../../timing';
import { createTestAuth } from '../../auth';
import { createMachineBoundSessionScopedSocketCollector } from '../../sessionSocketBinding';
import { createSession } from '../../sessions';
import type { StressConfig } from '../config/stressScenarioSchema';
import { buildMixedRealisticWorkload } from './mixedRealisticWorkload';
import { resolveStressSocketTransports } from './stressScenarioRuntime';
import {
  captureMixedConnectivitySnapshot,
  recordProvisionedCollector,
  resolveMixedAuth,
  resolveMixedUserDevices,
  runMixedSocketConnectTasks,
  type MixedCollector,
  type MixedConnectivitySnapshot,
  type MixedScenarioAuth,
  type MixedSessionTarget,
  type MixedUserDevices,
} from './mixedScenarioShared';
import { runStressTasksWithConcurrencyLimit } from './runStressTasksWithConcurrencyLimit';
import type { MixedConnectCeilingShardResult } from './runMixedConnectCeilingScenario';

export type MixedConnectCeilingShardProgressSnapshot = Readonly<
  MixedConnectCeilingShardResult & {
    phase: string;
  }
>;

function buildProgressSnapshot(params: {
  phase: string;
  shardIndex: number;
  authIndexStart: number;
  authCount: number;
  connectivitySnapshot: MixedConnectivitySnapshot;
  stageDurationsMs: {
    authMs: number;
    provisionMs: number;
    connectMs: number;
  };
}): MixedConnectCeilingShardProgressSnapshot {
  return {
    phase: params.phase,
    shardIndex: params.shardIndex,
    authIndexStart: params.authIndexStart,
    authIndexEndExclusive: params.authIndexStart + params.authCount,
    userDevicesTotal: params.connectivitySnapshot.userDevices.total,
    connectedUserDevices: params.connectivitySnapshot.userDevices.connected,
    machineCollectorsTotal: params.connectivitySnapshot.machineCollectors.total,
    connectedMachineCollectors: params.connectivitySnapshot.machineCollectors.connected,
    connectivitySnapshot: params.connectivitySnapshot,
    stageDurationsMs: params.stageDurationsMs,
  };
}

function closeTrackedSockets(params: {
  userDevices: readonly MixedUserDevices[];
  machineCollectors: readonly MixedCollector[];
}): void {
  params.userDevices.forEach((userDevice) => userDevice.devices.forEach((device) => device.close()));
  params.machineCollectors.forEach((collector) => collector.socket.close());
}

export async function runMixedConnectCeilingShardWork(params: {
  baseUrl: string;
  controlPlaneBaseUrl?: string;
  config: StressConfig;
  authIndexStart: number;
  shardIndex: number;
  onProgress?: (snapshot: MixedConnectCeilingShardProgressSnapshot) => Promise<void> | void;
}): Promise<MixedConnectCeilingShardResult> {
  const authCreationStartedAt = Date.now();
  const authSlots = Array.from({ length: Math.max(1, params.config.load.users) }, (_, index) => index);
  const auths = await runStressTasksWithConcurrencyLimit(
    authSlots,
    Math.min(32, params.config.load.mixedSetupConcurrency ?? 8),
    async (): Promise<MixedScenarioAuth> => await createTestAuth(params.baseUrl),
  );
  const authMs = Date.now() - authCreationStartedAt;

  const workload = buildMixedRealisticWorkload(params.config);
  const transports = resolveStressSocketTransports(params.config, 'full-compose');
  const mixedSetupConcurrency = params.config.load.mixedSetupConcurrency ?? 8;
  const mixedConnectConcurrency = params.config.load.mixedConnectConcurrency ?? 128;
  const mixedConnectPattern = params.config.load.mixedConnectPattern ?? 'burst';
  const mixedConnectRampStepMs = params.config.load.mixedConnectRampStepMs ?? 0;
  const mixedSocketConnectTimeoutMs = params.config.load.mixedSocketConnectTimeoutMs ?? 60_000;
  const mixedSetupRequestTimeoutMs = params.config.load.mixedSetupRequestTimeoutMs ?? 15_000;
  const mixedMessageEmitterCount = Math.max(1, params.config.load.mixedMessageEmitterCount ?? 1);

  const mixedSocketAutoReconnect = params.config.load.mixedSocketAutoReconnect ?? true;
  const mixedCaptureSocketEvents = params.config.load.mixedCaptureSocketEvents ?? true;
  const userDevices = resolveMixedUserDevices({
    auths,
    baseUrl: params.baseUrl,
    transports,
    mixedMessageEmitterCount,
    mixedSocketConnectTimeoutMs,
    mixedSocketAutoReconnect,
    mixedCaptureSocketEvents,
  }).map((userDevice) => ({
    ...userDevice,
    authIndex: params.authIndexStart + userDevice.authIndex,
  })) satisfies MixedUserDevices[];

  const sessions: MixedSessionTarget[] = [];
  const machineCollectors: MixedCollector[] = [];
  const verificationSessionIds: string[] = [];
  const expectedLocalIdsBySession = new Map<string, string[]>();
  let connectivitySnapshot: MixedConnectivitySnapshot | undefined;
  let provisionMs = 0;
  let connectMs = 0;

  try {
    const provisionStartedAt = Date.now();
    await runStressTasksWithConcurrencyLimit(
      workload.sessionPlans,
      mixedSetupConcurrency,
      async (sessionPlan) => {
        const auth = resolveMixedAuth({
          auths,
          authIndex: sessionPlan.authIndex,
        });
        const { sessionId } = await createSession(params.baseUrl, auth.token, {
          timeoutMs: mixedSetupRequestTimeoutMs,
        });
        const collector = await createMachineBoundSessionScopedSocketCollector({
          baseUrl: params.baseUrl,
          token: auth.token,
          sessionId,
          transports,
          connectTimeoutMs: mixedSocketConnectTimeoutMs,
        });
        recordProvisionedCollector({
          collector: {
            sessionId,
            machineId: collector.machineId,
            authIndex: params.authIndexStart + sessionPlan.authIndex,
            socket: collector.socket,
          },
          sessions,
          machineCollectors,
          verificationSessionIds,
          expectedLocalIdsBySession,
          verificationSessionCount: 0,
        });
      },
    );
    provisionMs = Date.now() - provisionStartedAt;
    connectivitySnapshot = captureMixedConnectivitySnapshot({
      userDevices,
      machineCollectors,
    });
    await params.onProgress?.(buildProgressSnapshot({
      phase: 'provision',
      shardIndex: params.shardIndex,
      authIndexStart: params.authIndexStart,
      authCount: auths.length,
      connectivitySnapshot,
      stageDurationsMs: {
        authMs,
        provisionMs,
        connectMs,
      },
    }));

    const connectStartedAt = Date.now();
    await runMixedSocketConnectTasks({
      concurrency: mixedConnectConcurrency,
      connectPattern: mixedConnectPattern,
      rampStepMs: mixedConnectRampStepMs,
      tasks: [
        ...userDevices.flatMap((userDevice) =>
          userDevice.devices.map(
            (device) => async () => {
              device.connect();
              await new Promise<void>((resolve) => setImmediate(resolve));
            },
          )),
        ...machineCollectors.map(
          (collector) => async () => {
            collector.socket.connect();
            await new Promise<void>((resolve) => setImmediate(resolve));
          },
        ),
      ],
    });

    await waitFor(
      () =>
        userDevices.every((userDevice) => userDevice.devices.every((device) => device.isConnected()))
        && machineCollectors.every((collector) => collector.socket.isConnected()),
      { timeoutMs: 60_000 },
    );

    connectMs = Date.now() - connectStartedAt;
    connectivitySnapshot = captureMixedConnectivitySnapshot({
      userDevices,
      machineCollectors,
    });
    const result = buildProgressSnapshot({
      phase: 'complete',
      shardIndex: params.shardIndex,
      authIndexStart: params.authIndexStart,
      authCount: auths.length,
      connectivitySnapshot,
      stageDurationsMs: {
        authMs,
        provisionMs,
        connectMs,
      },
    });
    await params.onProgress?.(result);
    return result;
  } catch (error) {
    connectivitySnapshot = captureMixedConnectivitySnapshot({
      userDevices,
      machineCollectors,
    });
    const errorMessage = error instanceof Error ? error.message : String(error);
    const failure = new Error(
      `Mixed connect ceiling shard failed for authIndexStart=${params.authIndexStart}: ${errorMessage}; `
      + `connectedUserDevices=${connectivitySnapshot.userDevices.connected}/${connectivitySnapshot.userDevices.total}; `
      + `connectedCollectors=${connectivitySnapshot.machineCollectors.connected}/${connectivitySnapshot.machineCollectors.total}`,
    );
    Object.assign(failure, {
      partialResult: buildProgressSnapshot({
        phase: 'failed',
        shardIndex: params.shardIndex,
        authIndexStart: params.authIndexStart,
        authCount: auths.length,
        connectivitySnapshot,
        stageDurationsMs: {
          authMs,
          provisionMs,
          connectMs,
        },
      }),
    });
    throw failure;
  } finally {
    closeTrackedSockets({
      userDevices,
      machineCollectors,
    });
  }
}
