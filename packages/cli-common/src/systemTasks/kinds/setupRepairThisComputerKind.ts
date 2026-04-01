import { SystemTaskExecutionError } from '../runSystemTask.js';
import type { InteractiveSystemTaskKind } from '../interactiveTaskKinds.js';
import { runSetupMachineRecipe } from '../recipes/setupMachineRecipe.js';

export type SetupRepairThisComputerRelayProfile = Readonly<{
  serverUrl: string;
  webappUrl: string;
  activeLocalRelayUrl: string | null;
}>;

export type SetupRepairThisComputerAuthStatus =
  | Readonly<{ authenticated: false }>
  | Readonly<{ authenticated: true; machineId: string | null }>;

export type SetupRepairThisComputerDaemonStatus = Readonly<{
  serviceInstalled: boolean;
  daemonRunning: boolean;
  needsAuth: boolean;
  machineId: string | null;
}>;

export type SetupRepairThisComputerParams = Readonly<{
  /**
   * Desired relay/server URL the background service should connect to.
   * If omitted, the task falls back to the currently selected relay profile.
   */
  activeRelayUrl?: string | null;
  /**
   * Webapp URL associated with the active relay.
   * Defaults to `activeRelayUrl` when omitted.
   */
  activeWebappUrl?: string | null;
  /**
   * Optional local relay url (for example localhost) used for local targeting.
   * When omitted, the task falls back to the active relay profile’s local relay url.
   */
  activeLocalRelayUrl?: string | null;
  surface?: string | null;
}>;

export function parseSetupRepairThisComputerParams(params: unknown): SetupRepairThisComputerParams {
  if (params == null) {
    return {};
  }
  if (typeof params !== 'object' || Array.isArray(params)) {
    throw new SystemTaskExecutionError('invalid_params', 'Invalid setup repair params.');
  }
  const record = params as Record<string, unknown>;
  const activeRelayUrl = typeof record.activeRelayUrl === 'string'
    ? record.activeRelayUrl.trim()
    : record.activeRelayUrl == null
      ? null
      : undefined;
  const activeWebappUrl = typeof record.activeWebappUrl === 'string'
    ? record.activeWebappUrl.trim()
    : record.activeWebappUrl == null
      ? null
      : undefined;
  const activeLocalRelayUrl = typeof record.activeLocalRelayUrl === 'string'
    ? record.activeLocalRelayUrl.trim()
    : record.activeLocalRelayUrl == null
      ? null
      : undefined;
  const surface = typeof record.surface === 'string'
    ? record.surface.trim()
    : record.surface == null
      ? null
      : undefined;

  const unknownKeys = Object.keys(record).filter((key) => ![
    'activeRelayUrl',
    'activeWebappUrl',
    'activeLocalRelayUrl',
    'surface',
  ].includes(key));
  if (unknownKeys.length > 0) {
    throw new SystemTaskExecutionError('invalid_params', 'Unsupported setup repair params.');
  }

  if (activeRelayUrl === undefined || activeWebappUrl === undefined || activeLocalRelayUrl === undefined || surface === undefined) {
    throw new SystemTaskExecutionError('invalid_params', 'Invalid setup repair params.');
  }

  return {
    ...(activeRelayUrl ? { activeRelayUrl } : {}),
    ...(activeWebappUrl ? { activeWebappUrl } : {}),
    ...(activeLocalRelayUrl ? { activeLocalRelayUrl } : {}),
    ...(surface ? { surface } : {}),
  };
}

export type SetupRepairThisComputerDeps = Readonly<{
  readActiveRelayProfile: () => Promise<SetupRepairThisComputerRelayProfile>;
  readAuthStatus: () => Promise<SetupRepairThisComputerAuthStatus>;
  configureRelay: (params: Readonly<{ relayUrl: string; webappUrl: string; activeLocalRelayUrl: string | null }>) => Promise<void>;
  requestAuthPairing: () => Promise<Readonly<{ publicKey: string }>>;
  waitForAuthPairing: (publicKey: string) => Promise<Readonly<{ machineId: string }>>;
  pairLocalMachineIfNeeded: () => Promise<string>;
  installDaemonService: () => Promise<void>;
  startDaemonService: () => Promise<void>;
  waitForReadyDaemon: () => Promise<SetupRepairThisComputerDaemonStatus>;
}>;

export function createSetupRepairThisComputerTaskKind(
  deps: SetupRepairThisComputerDeps,
): InteractiveSystemTaskKind<Readonly<{ machineId: string }>> {
  return {
    async run(ctx) {
      const parsed = parseSetupRepairThisComputerParams(ctx.params);
      const relayProfile = await deps.readActiveRelayProfile();
      const relayUrl = String(parsed.activeRelayUrl ?? relayProfile.serverUrl ?? '').trim();
      const webappUrl = String(parsed.activeWebappUrl ?? relayProfile.webappUrl ?? '').trim() || relayUrl;
      const activeLocalRelayUrl = String(parsed.activeLocalRelayUrl ?? relayProfile.activeLocalRelayUrl ?? '').trim() || null;
      if (!relayUrl) {
        throw new SystemTaskExecutionError('invalid_params', 'Missing active Relay profile.');
      }

      ctx.emit({
        type: 'step',
        stepId: 'setup.repairThisComputer.prepare',
        message: 'Repairing this computer',
        data: {
          relayUrl,
          webappUrl,
          ...(activeLocalRelayUrl ? { activeLocalRelayUrl } : {}),
          ...(parsed.surface ? { surface: parsed.surface } : {}),
        },
      });

      ctx.emit({ type: 'progress', stepId: 'setup.repairThisComputer.configureRelay', message: 'Configuring relay' });
      await deps.configureRelay({ relayUrl, webappUrl, activeLocalRelayUrl });

      const authStatus = await deps.readAuthStatus();
      const initialRecipeAuthStatus = await resolveRepairRecipeAuthStatus({ authStatus, ctx, deps });

      const relayProfileForRecipe = {
        serverUrl: relayUrl,
        webappUrl,
        localServerUrl: activeLocalRelayUrl,
      };

      const recipeResult = await runSetupMachineRecipe({
        relayProfile: relayProfileForRecipe,
        initialAuthStatus: initialRecipeAuthStatus,
        executor: {
          configureRelay: async () => undefined,
          readAuthStatus: async () => {
            const latest = await deps.readAuthStatus();
            return {
              authenticated: latest.authenticated === true,
              machineId: latest.authenticated === true && latest.machineId?.trim() ? latest.machineId.trim() : null,
            };
          },
          requestAuthPairing: async () => {
            const request = await deps.requestAuthPairing();
            const publicKey = String(request.publicKey ?? '').trim();
            if (!publicKey) {
              throw new SystemTaskExecutionError('system_task_failed', 'Missing auth request public key.');
            }
            return {
              ...request,
              publicKey,
            };
          },
          waitForAuthPairing: async (publicKey: string) => {
            const result = await deps.waitForAuthPairing(publicKey);
            const machineId = typeof result.machineId === 'string' && result.machineId.trim()
              ? result.machineId.trim()
              : null;
            return { machineId };
          },
          installDaemonService: async () => {
            await deps.installDaemonService();
          },
          startDaemonService: async () => {
            await deps.startDaemonService();
          },
          waitForReadyDaemon: async () => {
            const ready = await deps.waitForReadyDaemon();
            return {
              serviceInstalled: ready.serviceInstalled,
              daemonRunning: ready.daemonRunning,
              needsAuth: ready.needsAuth,
              machineId: ready.machineId,
            };
          },
        },
        steps: {
          configureRelay: false,
          installService: true,
          startService: true,
          verifyService: true,
        },
        stepIds: {
          installService: 'setup.repairThisComputer.installService',
          startService: 'setup.repairThisComputer.startService',
          verifyService: 'setup.repairThisComputer.waitForReady',
        },
        signal: ctx.signal,
        emit(event) {
          ctx.emit({
            type: 'progress',
            stepId: event.stepId,
            ...(event.message ? { message: event.message } : {}),
          });
        },
        approvePairingRequest: authStatus.authenticated
          ? undefined
          : async (params) => {
            const answer = await ctx.prompt({
              kind: 'authRequest',
              stepId: 'setup.repairThisComputer.authRequest',
              message: 'Approve pairing request',
              data: {
                kind: 'authRequest',
                publicKey: params.publicKey,
                relayUrl,
                webappUrl,
              },
            }) as { approved?: boolean };

            if (answer?.approved !== true) {
              throw new SystemTaskExecutionError('approval_declined', 'Pairing request was not approved.');
            }
          },
        daemonReadinessErrorMessage: 'Daemon service did not reach a ready state for the selected Relay.',
      });

      const daemonMachineId = typeof recipeResult.daemonStatus?.machineId === 'string' && recipeResult.daemonStatus.machineId.trim()
        ? recipeResult.daemonStatus.machineId.trim()
        : null;
      if (!daemonMachineId) {
        throw new SystemTaskExecutionError(
          'daemon_service_not_ready',
          'Daemon service did not reach a ready state for the selected Relay.',
        );
      }

      ctx.emit({ type: 'progress', stepId: 'setup.repairThisComputer.finish', message: 'Repair complete' });
      return { machineId: daemonMachineId };
    },
  };
}

async function resolveRepairRecipeAuthStatus(params: Readonly<{
  authStatus: SetupRepairThisComputerAuthStatus;
  ctx: Readonly<{ emit: (event: Readonly<{ type: string; stepId?: string; message?: string }>) => void }>;
  deps: SetupRepairThisComputerDeps;
}>): Promise<Readonly<{ authenticated: boolean; machineId: string | null }>> {
  if (!params.authStatus.authenticated) {
    params.ctx.emit({
      type: 'progress',
      stepId: 'setup.repairThisComputer.authenticate',
      message: 'Waiting for pairing approval',
    });
    return { authenticated: false, machineId: null };
  }

  params.ctx.emit({
    type: 'progress',
    stepId: 'setup.repairThisComputer.verifyMachine',
    message: 'Verifying machine identity',
  });

  const resolvedMachineId = await params.deps.pairLocalMachineIfNeeded().then((id) => String(id ?? '').trim() || null);

  return {
    authenticated: true,
    machineId: resolvedMachineId ?? params.authStatus.machineId ?? '__unknown_machine__',
  };
}
