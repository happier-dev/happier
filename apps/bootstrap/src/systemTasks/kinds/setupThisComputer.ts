import { systemTasks } from '@happier-dev/cli-common';

import {
  type ActiveRelayProfile,
  type AuthStatusSnapshot,
  type DaemonStatusSnapshot,
  configureRelay,
  installService,
  pairLocalMachineIfNeeded,
  readActiveRelayProfile,
  readAuthStatus,
  readDaemonStatus,
  requestAuthPairing,
  startService,
  waitForAuthPairing,
  waitForReadyDaemon,
} from '../localDaemonCli.js';

export interface SetupThisComputerParams {
  surface?: string;
  target?: string;
}

type SetupThisComputerDeps = Readonly<{
  readActiveRelay: () => Promise<ActiveRelayProfile>;
  readAuthStatus: () => Promise<AuthStatusSnapshot>;
  requestAuthPairing: () => Promise<Readonly<{ publicKey: string }>>;
  waitForAuthPairing: (publicKey: string) => Promise<Readonly<{ machineId: string | null }>>;
  pairLocalMachineIfNeeded: (authStatus: AuthStatusSnapshot) => Promise<string | null>;
  configureRelay: (profile: ActiveRelayProfile) => Promise<void>;
  installService: () => Promise<void>;
  startService: () => Promise<void>;
  readDaemonStatus: () => Promise<DaemonStatusSnapshot>;
}>;

export function createSetupThisComputerHandler(overrides?: Partial<SetupThisComputerDeps>) {
  const deps = createSetupThisComputerDeps(overrides);

  return async function* (
    params: unknown,
    context: Readonly<{ signal: AbortSignal }>,
  ): AsyncGenerator<
    Readonly<{
      type: 'progress' | 'prompt';
      stepId: string;
      message?: string;
      data?: Record<string, string | boolean>;
    }>,
    Readonly<{ machineId: string }>,
    void
  > {
    parseSetupThisComputerParams(params);

    yield { type: 'progress', stepId: 'setup.thisComputer.resolveRelay' };
    const relay = await deps.readActiveRelay();

    yield { type: 'progress', stepId: 'setup.thisComputer.checkAuth' };
    const authStatus = await deps.readAuthStatus();

    yield { type: 'progress', stepId: 'setup.thisComputer.configureRelay' };
    await deps.configureRelay(relay);

    let pairedMachineId: string | null = null;
    if (!authStatus.authenticated) {
      const request = await deps.requestAuthPairing();
      yield {
        type: 'prompt',
        stepId: 'setup.thisComputer.auth.request',
        message: 'Approve this computer in Happier to continue',
        data: {
          kind: 'authRequest',
          publicKey: request.publicKey,
          relayUrl: relay.serverUrl,
          webappUrl: relay.webappUrl,
        },
      };

      yield { type: 'progress', stepId: 'setup.thisComputer.auth.wait' };
      const wait = await deps.waitForAuthPairing(request.publicKey);
      pairedMachineId = wait.machineId;
      if (!pairedMachineId) {
        throw new systemTasks.SystemTaskExecutionError(
          'machine_id_unavailable',
          'Authenticated Relay session did not expose a machineId for this computer.',
        );
      }
    } else {
      pairedMachineId = await deps.pairLocalMachineIfNeeded(authStatus);
    }

    yield { type: 'progress', stepId: 'setup.thisComputer.installService' };
    await deps.installService();

    yield { type: 'progress', stepId: 'setup.thisComputer.startService' };
    await deps.startService();

    yield { type: 'progress', stepId: 'setup.thisComputer.verifyService' };
    const daemonStatus = await waitForReadyDaemon({
      readDaemonStatus: deps.readDaemonStatus,
      signal: context.signal,
    });
    if (!daemonStatus.serviceInstalled || !daemonStatus.daemonRunning || daemonStatus.needsAuth) {
      throw new systemTasks.SystemTaskExecutionError(
        'daemon_service_not_ready',
        'Daemon service did not reach a ready state for the selected Relay.',
      );
    }

    const machineId = pairedMachineId ?? daemonStatus.machineId;
    if (!machineId) {
      throw new systemTasks.SystemTaskExecutionError(
        'machine_id_unavailable',
        'Authenticated Relay session did not expose a machineId for this computer.',
      );
    }

    return { machineId };
  };
}

export function parseSetupThisComputerParams(params: unknown): SetupThisComputerParams {
  if (params === null || typeof params !== 'object' || Array.isArray(params)) {
    throw new systemTasks.SystemTaskExecutionError('invalid_params', 'Expected setup params to be an object.');
  }
  return params as SetupThisComputerParams;
}

function createSetupThisComputerDeps(overrides?: Partial<SetupThisComputerDeps>): SetupThisComputerDeps {
  return {
    readActiveRelay: overrides?.readActiveRelay ?? readActiveRelayProfile,
    readAuthStatus: overrides?.readAuthStatus ?? readAuthStatus,
    requestAuthPairing: overrides?.requestAuthPairing ?? requestAuthPairing,
    waitForAuthPairing: overrides?.waitForAuthPairing ?? waitForAuthPairing,
    pairLocalMachineIfNeeded: overrides?.pairLocalMachineIfNeeded ?? pairLocalMachineIfNeeded,
    configureRelay: overrides?.configureRelay ?? configureRelay,
    installService: overrides?.installService ?? installService,
    startService: overrides?.startService ?? startService,
    readDaemonStatus: overrides?.readDaemonStatus ?? readDaemonStatus,
  };
}
