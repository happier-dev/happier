import { SystemTaskExecutionError } from '../runSystemTask.js';

export type SetupMachineRelayProfile = Readonly<{
  serverUrl: string;
  webappUrl: string;
  localServerUrl: string | null;
}>;

export type SetupMachineAuthStatus = Readonly<{
  authenticated: boolean;
  machineId: string | null;
}>;

export type SetupMachineDaemonStatus = Readonly<{
  serviceInstalled: boolean;
  daemonRunning: boolean;
  needsAuth: boolean;
  machineId: string | null;
}>;

export type SetupMachineRecipeSteps = Readonly<{
  configureRelay?: boolean;
  installService?: boolean;
  startService?: boolean;
  verifyService?: boolean;
}>;

export type SetupMachineRecipeExecutor = Readonly<{
  configureRelay: (profile: SetupMachineRelayProfile) => Promise<void>;
  readAuthStatus: () => Promise<SetupMachineAuthStatus>;
  requestAuthPairing: () => Promise<Readonly<{ publicKey: string } & Record<string, unknown>>>;
  waitForAuthPairing: (publicKey: string) => Promise<Readonly<{ machineId: string | null }>>;
  approveAuthPairing?: (publicKey: string) => Promise<void>;
  installDaemonService?: () => Promise<void>;
  startDaemonService?: () => Promise<void>;
  waitForReadyDaemon?: (params: Readonly<{ signal?: AbortSignal }>) => Promise<SetupMachineDaemonStatus>;
}>;

export type SetupMachineRecipeStepIds = Readonly<{
  configureRelay?: string;
  authRequest?: string;
  authWait?: string;
  installService?: string;
  startService?: string;
  verifyService?: string;
}>;

export type SetupMachineRecipeEvent = Readonly<{
  type: 'progress';
  stepId: string;
  message?: string;
  data?: unknown;
}>;

export type SetupMachineRecipeResult = Readonly<{
  machineId: string | null;
  publicKey: string | null;
  daemonStatus?: SetupMachineDaemonStatus | null;
}>;

export async function runSetupMachineRecipe(params: Readonly<{
  relayProfile: SetupMachineRelayProfile;
  executor: SetupMachineRecipeExecutor;
  initialAuthStatus?: SetupMachineAuthStatus;
  steps?: SetupMachineRecipeSteps;
  stepIds?: SetupMachineRecipeStepIds;
  signal?: AbortSignal;
  emit: (event: SetupMachineRecipeEvent) => void;
  requireMachineIdAfterAuthWait?: boolean;
  approvePairingRequest?: (params: Readonly<{
    publicKey: string;
    requestPayload: Readonly<Record<string, unknown>>;
  }>) => Promise<void>;
  daemonReadinessErrorMessage?: string;
}>): Promise<SetupMachineRecipeResult> {
  const steps = params.steps ?? {};
  const stepIds = params.stepIds ?? {};

  const emitProgress = (stepId: string | undefined, message?: string, data?: unknown) => {
    if (!stepId) return;
    params.emit({
      type: 'progress',
      stepId,
      ...(message ? { message } : {}),
      ...(typeof data === 'undefined' ? {} : { data }),
    });
  };

  if (steps.configureRelay !== false) {
    emitProgress(stepIds.configureRelay, 'Configuring relay');
    await params.executor.configureRelay(params.relayProfile);
  }

  const authStatus = params.initialAuthStatus ?? await params.executor.readAuthStatus();
  const statusMachineId = typeof authStatus.machineId === 'string' && authStatus.machineId.trim()
    ? authStatus.machineId.trim()
    : null;

  let publicKey: string | null = null;
  let machineId: string | null = statusMachineId;

  const shouldPair = authStatus.authenticated !== true || !statusMachineId;
  if (shouldPair) {
    emitProgress(stepIds.authRequest, 'Requesting pairing');
    const requestRaw = await params.executor.requestAuthPairing();
    const resolvedPublicKey = typeof requestRaw.publicKey === 'string' ? requestRaw.publicKey.trim() : '';
    if (!resolvedPublicKey) {
      throw new SystemTaskExecutionError('invalid_cli_response', 'Missing auth request public key.');
    }
    publicKey = resolvedPublicKey;

    const payload = requestRaw as Readonly<Record<string, unknown>>;

    if (authStatus.authenticated === true && !statusMachineId) {
      if (params.executor.approveAuthPairing) {
        await params.executor.approveAuthPairing(publicKey);
      } else if (params.approvePairingRequest) {
        await params.approvePairingRequest({ publicKey, requestPayload: payload });
      } else {
        throw new SystemTaskExecutionError('approval_required', 'Pairing approval is required.');
      }
    } else if (params.approvePairingRequest) {
      await params.approvePairingRequest({ publicKey, requestPayload: payload });
    }

    emitProgress(stepIds.authWait, 'Waiting for pairing');
    const waitResult = await params.executor.waitForAuthPairing(publicKey);
    const waitedMachineId = typeof waitResult.machineId === 'string' && waitResult.machineId.trim()
      ? waitResult.machineId.trim()
      : null;
    machineId = waitedMachineId ?? statusMachineId;
    if (!machineId) {
      try {
        const statusAfterWait = await params.executor.readAuthStatus();
        const machineIdAfterWait = typeof statusAfterWait.machineId === 'string' && statusAfterWait.machineId.trim()
          ? statusAfterWait.machineId.trim()
          : null;
        machineId = machineIdAfterWait ?? machineId;
      } catch {
        // best-effort fallback only
      }
    }

    if (params.requireMachineIdAfterAuthWait === true && !machineId) {
      throw new SystemTaskExecutionError('machine_id_unavailable', 'Auth pairing did not return a machine id.');
    }
  }

  if (steps.installService !== false) {
    emitProgress(stepIds.installService, 'Installing background service');
    await params.executor.installDaemonService?.();
  }

  if (steps.startService !== false) {
    emitProgress(stepIds.startService, 'Starting background service');
    await params.executor.startDaemonService?.();

    if (!machineId) {
      try {
        const statusAfterStart = await params.executor.readAuthStatus();
        const machineIdAfterStart = typeof statusAfterStart.machineId === 'string' && statusAfterStart.machineId.trim()
          ? statusAfterStart.machineId.trim()
          : null;
        machineId = machineIdAfterStart ?? machineId;
      } catch {
        // best-effort only
      }
    }
  }

  let daemonStatus: SetupMachineDaemonStatus | null = null;
  if (steps.verifyService !== false && params.executor.waitForReadyDaemon) {
    emitProgress(stepIds.verifyService, 'Verifying background service');
    daemonStatus = await params.executor.waitForReadyDaemon({ signal: params.signal });
    if (!daemonStatus.serviceInstalled || !daemonStatus.daemonRunning || daemonStatus.needsAuth) {
      throw new SystemTaskExecutionError(
        'daemon_service_not_ready',
        params.daemonReadinessErrorMessage ?? 'Daemon service did not reach a ready state.',
      );
    }
  }

  return {
    machineId,
    publicKey,
    ...(daemonStatus ? { daemonStatus } : {}),
  };
}
