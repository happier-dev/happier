import { SystemTaskExecutionError } from '../runSystemTask.js';

export type EnrollMachineRelayProfile = Readonly<{
  serverUrl: string;
  webappUrl: string;
  localServerUrl: string | null;
}>;

export type EnrollMachineAuthStatus = Readonly<{
  /** Canonical current-client fact. The booleans below remain reader compatibility for older CLI JSON. */
  credentialState?: 'missing' | 'valid' | 'invalid' | 'unknown';
  machineRegistrationState?: 'no-local-id' | 'local-only' | 'server-confirmed';
  authenticated: boolean;
  /** Identity is separate from credential validation and registration readiness. */
  accountId?: string | null;
  machineRegistered?: boolean;
  machineId: string | null;
}>;

export type EnrollMachineDaemonStatus = Readonly<{
  serviceInstalled: boolean;
  daemonRunning: boolean;
  /** Existing CLI observation: acknowledged Home machine-control registration. */
  daemonHealthy?: boolean | null;
  needsAuth: boolean;
  credentialState?: 'missing' | 'valid' | 'invalid' | 'unknown';
  machineRegistrationState?: 'no-local-id' | 'local-only' | 'server-confirmed';
  machineId: string | null;
  activeServerId?: string | null;
}>;

export type EnrollMachineReadiness = Readonly<{
  credentialState: NonNullable<EnrollMachineAuthStatus['credentialState']>;
  machineRegistrationState: NonNullable<EnrollMachineAuthStatus['machineRegistrationState']>;
  machineId: string | null;
}>;

/**
 * Projects current and legacy auth-status readers onto the canonical readiness
 * facts used by setup. Older status JSON exposed only convenience booleans;
 * those values did not prove live credential validation or server registration.
 */
export function resolveEnrollMachineReadiness(
  authStatus: EnrollMachineAuthStatus,
): EnrollMachineReadiness {
  const machineId = typeof authStatus.machineId === 'string' && authStatus.machineId.trim()
    ? authStatus.machineId.trim()
    : null;

  return {
    credentialState: authStatus.credentialState ?? 'unknown',
    machineRegistrationState: authStatus.machineRegistrationState
      ?? (machineId ? 'local-only' : 'no-local-id'),
    machineId,
  };
}

export type EnrollMachineFlowSteps = Readonly<{
  configureRelay?: boolean;
  installService?: boolean;
  startService?: boolean;
  verifyService?: boolean;
}>;

export type EnrollMachineServiceCommandOptions = Readonly<{
  /** Remaining containing-operation lifetime; omitted for standalone setup. */
  timeoutMs?: number;
  /** Overrides the executor's construction-time manual-daemon takeover choice for this call. */
  takeover?: boolean;
  /** Remove the conflict plan's services for this target as part of the install. */
  replaceExisting?: boolean;
}>;

/** One lifecycle action decided by the background-service disposition owner. */
export type EnrollMachineServiceAction =
  | Readonly<{ kind: 'install'; takeover: boolean; replaceExisting?: boolean }>
  | Readonly<{ kind: 'start'; takeover: boolean }>
  | Readonly<{ kind: 'restart' }>;

export type EnrollMachineFlowExecutor = Readonly<{
  configureRelay: (profile: EnrollMachineRelayProfile) => Promise<void | string>;
  readAuthStatus: () => Promise<EnrollMachineAuthStatus>;
  requestAuthPairing?: () => Promise<Readonly<{ publicKey: string } & Record<string, unknown>>>;
  waitForAuthPairing?: (publicKey: string) => Promise<Readonly<{ machineId: string | null }>>;
  approveAuthPairing?: (publicKey: string, requestPayload: Readonly<Record<string, unknown>>) => Promise<void>;
  enrollAuthPairing?: (params: Readonly<{
    approvePairingRequest?: (params: Readonly<{
      publicKey: string;
      requestPayload: Readonly<Record<string, unknown>>;
    }>) => Promise<void>;
  }>) => Promise<Readonly<{ publicKey: string | null; machineId: string | null }>>;
  installDaemonService?: (opts?: EnrollMachineServiceCommandOptions) => Promise<void>;
  startDaemonService?: (opts?: Pick<EnrollMachineServiceCommandOptions, 'takeover' | 'timeoutMs'>) => Promise<void>;
  restartDaemonService?: (opts?: Pick<EnrollMachineServiceCommandOptions, 'timeoutMs'>) => Promise<void>;
  waitForReadyDaemon?: (params: Readonly<{
    signal?: AbortSignal;
    /** Remaining containing-operation lifetime, not a new service deadline. */
    timeoutMs?: number;
    /** Managed enrollment dispatches guest Actions immediately after completion. */
    requireMachineControlReady?: boolean;
    /** Native-process guests have no user-service installation to wait for. */
    requireServiceInstalled?: boolean;
  }>) => Promise<EnrollMachineDaemonStatus>;
}>;

export type EnrollMachineFlowStepIds = Readonly<{
  configureRelay?: string;
  authRequest?: string;
  authWait?: string;
  installService?: string;
  startService?: string;
  restartService?: string;
  verifyService?: string;
}>;

export type EnrollMachineFlowEvent = Readonly<{
  type: 'progress';
  stepId: string;
  message?: string;
  data?: unknown;
}>;

export type EnrollMachineFlowResult = Readonly<{
  machineId: string | null;
  publicKey: string | null;
  daemonStatus?: EnrollMachineDaemonStatus | null;
}>;

export async function runEnrollMachineFlow(params: Readonly<{
  relayProfile: EnrollMachineRelayProfile;
  executor: EnrollMachineFlowExecutor;
  initialAuthStatus?: EnrollMachineAuthStatus;
  /** App-selected account; omitted for terminal setup with no app identity. */
  expectedAccountId?: string;
  steps?: EnrollMachineFlowSteps;
  stepIds?: EnrollMachineFlowStepIds;
  signal?: AbortSignal;
  emit: (event: EnrollMachineFlowEvent) => void;
  requireMachineIdAfterAuthWait?: boolean;
  approvePairingRequest?: (params: Readonly<{
    publicKey: string;
    requestPayload: Readonly<Record<string, unknown>>;
  }>) => Promise<void>;
  daemonReadinessErrorMessage?: string;
  /**
   * The service lifecycle as decided by the background-service disposition owner
   * (`resolveBackgroundServiceSetupReconciliationDisposition`), given whether this run paired. When
   * present it replaces the fixed `installService`/`startService` steps, so desktop and terminal
   * setup share one policy (R3-6).
   */
  serviceActions?: (facts: Readonly<{ paired: boolean }>) => readonly EnrollMachineServiceAction[];
}>): Promise<EnrollMachineFlowResult> {
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
    emitProgress(stepIds.configureRelay, 'Configuring server connection');
    await params.executor.configureRelay(params.relayProfile);
  }

  const authStatus = params.initialAuthStatus ?? await params.executor.readAuthStatus();
  const {
    credentialState,
    machineRegistrationState,
    machineId: statusMachineId,
  } = resolveEnrollMachineReadiness(authStatus);

  let publicKey: string | null = null;
  const expectedAccountId = params.expectedAccountId?.trim() || null;
  const accountMatches = !expectedAccountId || authStatus.accountId === expectedAccountId;
  let machineId: string | null = accountMatches ? statusMachineId : null;

  const shouldPair = !accountMatches || credentialState !== 'valid' || machineRegistrationState !== 'server-confirmed';
  if (shouldPair) {
    if (params.executor.enrollAuthPairing) {
      emitProgress(stepIds.authRequest, 'Requesting pairing');
      emitProgress(stepIds.authWait, 'Waiting for pairing');
      const enrolled = await params.executor.enrollAuthPairing({
        ...(params.approvePairingRequest
          ? { approvePairingRequest: params.approvePairingRequest }
          : {}),
      });
      publicKey = enrolled.publicKey;
      machineId = enrolled.machineId ?? machineId;
      if (params.requireMachineIdAfterAuthWait === true && !machineId) {
        throw new SystemTaskExecutionError('machine_id_unavailable', 'Auth pairing did not return a machine id.');
      }
    } else {
      const requestAuthPairing = params.executor.requestAuthPairing;
      const waitForAuthPairing = params.executor.waitForAuthPairing;
      if (!requestAuthPairing || !waitForAuthPairing) {
        throw new SystemTaskExecutionError('auth_enrollment_unavailable', 'No authentication enrollment owner is available.');
      }
      emitProgress(stepIds.authRequest, 'Requesting pairing');
      const requestRaw = await requestAuthPairing();
    const resolvedPublicKey = typeof requestRaw.publicKey === 'string' ? requestRaw.publicKey.trim() : '';
    if (!resolvedPublicKey) {
      throw new SystemTaskExecutionError('invalid_cli_response', 'Missing auth request public key.');
    }
    publicKey = resolvedPublicKey;

    const payload = requestRaw as Readonly<Record<string, unknown>>;

    if (accountMatches && credentialState === 'valid' && machineRegistrationState !== 'server-confirmed') {
      if (params.executor.approveAuthPairing) {
        await params.executor.approveAuthPairing(publicKey, payload);
      } else if (params.approvePairingRequest) {
        await params.approvePairingRequest({ publicKey, requestPayload: payload });
      } else {
        throw new SystemTaskExecutionError('approval_required', 'Pairing approval is required.');
      }
    } else if (params.approvePairingRequest) {
      await params.approvePairingRequest({ publicKey, requestPayload: payload });
    } else if (!accountMatches) {
      throw new SystemTaskExecutionError('approval_required', 'The selected account must approve replacement pairing.');
    }

    emitProgress(stepIds.authWait, 'Waiting for pairing');
    const waitResult = await waitForAuthPairing(publicKey);
    const waitedMachineId = typeof waitResult.machineId === 'string' && waitResult.machineId.trim()
      ? waitResult.machineId.trim()
      : null;
    machineId = waitedMachineId ?? machineId;
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
  }

  if (expectedAccountId && shouldPair) {
    // The claim result alone cannot establish which account now owns these credentials.
    const pairedStatus = await params.executor.readAuthStatus();
    if (pairedStatus.accountId !== expectedAccountId) {
      throw new SystemTaskExecutionError('account_mismatch', 'Pairing did not establish credentials for the selected account.');
    }
    const pairedReadiness = resolveEnrollMachineReadiness(pairedStatus);
    if (pairedReadiness.credentialState !== 'valid') {
      throw new SystemTaskExecutionError('auth_status_unavailable', 'The selected account credentials could not be validated after pairing.');
    }
    machineId = pairedReadiness.machineId;
    if (params.requireMachineIdAfterAuthWait === true && !machineId) {
      throw new SystemTaskExecutionError('machine_id_unavailable', 'Auth pairing did not return a machine id.');
    }
  }

  const serviceActions: readonly EnrollMachineServiceAction[] = params.serviceActions
    ? params.serviceActions({ paired: shouldPair })
    : [
        ...(steps.installService !== false ? [{ kind: 'install' as const, takeover: false }] : []),
        ...(steps.startService !== false ? [{ kind: 'start' as const, takeover: false }] : []),
      ];
  // Without a disposition owner the executor keeps its construction-time takeover choice.
  const takeoverFor = (action: Readonly<{ takeover: boolean }>): boolean | undefined => (
    params.serviceActions ? action.takeover : undefined
  );

  for (const action of serviceActions) {
    if (action.kind === 'install') {
      emitProgress(stepIds.installService, 'Installing background service');
      await params.executor.installDaemonService?.({
        ...(takeoverFor(action) === undefined ? {} : { takeover: action.takeover }),
        ...(action.replaceExisting ? { replaceExisting: true } : {}),
      });
      continue;
    }
    if (action.kind === 'restart') {
      emitProgress(stepIds.restartService ?? stepIds.startService, 'Restarting background service');
      await params.executor.restartDaemonService?.();
    } else {
      emitProgress(stepIds.startService, 'Starting background service');
      await params.executor.startDaemonService?.(
        takeoverFor(action) === undefined ? undefined : { takeover: action.takeover },
      );
    }

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

  let daemonStatus: EnrollMachineDaemonStatus | null = null;
  if (steps.verifyService !== false && params.executor.waitForReadyDaemon) {
    emitProgress(stepIds.verifyService, 'Verifying background service');
    daemonStatus = await params.executor.waitForReadyDaemon({ signal: params.signal });
    if (!daemonStatus.serviceInstalled || !daemonStatus.daemonRunning || daemonStatus.needsAuth) {
      throw new SystemTaskExecutionError(
        'daemon_service_not_ready',
        params.daemonReadinessErrorMessage ?? 'Background service did not reach a ready state.',
      );
    }
  }

  return {
    machineId,
    publicKey,
    ...(daemonStatus ? { daemonStatus } : {}),
  };
}
