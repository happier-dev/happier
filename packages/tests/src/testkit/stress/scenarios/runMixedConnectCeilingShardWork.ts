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
} from './runMixedRealisticScenario';
import { runStressTasksWithConcurrencyLimit } from './runStressTasksWithConcurrencyLimit';
import type { MixedConnectCeilingShardResult } from './runMixedConnectCeilingScenario';

function closeTrackedSockets(params: {
  userDevices: readonly MixedUserDevices[];
  machineCollectors: readonly MixedCollector[];
}): void {
  params.userDevices.forEach((userDevice) => userDevice.devices.forEach((device) => device.close()));
  params.machineCollectors.forEach((collector) => collector.socket.close());
}

export async function runMixedConnectCeilingShardWork(params: {
  baseUrl: string;
  config: StressConfig;
  authIndexStart: number;
  shardIndex: number;
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

  const userDevices = resolveMixedUserDevices({
    auths,
    baseUrl: params.baseUrl,
    transports,
    mixedMessageEmitterCount,
    mixedSocketConnectTimeoutMs,
  }).map((userDevice) => ({
    ...userDevice,
    authIndex: params.authIndexStart + userDevice.authIndex,
  })) satisfies MixedUserDevices[];

  const sessionIds: string[] = [];
  const sessions: MixedSessionTarget[] = [];
  const machineCollectors: MixedCollector[] = [];
  const verificationSessionIds: string[] = [];
  const expectedLocalIdsBySession = new Map<string, string[]>();
  let connectivitySnapshot: MixedConnectivitySnapshot | undefined;

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
          sessionIds,
          sessions,
          machineCollectors,
          verificationSessionIds,
          expectedLocalIdsBySession,
          verificationSessionCount: 0,
        });
      },
    );
    const provisionMs = Date.now() - provisionStartedAt;

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

    const connectMs = Date.now() - connectStartedAt;
    connectivitySnapshot = captureMixedConnectivitySnapshot({
      userDevices,
      machineCollectors,
    });

    return {
      shardIndex: params.shardIndex,
      authIndexStart: params.authIndexStart,
      authIndexEndExclusive: params.authIndexStart + auths.length,
      userDevicesTotal: connectivitySnapshot.userDevices.total,
      connectedUserDevices: connectivitySnapshot.userDevices.connected,
      machineCollectorsTotal: connectivitySnapshot.machineCollectors.total,
      connectedMachineCollectors: connectivitySnapshot.machineCollectors.connected,
      connectivitySnapshot,
      stageDurationsMs: {
        authMs,
        provisionMs,
        connectMs,
      },
    };
  } catch (error) {
    connectivitySnapshot = captureMixedConnectivitySnapshot({
      userDevices,
      machineCollectors,
    });
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Mixed connect ceiling shard failed for authIndexStart=${params.authIndexStart}: ${errorMessage}; `
      + `connectedUserDevices=${connectivitySnapshot.userDevices.connected}/${connectivitySnapshot.userDevices.total}; `
      + `connectedCollectors=${connectivitySnapshot.machineCollectors.connected}/${connectivitySnapshot.machineCollectors.total}`,
    );
  } finally {
    closeTrackedSockets({
      userDevices,
      machineCollectors,
    });
  }
}
