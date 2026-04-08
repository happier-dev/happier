import {
  discoverHappierInstallations,
  discoverHappierServices,
  deriveManagedReleaseChannelInventory,
} from '@happier-dev/cli-common/happierRuntime';
import {
  buildBackgroundServiceSetupGuidance,
  createLocalHappierJsonExecutor,
  createSetupMachineRecipeExecutorFromHappierJsonExecutor,
  runSetupMachineRecipe,
  SystemTaskExecutionError,
  type BackgroundServiceSetupGuidance,
  type InteractiveSystemTaskKind,
  type SetupMachineRecipeExecutor,
} from '@happier-dev/cli-common/systemTasks';
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

export type SetupThisComputerInteractiveParams = Readonly<{
  surface?: string;
  target?: string;
  channel?: 'stable' | 'preview' | 'dev' | 'publicdev';
  installService?: boolean;
  startService?: boolean;
  verifyService?: boolean;
}>;

export type SetupThisComputerInteractiveDeps = Readonly<{
  readActiveRelayProfile: (params: Readonly<{ releaseRing?: PublicReleaseRingId }>) => Promise<SetupThisComputerRelayProfile>;
  createRecipeExecutor: (params: Readonly<{ releaseRing?: PublicReleaseRingId }>) => SetupMachineRecipeExecutor;
  readBackgroundServiceSetupGuidance: (params: Readonly<{
    targetReleaseChannel: PublicReleaseRingId;
    targetServerUrl: string;
  }>) => Promise<BackgroundServiceSetupGuidance>;
  switchDefaultReleaseChannel: (releaseChannel: PublicReleaseRingId) => Promise<void>;
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
        stepId: 'setup.thisComputer.resolveRelay',
        message: 'Resolving Relay configuration',
      });
      const relayProfile = await deps.readActiveRelayProfile({ releaseRing });
      const recipeExecutor = deps.createRecipeExecutor({ releaseRing });
      ctx.emit({
        type: 'progress',
        stepId: 'setup.thisComputer.checkAuth',
        message: 'Checking authentication',
      });
      const authStatus = await recipeExecutor.readAuthStatus();

      if (parsed.installService !== false) {
        const targetReleaseChannel = releaseRing ?? 'stable';
        const guidance = await deps.readBackgroundServiceSetupGuidance({
          targetReleaseChannel,
          targetServerUrl: relayProfile.serverUrl,
        });

        if (guidance.shouldOfferDefaultReleaseChannelSwitch) {
          const answer = await ctx.prompt({
            kind: 'releaseChannel.switchDefaultForSetup',
            stepId: 'setup.thisComputer.preflight.releaseChannel',
            message: `Make ${guidance.targetReleaseChannel} the default release-channel before installing the background service for ${guidance.targetServerUrl ?? 'the current Relay'}?`,
            data: {
              targetReleaseChannel: guidance.targetReleaseChannel,
              currentDefaultReleaseChannel: guidance.currentDefaultReleaseChannel,
              targetServerUrl: guidance.targetServerUrl,
              managedReleaseChannels: guidance.managedReleaseChannels,
            },
          }) as { switchDefaultReleaseChannel?: boolean };

          if (answer.switchDefaultReleaseChannel === true) {
            await deps.switchDefaultReleaseChannel(targetReleaseChannel);
          }
        }

        if (guidance.shouldPromptForServiceReplacement) {
          const answer = await ctx.prompt({
            kind: 'daemon.replaceLocalBackgroundServices',
            stepId: 'setup.thisComputer.preflight.serviceConflict',
            message: `This computer already has conflicting Happier background services for ${guidance.targetServerUrl ?? 'the current Relay'}. Replace them before continuing?`,
            data: {
              targetServerUrl: guidance.targetServerUrl,
              targetReleaseChannel: guidance.targetReleaseChannel,
              services: guidance.conflictingServices,
            },
          }) as { replaceExistingServices?: boolean };

          if (answer.replaceExistingServices === true) {
            await deps.uninstallExistingDaemonServices();
          } else {
            throw new SystemTaskExecutionError(
              'background_service_conflict_declined',
              'Setup was cancelled because existing background services were kept.',
            );
          }
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
        daemonReadinessErrorMessage: 'Daemon service did not reach a ready state for the selected Relay.',
      });

      const machineId = recipeResult.machineId;
      if (!machineId) {
        throw new SystemTaskExecutionError(
          'machine_id_unavailable',
          'Authenticated Relay session did not expose a machineId for this computer.',
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

function resolveCurrentPlatform(): 'darwin' | 'linux' | 'win32' {
  return process.platform === 'darwin' || process.platform === 'linux' || process.platform === 'win32'
    ? process.platform
    : 'darwin';
}

function createSetupThisComputerInteractiveDeps(
  overrides: Partial<SetupThisComputerInteractiveDeps>,
): SetupThisComputerInteractiveDeps {
  return {
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
          'Could not resolve the currently selected Relay configuration.',
        );
      }

      return { serverUrl, webappUrl, localServerUrl };
    },
    createRecipeExecutor: ({ releaseRing }) => createSetupMachineRecipeExecutorFromHappierJsonExecutor({
      executor: createLocalHappierJsonExecutor({ releaseRing }),
    }),
    readBackgroundServiceSetupGuidance: async ({ targetReleaseChannel, targetServerUrl }) => {
      const installations = await discoverHappierInstallations({
        processEnv: process.env,
        invokedPath: process.execPath,
      });
      const managedReleaseChannels = await deriveManagedReleaseChannelInventory({
        inventory: installations,
        processEnv: process.env,
      });
      const services = await discoverHappierServices({
        processEnv: process.env,
        platform: resolveCurrentPlatform(),
      });
      return buildBackgroundServiceSetupGuidance({
        targetReleaseChannel,
        targetServerUrl,
        managedReleaseChannelInventory: managedReleaseChannels,
        services: services.services,
        platform: resolveCurrentPlatform(),
        mode: 'user',
      });
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
    uninstallExistingDaemonServices: async () => {
      await runLocalHappierJsonCommand({
        args: ['service', 'uninstall', '--all', '--yes', '--json'],
      });
    },
    ...overrides,
  };
}
