import {
  applyBackgroundServiceSetupGuidance,
  type BackgroundServiceSetupGuidanceCancellationReason,
  createLocalHappierJsonExecutor,
  ensureLocalFirstPartyComponentCommand,
  formatBackgroundServiceManualRelayTakeoverPrompt,
  formatBackgroundServiceReleaseChannelSwitchPrompt,
  formatBackgroundServiceReplacementPrompt,
  readBackgroundServiceSetupGuidance,
  createSetupMachineRecipeExecutorFromHappierJsonExecutor,
  runSetupMachineRecipe,
  SystemTaskExecutionError,
  type BackgroundServiceSetupGuidance,
  type InteractiveSystemTaskKind,
  type SetupMachineRecipeExecutor,
} from '@happier-dev/cli-common/systemTasks';
import { readMachineDaemonOwnershipMetadataFromSocketAuth, type MachineDaemonOwnershipMetadata } from '@happier-dev/protocol';
import {
  syncInstalledFirstPartyShims,
  writeDefaultManagedReleaseChannel,
} from '@happier-dev/cli-common/firstPartyRuntime';
import {
  type PublicReleaseRingId,
} from '@happier-dev/release-runtime/releaseRings';

import { runLocalHappierJsonCommand } from '../happierCli.js';
import { normalizeBootstrapChannel } from '../taskRuntime.js';

type SetupThisComputerRelayProfile = Readonly<{
  serverUrl: string;
  webappUrl: string;
  localServerUrl: string | null;
}>;

type CommandDiagnostics = Readonly<{
  command: string;
  args: readonly string[];
  details?: string;
}>;

function createBackgroundServiceSetupCancellationError(
  cancellationReason: BackgroundServiceSetupGuidanceCancellationReason | null,
): SystemTaskExecutionError {
  if (cancellationReason === 'declined_release_channel_switch') {
    return new SystemTaskExecutionError(
      'background_service_release_channel_switch_declined',
      'Setup was cancelled because the default release channel was kept unchanged.',
    );
  }
  if (cancellationReason === 'declined_manual_relay_takeover') {
    return new SystemTaskExecutionError(
      'background_service_manual_relay_takeover_declined',
      'Setup was cancelled because the current manual relay runtime was kept.',
    );
  }
  return new SystemTaskExecutionError(
    'background_service_conflict_declined',
    'Setup was cancelled because existing background services were kept.',
  );
}

function emitCommandDiagnostics(
  ctx: Readonly<{
    emit: (event: Readonly<{
      type: string;
      stepId?: string;
      message?: string;
      data?: unknown;
    }>) => void;
  }>,
  params: Readonly<{
    stepId: string;
    message: string;
    diagnostics: CommandDiagnostics;
  }>,
): void {
  ctx.emit({
    type: 'progress',
    stepId: params.stepId,
    message: params.message,
    data: {
      command: params.diagnostics.command,
      args: params.diagnostics.args,
      ...(params.diagnostics.details ? { details: params.diagnostics.details } : {}),
    },
  });
}

function createInstrumentedRecipeExecutor(
  ctx: Readonly<{
    emit: (event: Readonly<{
      type: string;
      stepId?: string;
      message?: string;
      data?: unknown;
    }>) => void;
  }>,
  recipeExecutor: SetupMachineRecipeExecutor,
): SetupMachineRecipeExecutor {
  return {
    ...recipeExecutor,
    async configureRelay(profile) {
      emitCommandDiagnostics(ctx, {
        stepId: 'setup.thisComputer.configureRelay',
        message: 'Running happier server set --json',
        diagnostics: {
          command: 'happier',
          args: [
            'server',
            'set',
            '--server-url',
            profile.serverUrl,
            ...(profile.localServerUrl ? ['--local-server-url', profile.localServerUrl] : []),
            '--webapp-url',
            profile.webappUrl,
            '--json',
          ],
        },
      });
      await recipeExecutor.configureRelay(profile);
    },
    async readAuthStatus() {
      emitCommandDiagnostics(ctx, {
        stepId: 'setup.thisComputer.checkAuth',
        message: 'Running happier auth status --json',
        diagnostics: {
          command: 'happier',
          args: ['auth', 'status', '--json'],
        },
      });
      return await recipeExecutor.readAuthStatus();
    },
    async requestAuthPairing() {
      emitCommandDiagnostics(ctx, {
        stepId: 'setup.thisComputer.auth.request',
        message: 'Running happier auth request --json',
        diagnostics: {
          command: 'happier',
          args: ['auth', 'request', '--json'],
        },
      });
      return await recipeExecutor.requestAuthPairing();
    },
    async waitForAuthPairing(publicKey) {
      emitCommandDiagnostics(ctx, {
        stepId: 'setup.thisComputer.auth.wait',
        message: 'Running happier auth wait --json',
        diagnostics: {
          command: 'happier',
          args: ['auth', 'wait', '--public-key', '[redacted]', '--json'],
          details: publicKey ? 'Waiting for the local pairing request to be approved.' : undefined,
        },
      });
      return await recipeExecutor.waitForAuthPairing(publicKey);
    },
    async approveAuthPairing(publicKey) {
      if (!recipeExecutor.approveAuthPairing) {
        return;
      }
      emitCommandDiagnostics(ctx, {
        stepId: 'setup.thisComputer.auth.request',
        message: 'Running happier auth approve --json',
        diagnostics: {
          command: 'happier',
          args: ['auth', 'approve', '--public-key', '[redacted]', '--json'],
          details: publicKey ? 'Approving the local pairing request for this computer.' : undefined,
        },
      });
      await recipeExecutor.approveAuthPairing(publicKey);
    },
    async installDaemonService() {
      if (!recipeExecutor.installDaemonService) {
        return;
      }
      emitCommandDiagnostics(ctx, {
        stepId: 'setup.thisComputer.installService',
        message: 'Running happier service install --json',
        diagnostics: {
          command: 'happier',
          args: ['service', 'install', '--json'],
        },
      });
      await recipeExecutor.installDaemonService();
    },
    async startDaemonService() {
      if (!recipeExecutor.startDaemonService) {
        return;
      }
      emitCommandDiagnostics(ctx, {
        stepId: 'setup.thisComputer.startService',
        message: 'Running happier service start --json',
        diagnostics: {
          command: 'happier',
          args: ['service', 'start', '--json'],
        },
      });
      await recipeExecutor.startDaemonService();
    },
    async waitForReadyDaemon(params) {
      if (!recipeExecutor.waitForReadyDaemon) {
        return {
          serviceInstalled: false,
          daemonRunning: false,
          needsAuth: true,
          machineId: null,
        };
      }
      emitCommandDiagnostics(ctx, {
        stepId: 'setup.thisComputer.verifyService',
        message: 'Polling happier daemon status --json',
        diagnostics: {
          command: 'happier',
          args: ['daemon', 'status', '--json'],
          details: 'Checking whether the background service is installed, running, and authenticated for the selected relay.',
        },
      });
      return await recipeExecutor.waitForReadyDaemon(params);
    },
  };
}

export type SetupThisComputerInteractiveParams = Readonly<{
  surface?: string;
  target?: string;
  channel?: 'stable' | 'preview' | 'dev' | 'publicdev';
  installService?: boolean;
  startService?: boolean;
  verifyService?: boolean;
}>;

export type SetupThisComputerInteractiveDeps = Readonly<{
  ensureLocalHappierTools: (params: Readonly<{ releaseChannel?: PublicReleaseRingId }>) => Promise<void>;
  readActiveRelayProfile: (params: Readonly<{ releaseRing?: PublicReleaseRingId }>) => Promise<SetupThisComputerRelayProfile>;
  createRecipeExecutor: (params: Readonly<{ releaseRing?: PublicReleaseRingId }>) => SetupMachineRecipeExecutor;
  readBackgroundServiceSetupGuidance: (params: Readonly<{
    targetReleaseChannel: PublicReleaseRingId;
    targetServerUrl: string;
    currentRelayOwner?: Pick<MachineDaemonOwnershipMetadata, 'serviceManaged' | 'publicReleaseChannel' | 'cliVersion'> | null;
  }>) => Promise<BackgroundServiceSetupGuidance>;
  readCurrentRelayOwner: (params: Readonly<{ releaseRing?: PublicReleaseRingId }>) => Promise<Pick<
    MachineDaemonOwnershipMetadata,
    'serviceManaged' | 'publicReleaseChannel' | 'cliVersion'
  > | null>;
  switchDefaultReleaseChannel: (releaseChannel: PublicReleaseRingId) => Promise<void>;
  stopCurrentManualRelayRuntime: (params?: Readonly<{ releaseRing?: PublicReleaseRingId }>) => Promise<void>;
  uninstallExistingDaemonServices: () => Promise<void>;
}>;

export function createSetupThisComputerInteractiveTaskKind(
  overrides: Partial<SetupThisComputerInteractiveDeps> = {},
): InteractiveSystemTaskKind<Readonly<{ machineId: string }>> {
  const deps = createSetupThisComputerInteractiveDeps(overrides);

  return {
    async run(ctx) {
      const parsed = parseSetupThisComputerInteractiveParams(ctx.params);
      const releaseRing = parsed.channel ? normalizeBootstrapChannel(parsed.channel).releaseChannel : undefined;
      ctx.emit({
        type: 'progress',
        stepId: 'setup.thisComputer.ensureCli',
        message: 'Installing Happier tools',
      });
      await deps.ensureLocalHappierTools({ releaseChannel: releaseRing });
      ctx.emit({
        type: 'progress',
        stepId: 'setup.thisComputer.resolveRelay',
        message: 'Resolving server configuration',
      });
      const relayProfile = await deps.readActiveRelayProfile({ releaseRing });
      const recipeExecutor = createInstrumentedRecipeExecutor(ctx, deps.createRecipeExecutor({ releaseRing }));
      ctx.emit({
        type: 'progress',
        stepId: 'setup.thisComputer.checkAuth',
        message: 'Checking authentication',
      });
      const authStatus = await recipeExecutor.readAuthStatus();

      if (parsed.installService !== false) {
        const targetReleaseChannel = releaseRing ?? 'stable';
        const currentRelayOwner = await deps.readCurrentRelayOwner({ releaseRing });
        const guidance = await deps.readBackgroundServiceSetupGuidance({
          targetReleaseChannel,
          targetServerUrl: relayProfile.serverUrl,
          currentRelayOwner,
        });

        const guidanceResult = await applyBackgroundServiceSetupGuidance({
          guidance,
          promptSwitchDefaultReleaseChannel: async () => {
            const answer = await ctx.prompt({
              kind: 'releaseChannel.switchDefaultForSetup',
              stepId: 'setup.thisComputer.preflight.releaseChannel',
              message: formatBackgroundServiceReleaseChannelSwitchPrompt(guidance),
              data: {
                targetReleaseChannel: guidance.targetReleaseChannel,
                currentDefaultReleaseChannel: guidance.currentDefaultReleaseChannel,
                targetServerUrl: guidance.targetServerUrl,
                managedReleaseChannels: guidance.managedReleaseChannels,
              },
            }) as { switchDefaultReleaseChannel?: boolean };
            return answer.switchDefaultReleaseChannel === true;
          },
          promptTakeOverManualRelayRuntime: async () => {
            const answer = await ctx.prompt({
              kind: 'daemon.takeOverManualRelayRuntimeForSetup',
              stepId: 'setup.thisComputer.preflight.manualRelayTakeover',
              message: formatBackgroundServiceManualRelayTakeoverPrompt(guidance),
              data: {
                targetServerUrl: guidance.targetServerUrl,
                targetReleaseChannel: guidance.targetReleaseChannel,
                currentReleaseChannel: guidance.manualRelayOwner?.currentReleaseChannel ?? null,
                currentCliVersion: guidance.manualRelayOwner?.currentCliVersion ?? null,
              },
            }) as { takeOverManualRelayRuntime?: boolean };
            return answer.takeOverManualRelayRuntime === true;
          },
          promptReplaceExistingServices: async () => {
            const answer = await ctx.prompt({
              kind: 'daemon.replaceLocalBackgroundServices',
              stepId: 'setup.thisComputer.preflight.serviceConflict',
              message: formatBackgroundServiceReplacementPrompt(guidance),
              data: {
                targetServerUrl: guidance.targetServerUrl,
                targetReleaseChannel: guidance.targetReleaseChannel,
                services: guidance.conflictingServices,
              },
            }) as { replaceExistingServices?: boolean };
            return answer.replaceExistingServices === true;
          },
          switchDefaultReleaseChannel: async () => {
            ctx.emit({
              type: 'progress',
              stepId: 'setup.thisComputer.preflight.releaseChannel',
              message: 'Updating the default managed release channel',
              data: {
                details: `Switching the default managed release channel to ${targetReleaseChannel} and syncing the matching Happier terminal command.`,
              },
            });
            await deps.switchDefaultReleaseChannel(targetReleaseChannel);
          },
          takeOverManualRelayRuntime: async () => {
            emitCommandDiagnostics(ctx, {
              stepId: 'setup.thisComputer.preflight.manualRelayTakeover',
              message: 'Running happier daemon stop --json',
              diagnostics: {
                command: 'happier',
                args: ['daemon', 'stop', '--json'],
              },
            });
            await deps.stopCurrentManualRelayRuntime({ releaseRing });
          },
          replaceExistingServices: async () => {
            emitCommandDiagnostics(ctx, {
              stepId: 'setup.thisComputer.preflight.serviceConflict',
              message: 'Running happier service uninstall --all --yes --json',
              diagnostics: {
                command: 'happier',
                args: ['service', 'uninstall', '--all', '--yes', '--json'],
              },
            });
            await deps.uninstallExistingDaemonServices();
          },
        });

        if (guidanceResult.cancelled) {
          throw createBackgroundServiceSetupCancellationError(guidanceResult.cancellationReason);
        }
      }

      const recipeResult = await runSetupMachineRecipe({
        relayProfile,
        executor: recipeExecutor,
        initialAuthStatus: authStatus,
        steps: {
          installService: parsed.installService,
          startService: parsed.startService,
          verifyService: parsed.verifyService,
        },
        stepIds: {
          configureRelay: 'setup.thisComputer.configureRelay',
          authWait: 'setup.thisComputer.auth.wait',
          installService: 'setup.thisComputer.installService',
          startService: 'setup.thisComputer.startService',
          verifyService: 'setup.thisComputer.verifyService',
        },
        signal: ctx.signal,
        emit(event) {
          ctx.emit({
            type: 'progress',
            stepId: event.stepId,
            ...(event.message ? { message: event.message } : {}),
          });
        },
        approvePairingRequest: async (inner) => {
          ctx.emit({
            type: 'prompt',
            stepId: 'setup.thisComputer.auth.request',
            message: 'Approve this computer in Happier to continue',
            data: {
              kind: 'authRequest',
              publicKey: inner.publicKey,
              relayUrl: relayProfile.serverUrl,
              webappUrl: relayProfile.webappUrl,
            },
          });
        },
        daemonReadinessErrorMessage: 'Background service did not reach a ready state for the selected server.',
      });

      const machineId = recipeResult.machineId;
      if (!machineId) {
        throw new SystemTaskExecutionError(
          'machine_id_unavailable',
          'Authenticated server session did not expose a machineId for this computer.',
        );
      }

      return { machineId };
    },
  };
}

function parseSetupThisComputerInteractiveParams(params: unknown): SetupThisComputerInteractiveParams {
  if (params === null || typeof params !== 'object' || Array.isArray(params)) {
    throw new SystemTaskExecutionError('invalid_params', 'Expected setup params to be an object.');
  }
  const record = params as Record<string, unknown>;
  const parsed: {
    surface?: string;
    target?: string;
    channel?: SetupThisComputerInteractiveParams['channel'];
    installService?: boolean;
    startService?: boolean;
    verifyService?: boolean;
  } = {
    surface: typeof record.surface === 'string' ? record.surface : undefined,
    target: typeof record.target === 'string' ? record.target : undefined,
  };
  if ('channel' in record) {
    if (typeof record.channel !== 'string') {
      throw new SystemTaskExecutionError('invalid_params', 'Expected channel to be a string.');
    }
    const channel = record.channel.trim().toLowerCase();
    if (channel !== 'stable' && channel !== 'preview' && channel !== 'dev' && channel !== 'publicdev') {
      throw new SystemTaskExecutionError('invalid_params', `Unsupported channel: ${record.channel}`);
    }
    parsed.channel = channel as SetupThisComputerInteractiveParams['channel'];
  }
  if ('installService' in record) {
    if (typeof record.installService !== 'boolean') {
      throw new SystemTaskExecutionError('invalid_params', 'Expected installService to be a boolean.');
    }
    parsed.installService = record.installService;
  }
  if ('startService' in record) {
    if (typeof record.startService !== 'boolean') {
      throw new SystemTaskExecutionError('invalid_params', 'Expected startService to be a boolean.');
    }
    parsed.startService = record.startService;
  }
  if ('verifyService' in record) {
    if (typeof record.verifyService !== 'boolean') {
      throw new SystemTaskExecutionError('invalid_params', 'Expected verifyService to be a boolean.');
    }
    parsed.verifyService = record.verifyService;
  }
  return parsed;
}

function createSetupThisComputerInteractiveDeps(
  overrides: Partial<SetupThisComputerInteractiveDeps>,
): SetupThisComputerInteractiveDeps {
  return {
    ensureLocalHappierTools: async ({ releaseChannel }) => {
      await ensureLocalFirstPartyComponentCommand({
        componentId: 'happier-cli',
        processEnv: process.env,
        releaseRing: releaseChannel,
      });
      await syncInstalledFirstPartyShims({
        componentId: 'happier-cli',
        channel: releaseChannel,
        processEnv: process.env,
      });
    },
    readActiveRelayProfile: async ({ releaseRing }) => {
      const executor = createLocalHappierJsonExecutor({ releaseRing });
      const parsed = await executor.runHappierJson(['server', 'current', '--json']);
      const active = parsed && typeof parsed === 'object'
        ? (parsed as { data?: { active?: Record<string, unknown> } }).data?.active
        : null;

      const serverUrl = typeof active?.serverUrl === 'string' ? active.serverUrl.trim() : '';
      const webappUrl = typeof active?.webappUrl === 'string' && active.webappUrl.trim()
        ? active.webappUrl.trim()
        : serverUrl;
      const localServerUrl = typeof active?.localServerUrl === 'string' && active.localServerUrl.trim()
        ? active.localServerUrl.trim()
        : null;

      if (!serverUrl || !webappUrl) {
        throw new SystemTaskExecutionError(
          'relay_configuration_unavailable',
          'Could not resolve the currently selected server configuration.',
        );
      }

      return { serverUrl, webappUrl, localServerUrl };
    },
    createRecipeExecutor: ({ releaseRing }) => createSetupMachineRecipeExecutorFromHappierJsonExecutor({
      executor: createLocalHappierJsonExecutor({ releaseRing }),
    }),
    readBackgroundServiceSetupGuidance: async ({ targetReleaseChannel, targetServerUrl, currentRelayOwner }) => readBackgroundServiceSetupGuidance({
      targetReleaseChannel,
      targetServerUrl,
      currentRelayOwner,
      mode: 'user',
    }),
    readCurrentRelayOwner: async ({ releaseRing }) => {
      const executor = createLocalHappierJsonExecutor({ releaseRing });
      const parsed = await executor.runHappierJson(['service', 'status', '--json'], {
        allowJsonFailure: true,
      });
      const owner = parsed && typeof parsed === 'object'
        ? (parsed as { owner?: unknown }).owner
        : null;
      const normalized = readMachineDaemonOwnershipMetadataFromSocketAuth(owner);
      return normalized.serviceManaged === undefined
        && normalized.publicReleaseChannel === undefined
        && normalized.cliVersion === undefined
        ? null
        : normalized;
    },
    switchDefaultReleaseChannel: async (releaseChannel) => {
      await writeDefaultManagedReleaseChannel({
        processEnv: process.env,
        releaseChannel,
      });
      await syncInstalledFirstPartyShims({
        componentId: 'happier-cli',
        channel: releaseChannel,
        processEnv: process.env,
      });
    },
    stopCurrentManualRelayRuntime: async ({ releaseRing } = {}) => {
      const executor = createLocalHappierJsonExecutor({ releaseRing });
      await executor.runHappierJson(['daemon', 'stop', '--json']);
    },
    uninstallExistingDaemonServices: async () => {
      await runLocalHappierJsonCommand({
        args: ['service', 'uninstall', '--all', '--yes', '--json'],
      });
    },
    ...overrides,
  };
}
