import {
  applyBackgroundServiceSetupGuidance,
  type BackgroundServiceSetupGuidanceCancellationReason,
  ensureLocalFirstPartyComponentCommand,
  formatBackgroundServiceManualRelayTakeoverPrompt,
  formatBackgroundServiceReleaseChannelSwitchPrompt,
  formatBackgroundServiceReplacementPrompt,
  resolveBackgroundServiceSetupServicesRequiringReplacement,
  readBackgroundServiceSetupGuidance,
  readLocalCliUpdateFact,
  resolveBackgroundServiceSetupReconciliationDisposition,
  runEnrollMachineFlow,
  SystemTaskExecutionError,
  type BackgroundServiceSetupGuidance,
  type BackgroundServiceSetupServiceTarget,
  type HappierHomeServiceConvergence,
  type HappierServerScope,
  type HappierServiceFollowingScope,
  convergeHappierHomeServicesOntoCli,
  createLocalHappierJsonExecutor,
  readCurrentHappierServices,
  type LocalServerProfileScope,
  type InteractiveSystemTaskContext,
  type InteractiveSystemTaskKind,
  type EnrollMachineFlowExecutor,
  updateManagedLocalFirstPartyComponent,
} from '@happier-dev/cli-common/systemTasks';
import { resolveHappyHomeDirFromEnvironment } from '@happier-dev/cli-common/agents';
import type { HappierService } from '@happier-dev/cli-common/happierRuntime';
import {
  readSetupCliChoiceAnswer,
  type MachineDaemonOwnershipMetadata,
  type SetupCliChoicePromptData,
  type SystemTaskJsonObject,
} from '@happier-dev/protocol';
import {
  ensureHappierCliPathExposure,
  removeHappierCliPathExposure,
  syncInstalledFirstPartyShims,
  writeDefaultManagedReleaseChannel,
  writeHappierCliChoice,
  type HappierCliChoice,
  type HappierCliPathExposureResult,
  type FirstPartyAcquisitionOptions,
} from '@happier-dev/cli-common/firstPartyRuntime';
import {
  resolveCliInvokerNameForPublicRing,
  type PublicReleaseRingId,
} from '@happier-dev/release-runtime/releaseRings';

import { normalizeBootstrapChannel } from '../taskRuntime.js';
import { reportCliAcquisitionProgress } from '../cliAcquisitionProgress.js';
import {
  inspectLocalHappierCliChoice,
  ownCliCannotServeSetupError,
  type LocalHappierCliChoiceInspection,
} from '../happierCli.js';

import {
  createLocalSetupFlowExecutor,
  readLocalActiveRelayProfile,
  readLocalCurrentRelayOwner,
  readLocalServerProfileScopeForRelay,
  readLocalSetupCliAcquisition,
  type LocalSetupCliAcquisition,
  type LocalSetupRelayProfile,
} from './localSetupFlowExecutor.js';
import { resolveManagedCliBinDir } from './cliPathExposure.js';
import { requestTokenOnlyPairingApproval } from './tokenOnlyPairingApproval.js';

type SetupThisComputerRelayProfile = LocalSetupRelayProfile;

type CommandDiagnostics = Readonly<{
  command: string;
  args: readonly string[];
  details?: string;
}>;

function createBackgroundServiceSetupCancellationError(
  cancellationReason: BackgroundServiceSetupGuidanceCancellationReason | null,
): SystemTaskExecutionError {
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

function createInstrumentedFlowExecutor(
  ctx: Readonly<{
    emit: (event: Readonly<{
      type: string;
      stepId?: string;
      message?: string;
      data?: unknown;
    }>) => void;
  }>,
  params: Readonly<{
    takeOverManualRelayRuntime?: boolean;
    releaseRing?: PublicReleaseRingId;
  }>,
  flowExecutor: EnrollMachineFlowExecutor,
): EnrollMachineFlowExecutor {
  const takeoverArgs = params.takeOverManualRelayRuntime === true ? ['--takeover'] : [];
  const commandInvoker = resolveCliInvokerNameForPublicRing(params.releaseRing ?? 'stable');
  const requestAuthPairing = flowExecutor.requestAuthPairing;
  const waitForAuthPairing = flowExecutor.waitForAuthPairing;
  if (!requestAuthPairing || !waitForAuthPairing) {
    throw new SystemTaskExecutionError(
      'invalid_setup_executor',
      'Local setup requires the canonical pairing request and wait operations.',
    );
  }
  return {
    ...flowExecutor,
    async configureRelay(profile) {
      emitCommandDiagnostics(ctx, {
        stepId: 'setup.thisComputer.configureRelay',
        message: `Running ${commandInvoker} server set --json`,
        diagnostics: {
          command: commandInvoker,
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
      await flowExecutor.configureRelay(profile);
    },
    async readAuthStatus() {
      emitCommandDiagnostics(ctx, {
        stepId: 'setup.thisComputer.checkAuth',
        message: `Running ${commandInvoker} auth status --json`,
        diagnostics: {
          command: commandInvoker,
          args: ['auth', 'status', '--json'],
        },
      });
      return await flowExecutor.readAuthStatus();
    },
    async requestAuthPairing() {
      emitCommandDiagnostics(ctx, {
        stepId: 'setup.thisComputer.auth.request',
        message: `Running ${commandInvoker} auth request --json`,
        diagnostics: {
          command: commandInvoker,
          args: ['auth', 'request', '--json'],
        },
      });
      return await requestAuthPairing();
    },
    async waitForAuthPairing(publicKey) {
      emitCommandDiagnostics(ctx, {
        stepId: 'setup.thisComputer.auth.wait',
        message: `Running ${commandInvoker} auth wait --json`,
        diagnostics: {
          command: commandInvoker,
          args: ['auth', 'wait', '--public-key', '[redacted]', '--json'],
          details: publicKey ? 'Waiting for the local pairing request to be approved.' : undefined,
        },
      });
      return await waitForAuthPairing(publicKey);
    },
    async approveAuthPairing(publicKey, requestPayload) {
      if (!flowExecutor.approveAuthPairing) {
        return;
      }
      emitCommandDiagnostics(ctx, {
        stepId: 'setup.thisComputer.auth.request',
        message: `Running ${commandInvoker} auth approve --json`,
        diagnostics: {
          command: commandInvoker,
          args: ['auth', 'approve', '--public-key', '[redacted]', '--request-json-stdin', '--json'],
          details: publicKey ? 'Approving the local pairing request for this computer.' : undefined,
        },
      });
      await flowExecutor.approveAuthPairing(publicKey, requestPayload);
    },
    async installDaemonService(opts) {
      if (!flowExecutor.installDaemonService) {
        return;
      }
      const args = [
        'service',
        'install',
        ...((opts?.takeover ?? takeoverArgs.length > 0) ? ['--takeover'] : []),
        ...(opts?.replaceExisting ? ['--replace-existing=all', '--yes'] : []),
        '--json',
      ];
      emitCommandDiagnostics(ctx, {
        stepId: 'setup.thisComputer.installService',
        message: `Running ${commandInvoker} ${args.join(' ')}`,
        diagnostics: { command: commandInvoker, args },
      });
      await flowExecutor.installDaemonService(opts);
    },
    async startDaemonService(opts) {
      if (!flowExecutor.startDaemonService) {
        return;
      }
      const args = ['service', 'start', ...((opts?.takeover ?? takeoverArgs.length > 0) ? ['--takeover'] : []), '--json'];
      emitCommandDiagnostics(ctx, {
        stepId: 'setup.thisComputer.startService',
        message: `Running ${commandInvoker} ${args.join(' ')}`,
        diagnostics: { command: commandInvoker, args },
      });
      await flowExecutor.startDaemonService(opts);
    },
    async restartDaemonService() {
      if (!flowExecutor.restartDaemonService) {
        return;
      }
      emitCommandDiagnostics(ctx, {
        stepId: 'setup.thisComputer.restartService',
        message: `Running ${commandInvoker} service restart --json`,
        diagnostics: { command: commandInvoker, args: ['service', 'restart', '--json'] },
      });
      await flowExecutor.restartDaemonService();
    },
    async waitForReadyDaemon(params) {
      if (!flowExecutor.waitForReadyDaemon) {
        return {
          serviceInstalled: false,
          daemonRunning: false,
          needsAuth: true,
          machineId: null,
        };
      }
      emitCommandDiagnostics(ctx, {
        stepId: 'setup.thisComputer.verifyService',
        message: `Polling ${commandInvoker} daemon status --json`,
        diagnostics: {
          command: commandInvoker,
          args: ['daemon', 'status', '--json'],
          details: 'Checking whether the background service is installed, running, and authenticated for the selected Relay.',
        },
      });
      return await flowExecutor.waitForReadyDaemon(params);
    },
  };
}

export type SetupThisComputerInteractiveParams = Readonly<{
  surface?: string;
  target?: string;
  channel?: 'stable' | 'preview' | 'dev' | 'publicdev';
  activeRelayUrl?: string;
  activeWebappUrl?: string;
  activeLocalRelayUrl?: string | null;
  /** The explicit Home's server identity (RV-11): tells apart profiles that share its URL. */
  activeServerIdentityId?: string;
  activeAccountId?: string;
  installService?: boolean;
  startService?: boolean;
  verifyService?: boolean;
  /** Settings › This computer › Command line "Change": ask the one-CLI question again (R12). */
  reconsiderCli?: boolean;
  /**
   * The Personal Home recovery Retry after `cli_choice_service_convergence_failed`: with no question
   * to ask, the recorded answer is re-applied to every service of this home and ring (R12).
   */
  convergeCliChoice?: boolean;
}>;

/**
 * R12 — the one-CLI question and the two writes its answer makes. `record` and
 * `removePathExposure` change this computer (the choice record; the shell lines Desktop wrote), so
 * the production composition names them explicitly; a construction without this group asks
 * nothing, which only tests rely on.
 */
export type SetupCliChoiceDeps = Readonly<{
  inspect: (params: Readonly<{ reconsider?: boolean }>) => Promise<LocalHappierCliChoiceInspection>;
  record: (choice: HappierCliChoice) => Promise<void>;
  removePathExposure: () => Promise<void>;
  /** This computer's service inventory, read before the run touches any service. */
  readServices: () => Promise<readonly HappierService[]>;
  /**
   * Reinstalls every other service of this home and ring onto the CLI the resolver now answers with
   * (`convergeHappierHomeServicesOntoCli`), each at its own target.
   */
  convergeServices: (params: Readonly<{
    signal?: AbortSignal;
    services: readonly HappierService[];
    releaseRing: PublicReleaseRingId;
    exclude: HappierServerScope | HappierServiceFollowingScope | null;
  }>) => Promise<HappierHomeServiceConvergence>;
}>;

export type SetupThisComputerInteractiveDeps = Readonly<{
  cliChoice?: SetupCliChoiceDeps;
  /**
   * Acquires the managed `happier` CLI and reports which command was resolved and how. Only a
   * `managed` acquisition is approved for pairing without asking (R13); any other provenance is
   * confirmed by a human who is shown the resolved command (R8).
   */
  ensureLocalHappierTools: (params: FirstPartyAcquisitionOptions & Readonly<{ releaseChannel?: PublicReleaseRingId }>) => Promise<LocalSetupCliAcquisition>;
  readActiveRelayProfile: (params: Readonly<{ releaseRing?: PublicReleaseRingId }>) => Promise<SetupThisComputerRelayProfile>;
  createFlowExecutor: (params: Readonly<{
    signal?: AbortSignal;
    releaseRing?: PublicReleaseRingId;
    takeOverManualRelayRuntime?: boolean;
    /** Explicit-Home setup: save the profile without selecting it and scope every later command to it. */
    scopeToConfiguredServer?: boolean;
    /** The explicit Home's scope read before any write, so the executor never re-decides it. */
    knownServerScope?: LocalServerProfileScope | null;
  }>) => EnrollMachineFlowExecutor;
  /**
   * Read-only: which saved profile the explicit Home is and which server the terminal follows
   * (`server list --json`). Runs before any consent, so it must never write.
   */
  readServerProfileScope: (params: Readonly<{
    releaseRing?: PublicReleaseRingId;
    relayProfile: SetupThisComputerRelayProfile;
  }>) => Promise<LocalServerProfileScope>;
  readBackgroundServiceSetupGuidance: (params: Readonly<{
    targetReleaseChannel: PublicReleaseRingId;
    targetServerUrl: string;
    currentRelayOwner?: Pick<MachineDaemonOwnershipMetadata, 'serviceManaged' | 'publicReleaseChannel' | 'cliVersion'> | null;
    serviceTarget?: BackgroundServiceSetupServiceTarget;
    offerDefaultReleaseChannelSwitch?: boolean;
  }>) => Promise<BackgroundServiceSetupGuidance>;
  /**
   * The manual (non-service) daemon of the target: scoped to the explicit Home's own server when
   * given, because daemons are per-server and a manual daemon of another server never conflicts.
   */
  readCurrentRelayOwner: (params: Readonly<{ releaseRing?: PublicReleaseRingId; scope?: HappierServerScope }>) => Promise<Pick<
    MachineDaemonOwnershipMetadata,
    'serviceManaged' | 'publicReleaseChannel' | 'cliVersion'
  > | null>;
  switchDefaultReleaseChannel: (releaseChannel: PublicReleaseRingId) => Promise<void>;
  /**
   * Replaces this channel's managed CLI with the newer CLI its channel offers (cached update fact),
   * through the acquisition/install owner. Resolves `true` only when a different version was
   * installed. Used when the installed managed CLI cannot do token-only pairing (R3-3).
   */
  upgradeCliForTokenOnlyPairing: (params: FirstPartyAcquisitionOptions & Readonly<{ releaseChannel?: PublicReleaseRingId }>) => Promise<boolean>;
  /** Makes `happier` resolve in a new terminal. Ancillary: never gates readiness (see `run`). */
  exposeHappierCliOnPath: () => Promise<HappierCliPathExposureResult>;
}>;

/**
 * The deps whose real implementation mutates this machine: it installs the managed CLI, spawns the
 * CLI operations that rewrite the relay profile, credentials and OS service, rewrites the default
 * release channel, uninstalls existing services, or edits the user's shell startup files. They have
 * **no default**, so a construction that forgets one is a compile error rather than a silent run
 * against the developer's real machine. Read-only deps keep their defaults.
 */
type MutatingSetupThisComputerDepName =
  | 'ensureLocalHappierTools'
  | 'createFlowExecutor'
  | 'switchDefaultReleaseChannel'
  | 'exposeHappierCliOnPath'
  | 'upgradeCliForTokenOnlyPairing'
  | 'cliChoice'
  // Read-only, but it spawns the real CLI; required so a test can never reach the developer's machine.
  | 'readServerProfileScope';

export type SetupThisComputerInteractiveDepsInput =
  Pick<SetupThisComputerInteractiveDeps, MutatingSetupThisComputerDepName>
  & Partial<Omit<SetupThisComputerInteractiveDeps, MutatingSetupThisComputerDepName>>;

export function createSetupThisComputerInteractiveTaskKind(
  overrides: SetupThisComputerInteractiveDepsInput,
): InteractiveSystemTaskKind<Readonly<{ machineId: string }>> {
  const deps = createSetupThisComputerInteractiveDeps(overrides);

  return {
    async run(ctx) {
      const parsed = parseSetupThisComputerInteractiveParams(ctx.params);
      const releaseRing = parsed.channel ? normalizeBootstrapChannel(parsed.channel).releaseChannel : undefined;
      // R12: the first step, before anything is acquired or written.
      const answeredCliChoice = deps.cliChoice
        ? await askCliChoice(ctx, deps.cliChoice, {
          reconsider: parsed.reconsiderCli === true,
          reapplyRecorded: parsed.convergeCliChoice === true,
        })
        : null;
      ctx.signal?.throwIfAborted();
      ctx.emit({
        type: 'progress',
        stepId: 'setup.thisComputer.ensureCli',
        message: 'Installing Happier tools',
      });
      const cli = await deps.ensureLocalHappierTools({
        releaseChannel: releaseRing,
        signal: ctx.signal,
        onProgress: reportCliAcquisitionProgress(ctx.emit),
      });
      ctx.signal?.throwIfAborted();
      ctx.emit({
        type: 'progress',
        stepId: 'setup.thisComputer.resolveRelay',
        message: 'Resolving server configuration',
      });
      const explicitRelayProfile = resolveExplicitRelayProfile(parsed);
      const relayProfile = explicitRelayProfile ?? await deps.readActiveRelayProfile({ releaseRing });
      // R10 D3: an explicitly selected Home (the desktop's Personal Home) gets its own pinned
      // service beside whatever the user set up themselves, and setup never switches the
      // terminal's active server. Only when the terminal already follows this very server is the
      // existing default-following service the one that serves it. Read-only: nothing is written
      // before consent.
      const profileScope = explicitRelayProfile
        ? await deps.readServerProfileScope({ releaseRing, relayProfile: explicitRelayProfile })
        : null;
      const serviceTarget: BackgroundServiceSetupServiceTarget | undefined = profileScope
        ? profileScope.targetMode === 'pinned'
          ? { targetMode: 'pinned', serverId: profileScope.serverId }
          : { targetMode: 'default-following', followedServerId: profileScope.activeServerId }
        : undefined;
      let guidance: BackgroundServiceSetupGuidance | null = null;
      let shouldTakeOverManualRelayRuntime = false;
      let shouldReplaceExistingServices = false;
      if (parsed.installService !== false) {
        const targetReleaseChannel = releaseRing ?? 'stable';
        const currentRelayOwner = profileScope
          ? profileScope.serverId
            ? await deps.readCurrentRelayOwner({
              releaseRing,
              scope: { serverId: profileScope.serverId, targetMode: profileScope.targetMode },
            })
            // No saved profile yet: no daemon of this Home can be running.
            : null
          : await deps.readCurrentRelayOwner({ releaseRing });
        const readGuidance = await deps.readBackgroundServiceSetupGuidance({
          targetReleaseChannel,
          targetServerUrl: relayProfile.serverUrl,
          currentRelayOwner,
          ...(serviceTarget ? { serviceTarget, offerDefaultReleaseChannelSwitch: false } : {}),
        });
        guidance = readGuidance;

        const guidanceResult = await applyBackgroundServiceSetupGuidance({
          guidance: readGuidance,
          promptSwitchDefaultReleaseChannel: async () => {
            const answer = await ctx.prompt({
              kind: 'releaseChannel.switchDefaultForSetup',
              stepId: 'setup.thisComputer.preflight.releaseChannel',
              message: formatBackgroundServiceReleaseChannelSwitchPrompt(readGuidance),
              data: {
                targetReleaseChannel: readGuidance.targetReleaseChannel,
                currentDefaultReleaseChannel: readGuidance.currentDefaultReleaseChannel,
                targetServerUrl: readGuidance.targetServerUrl,
                managedReleaseChannels: readGuidance.managedReleaseChannels,
              },
            }) as { switchDefaultReleaseChannel?: boolean };
            return answer.switchDefaultReleaseChannel === true;
          },
          promptTakeOverManualRelayRuntime: async () => {
            const answer = await ctx.prompt({
              kind: 'daemon.takeOverManualRelayRuntimeForSetup',
              stepId: 'setup.thisComputer.preflight.manualRelayTakeover',
              message: formatBackgroundServiceManualRelayTakeoverPrompt(readGuidance),
              data: {
                targetServerUrl: readGuidance.targetServerUrl,
                targetReleaseChannel: readGuidance.targetReleaseChannel,
                currentReleaseChannel: readGuidance.manualRelayOwner?.currentReleaseChannel ?? null,
                currentCliVersion: readGuidance.manualRelayOwner?.currentCliVersion ?? null,
              },
            }) as { takeOverManualRelayRuntime?: boolean };
            return answer.takeOverManualRelayRuntime === true;
          },
          promptReplaceExistingServices: async () => {
            const answer = await ctx.prompt({
              kind: 'daemon.replaceLocalBackgroundServices',
              stepId: 'setup.thisComputer.preflight.serviceConflict',
              message: formatBackgroundServiceReplacementPrompt(readGuidance),
              data: {
                targetServerUrl: readGuidance.targetServerUrl,
                targetReleaseChannel: readGuidance.targetReleaseChannel,
                services: resolveBackgroundServiceSetupServicesRequiringReplacement(readGuidance),
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
            shouldTakeOverManualRelayRuntime = true;
          },
          // The accepted replacement is applied by the install itself (`--replace-existing=all`),
          // which removes only this target's conflicting services (R3-7).
          replaceExistingServices: async () => {
            shouldReplaceExistingServices = true;
          },
        });

        if (guidanceResult.cancelled) {
          throw createBackgroundServiceSetupCancellationError(guidanceResult.cancellationReason);
        }

        shouldTakeOverManualRelayRuntime = guidanceResult.tookOverManualRelayRuntime;
      }

      // Terminal exposure edits the user's shell startup files — the one write this task makes
      // outside Happier's own directories — so it starts only once consent has settled (D4/R12):
      // a declined conflict prompt must not leave a Desktop PATH line behind.
      //
      // From here it runs beside the remaining service work and nothing waits for it (R6/L6): the
      // app starts its readiness proof from this task's result, so awaiting a shell-profile write
      // would hold the reveal — and a wedged `powershell.exe` or a hung append on a network home
      // would hold it forever. The failure is reported on this run's own event stream just before
      // the result when it has settled by then (the common case, against seconds of pairing and
      // service work); machine settings › Terminal owns reading and repairing PATH either way,
      // through the `cli.pathExposure.*` kinds.
      const pathExposure = observePathExposure(deps.exposeHappierCliOnPath());

      const settledGuidance = guidance;

      // The flow configures the explicit relay before it reads auth status and pairs, so the
      // terminal always targets the Home that is being approved. Each run builds its executor
      // fresh, so a retry after a CLI replacement drives the new CLI.
      const runFlow = async () => await runEnrollMachineFlow({
        relayProfile,
        ...(parsed.activeAccountId ? { expectedAccountId: parsed.activeAccountId } : {}),
        executor: createInstrumentedFlowExecutor(
          ctx,
          { releaseRing, takeOverManualRelayRuntime: shouldTakeOverManualRelayRuntime },
          deps.createFlowExecutor({
            signal: ctx.signal,
            releaseRing,
            takeOverManualRelayRuntime: shouldTakeOverManualRelayRuntime,
            ...(explicitRelayProfile ? { scopeToConfiguredServer: true, knownServerScope: profileScope } : {}),
          }),
        ),
        steps: {
          installService: parsed.installService,
          startService: parsed.startService,
          verifyService: parsed.verifyService,
        },
        // One service policy for desktop and terminal setup (R3-6): the disposition owner decides
        // install/start/restart from the observed service and whether this run paired.
        ...(settledGuidance && parsed.startService !== false
          ? {
            serviceActions: ({ paired }: Readonly<{ paired: boolean }>) => resolveBackgroundServiceSetupReconciliationDisposition({
              guidance: settledGuidance,
              targetChanged: paired,
              tookOverManualRelayRuntime: shouldTakeOverManualRelayRuntime,
              replacedExistingServices: shouldReplaceExistingServices,
              // The R12 answer given in this run is the consent to switch the service's CLI.
              runtimeChanged: answeredCliChoice !== null,
            }),
          }
          : {}),
        stepIds: {
          configureRelay: 'setup.thisComputer.configureRelay',
          authWait: 'setup.thisComputer.auth.wait',
          installService: 'setup.thisComputer.installService',
          startService: 'setup.thisComputer.startService',
          restartService: 'setup.thisComputer.restartService',
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
          // One blocking approval: the answering UI posts the opaque token-only response to the
          // explicit Home endpoint with its own Home-scoped bearer and answers without any
          // credential material. The terminal claim independently mints its own token.
          const decision = await requestTokenOnlyPairingApproval({
            ctx,
            stepId: 'setup.thisComputer.auth.request',
            message: 'Approve this computer in Happier to continue',
            publicKey: inner.publicKey,
            requestPayload: inner.requestPayload,
            target: relayProfile,
            cli,
          });
          // Both outcomes fail by name, exactly as local repair does. There is no second,
          // non-blocking approval surface to fall back to: nothing reads such a prompt, so
          // emitting one only replaced a named failure with a silent wait for the executor
          // timeout, and a declined approval must stop the run rather than proceed unpaired.
          if (decision === null) {
            throw new SystemTaskExecutionError(
              'pairing_approval_unavailable',
              'The Happier CLI did not provide token-only pairing material, so this computer cannot be approved automatically.',
            );
          }
          if (!decision.approved) {
            throw new SystemTaskExecutionError('approval_declined', describePairingRefusal(decision.reason));
          }
        },
        daemonReadinessErrorMessage: 'Background service did not reach a ready state for the selected Relay.',
      });

      // R12: the services this run does not converge itself, as they were before it touched any.
      const servicesBeforeRun = answeredCliChoice && deps.cliChoice ? await deps.cliChoice.readServices() : null;

      let flowResult: Awaited<ReturnType<typeof runFlow>>;
      try {
        flowResult = await runFlow();
      } catch (error) {
        // R3-3: a managed CLI that predates token-only pairing (or profile-scoped setup) is replaced
        // by the newer CLI on its channel through the acquisition owner, and setup runs once more
        // with it. The CLI's own answers are the capability proof: the retry fails by name again if
        // the newer CLI still lacks it. Any other CLI is never replaced here.
        const code = error instanceof SystemTaskExecutionError ? error.code : null;
        const capabilityMissing = code === 'pairing_approval_unavailable' || code === 'cli_capability_missing';
        if (capabilityMissing && cli.command && isKeptCliCommand(answeredCliChoice, cli.command)) {
          // The person's own CLI is theirs to update (R12): name the command, replace nothing.
          throw ownCliCannotServeSetupError(cli.command, null);
        }
        if (!capabilityMissing || cli.provenance !== 'managed') {
          throw error;
        }
        ctx.emit({
          type: 'progress',
          stepId: 'setup.thisComputer.ensureCli',
          message: 'Updating Happier tools for automatic pairing',
        });
        const upgraded = await deps.upgradeCliForTokenOnlyPairing({
          releaseChannel: releaseRing,
          signal: ctx.signal,
          onProgress: reportCliAcquisitionProgress(ctx.emit),
        });
        if (!upgraded) throw error;
        ctx.signal?.throwIfAborted();
        flowResult = await runFlow();
      }

      if (servicesBeforeRun && deps.cliChoice) {
        // One CLI per home and ring: every other service of this home follows the answer too, each
        // at its own target; the one this run set up was converged by the flow above.
        const convergence = await deps.cliChoice.convergeServices({
          signal: ctx.signal,
          services: servicesBeforeRun,
          releaseRing: releaseRing ?? 'stable',
          exclude: profileScope
            ? profileScope.serverId
              ? { serverId: profileScope.serverId, targetMode: profileScope.targetMode }
              : null
            : { serverId: null, targetMode: 'default-following' },
        });
        if (convergence.failed.length > 0) {
          throw new SystemTaskExecutionError(
            'cli_choice_service_convergence_failed',
            `This computer's background services could not all be moved to the chosen Happier CLI: ${convergence.failed.map((failure) => `${failure.label} (${failure.message})`).join('; ')}`,
          );
        }
      }

      const machineId = flowResult.machineId;
      if (!machineId) {
        throw new SystemTaskExecutionError(
          'machine_id_unavailable',
          'Authenticated server session did not expose a machineId for this computer.',
        );
      }

      const pathExposureFailure = pathExposure.readFailure();
      if (pathExposureFailure) {
        // No stepId: this is not a step of the setup sequence, and the PATH surface that owns the
        // outcome is `cli.pathExposure.*`. The message still reaches the run's latest message.
        ctx.emit({
          type: 'progress',
          message: `Could not add happier to your PATH: ${pathExposureFailure}`,
        });
      }

      return { machineId };
    },
  };
}

/**
 * Asks R12's question when the inspection has one, and applies the answer's two writes. Returns the
 * answer given in this run (`null` when nothing was asked). Every refusal happens before a write,
 * except a kept CLI that cannot serve setup: that answer is the person's and is recorded, and setup
 * then stops naming its update command — the question comes back until it can.
 */
async function askCliChoice(
  ctx: InteractiveSystemTaskContext,
  deps: SetupCliChoiceDeps,
  params: Readonly<{ reconsider: boolean; reapplyRecorded: boolean }>,
): Promise<HappierCliChoice | null> {
  const { choice: recorded, question } = await deps.inspect(params.reconsider ? { reconsider: true } : {});
  // Nothing to ask: only a recovery retry re-applies the recorded answer (no writes to the record).
  if (!question) return params.reapplyRecorded ? recorded : null;
  const answer = readSetupCliChoiceAnswer(await ctx.prompt({
    kind: 'setup.cliChoice',
    stepId: 'setup.thisComputer.cliChoice',
    message: question.version
      ? `Happier CLI ${question.version} is already installed at ${question.command}.`
      : `A Happier CLI is already installed at ${question.command}.`,
    data: question satisfies SetupCliChoicePromptData as SystemTaskJsonObject,
  }));
  if (answer === null) {
    throw new SystemTaskExecutionError(
      'cli_choice_unanswered',
      'Setup stopped before changing anything: choose who manages the Happier command line to continue.',
    );
  }
  if (answer === 'own' && question.keepBlockedBy) {
    throw new SystemTaskExecutionError(
      'cli_choice_unanswered',
      `New terminals run Happier's CLI first through ${question.keepBlockedBy}, which Happier didn't add, so ${question.command} cannot be kept. Setup stopped before changing anything.`,
    );
  }
  if (answer === 'own' && question.missing) {
    throw new SystemTaskExecutionError(
      'cli_own_missing',
      `The Happier CLI this computer keeps is no longer at ${question.command}. Reinstall it, or let Happier manage the command line. Nothing was changed.`,
    );
  }
  const choice: HappierCliChoice = answer === 'own' ? { mode: 'own', command: question.command } : { mode: 'managed' };
  await deps.record(choice);
  if (choice.mode === 'own') {
    // The terminal keeps the person's CLI: take back only the lines Desktop wrote (INV5).
    await deps.removePathExposure();
    if (question.belowSetupFloor) {
      throw ownCliCannotServeSetupError(question.command, question.version, question.updateCommand);
    }
  }
  return choice;
}

function isKeptCliCommand(answered: HappierCliChoice | null, command: string): boolean {
  return answered?.mode === 'own' && answered.command === command;
}

/**
 * The user-facing half of a refused approval. The approval owner names *why* it refused; only one
 * of those reasons is an actual human decline, so the message says which it was.
 */
function describePairingRefusal(reason: string | null): string {
  return reason
    ? `This computer was not approved for pairing (${reason}).`
    : 'This computer was not approved for pairing.';
}

/**
 * Watches an ancillary promise without ever awaiting it, so its outcome can be reported if it has
 * settled by the time the task finishes and simply dropped if it has not. Rejections are read as
 * failures here because a shell-profile write must never fail this task.
 */
function observePathExposure(
  exposure: Promise<HappierCliPathExposureResult>,
): Readonly<{ readFailure: () => string | null }> {
  let failure: string | null = null;
  void exposure.then(
    (outcome) => {
      failure = outcome.failure;
    },
    (error: unknown) => {
      failure = error instanceof Error && error.message.trim() ? error.message.trim() : 'PATH exposure failed.';
    },
  );
  return { readFailure: () => failure };
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
    activeRelayUrl?: string;
    activeWebappUrl?: string;
    activeLocalRelayUrl?: string | null;
    activeServerIdentityId?: string;
    activeAccountId?: string;
    installService?: boolean;
    startService?: boolean;
    verifyService?: boolean;
    reconsiderCli?: boolean;
    convergeCliChoice?: boolean;
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
  if ('activeRelayUrl' in record) {
    if (typeof record.activeRelayUrl !== 'string') {
      throw new SystemTaskExecutionError('invalid_params', 'Expected activeRelayUrl to be a string.');
    }
    const activeRelayUrl = record.activeRelayUrl.trim();
    if (!activeRelayUrl) {
      throw new SystemTaskExecutionError('invalid_params', 'activeRelayUrl cannot be empty.');
    }
    parsed.activeRelayUrl = activeRelayUrl;
  }
  if ('activeWebappUrl' in record) {
    if (typeof record.activeWebappUrl !== 'string') {
      throw new SystemTaskExecutionError('invalid_params', 'Expected activeWebappUrl to be a string.');
    }
    const activeWebappUrl = record.activeWebappUrl.trim();
    if (!activeWebappUrl) {
      throw new SystemTaskExecutionError('invalid_params', 'activeWebappUrl cannot be empty.');
    }
    parsed.activeWebappUrl = activeWebappUrl;
  }
  if ('activeLocalRelayUrl' in record) {
    parsed.activeLocalRelayUrl = record.activeLocalRelayUrl == null
      ? null
      : String(record.activeLocalRelayUrl).trim() || null;
  }
  if ('activeServerIdentityId' in record && record.activeServerIdentityId != null) {
    if (typeof record.activeServerIdentityId !== 'string' || !record.activeServerIdentityId.trim()) {
      throw new SystemTaskExecutionError('invalid_params', 'activeServerIdentityId must be a non-empty string when provided.');
    }
    parsed.activeServerIdentityId = record.activeServerIdentityId.trim();
  }
  if ('activeAccountId' in record && record.activeAccountId != null) {
    if (typeof record.activeAccountId !== 'string' || !record.activeAccountId.trim()) {
      throw new SystemTaskExecutionError('invalid_params', 'activeAccountId must be a non-empty string when provided.');
    }
    parsed.activeAccountId = record.activeAccountId.trim();
  }
  if (parsed.activeRelayUrl && !parsed.activeWebappUrl) {
    throw new SystemTaskExecutionError('invalid_params', 'activeWebappUrl is required when activeRelayUrl is provided.');
  }
  if (parsed.activeWebappUrl && !parsed.activeRelayUrl) {
    throw new SystemTaskExecutionError('invalid_params', 'activeRelayUrl is required when activeWebappUrl is provided.');
  }
  // R3: a desktop surface must name the Home it selected. The ambient fallback below reads the
  // CLI's own currently selected relay, which for `desktop.ui` would silently repoint this
  // machine's daemon at whatever the terminal happened to be configured for instead of the Home
  // the app is setting up. The app always sends it, so a spec that omits it is malformed rather
  // than a case to guess at. A terminal `hsetup` run has no app selection and keeps the fallback.
  if (parsed.surface === 'desktop.ui' && !parsed.activeRelayUrl) {
    throw new SystemTaskExecutionError(
      'invalid_params',
      'activeRelayUrl is required for surface desktop.ui.',
    );
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
  if ('reconsiderCli' in record) {
    if (typeof record.reconsiderCli !== 'boolean') {
      throw new SystemTaskExecutionError('invalid_params', 'Expected reconsiderCli to be a boolean.');
    }
    parsed.reconsiderCli = record.reconsiderCli;
  }
  if ('convergeCliChoice' in record) {
    if (typeof record.convergeCliChoice !== 'boolean') {
      throw new SystemTaskExecutionError('invalid_params', 'Expected convergeCliChoice to be a boolean.');
    }
    parsed.convergeCliChoice = record.convergeCliChoice;
  }
  return parsed;
}

function resolveExplicitRelayProfile(params: SetupThisComputerInteractiveParams): SetupThisComputerRelayProfile | null {
  if (!params.activeRelayUrl || !params.activeWebappUrl) {
    return null;
  }
  return {
    serverUrl: params.activeRelayUrl,
    webappUrl: params.activeWebappUrl,
    localServerUrl: params.activeLocalRelayUrl ?? null,
    ...(params.activeServerIdentityId ? { serverIdentityId: params.activeServerIdentityId } : {}),
  };
}

function createSetupThisComputerInteractiveDeps(
  overrides: SetupThisComputerInteractiveDepsInput,
): SetupThisComputerInteractiveDeps {
  return {
    readActiveRelayProfile: readLocalActiveRelayProfile,
    readBackgroundServiceSetupGuidance: async (params) => readBackgroundServiceSetupGuidance({
      ...params,
      mode: 'user',
    }),
    readCurrentRelayOwner: readLocalCurrentRelayOwner,
    ...overrides,
  };
}

/**
 * The one production composition of the mutating deps. `hsetup` passes this explicitly, so the real
 * installer, CLI executor, release-channel writer, service uninstaller and shell-profile writer are
 * only ever reachable through a named production wiring — never through an omitted test stub.
 */
export function createProductionSetupThisComputerInteractiveDeps(): Pick<
  SetupThisComputerInteractiveDeps,
  MutatingSetupThisComputerDepName
> {
  return {
    ensureLocalHappierTools: async ({ releaseChannel, signal, onProgress }) => {
      await ensureLocalFirstPartyComponentCommand({
        componentId: 'happier-cli',
        processEnv: process.env,
        releaseRing: releaseChannel,
        signal,
        onProgress,
      });
      await syncInstalledFirstPartyShims({
        componentId: 'happier-cli',
        channel: releaseChannel,
        processEnv: process.env,
      });
      return readLocalSetupCliAcquisition({ ...(releaseChannel ? { releaseRing: releaseChannel } : {}) });
    },
    createFlowExecutor: createLocalSetupFlowExecutor,
    upgradeCliForTokenOnlyPairing: async ({ releaseChannel, signal, onProgress }) => {
      const fact = readLocalCliUpdateFact({ ...(releaseChannel ? { releaseRing: releaseChannel } : {}) });
      if (!fact?.managed || !fact.updateAvailable) return false;
      const updated = await updateManagedLocalFirstPartyComponent({
        componentId: 'happier-cli',
        processEnv: process.env,
        ...(releaseChannel ? { releaseRing: releaseChannel } : {}),
        signal,
        onProgress,
      });
      return updated.version !== updated.previousVersion;
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
    readServerProfileScope: readLocalServerProfileScopeForRelay,
    cliChoice: {
      inspect: async ({ reconsider }) => await inspectLocalHappierCliChoice({ processEnv: process.env, ...(reconsider ? { reconsider } : {}) }),
      record: async (choice) => await writeHappierCliChoice({ choice, processEnv: process.env }),
      removePathExposure: async () => {
        const removed = await removeHappierCliPathExposure({ processEnv: process.env });
        if (removed.failure) {
          throw new SystemTaskExecutionError('cli_path_exposure_failed', removed.failure);
        }
      },
      readServices: readCurrentHappierServices,
      convergeServices: async ({ services, releaseRing, exclude, signal }) => await convergeHappierHomeServicesOntoCli({
        // The resolver answers with the chosen CLI, so its own `service install` rewrites each launcher.
        executor: createLocalHappierJsonExecutor({ releaseRing, signal }),
        services,
        happierHomeDir: resolveHappyHomeDirFromEnvironment(process.env),
        releaseRing,
        exclude,
      }),
    },
    exposeHappierCliOnPath: async () => await ensureHappierCliPathExposure({
      binDir: resolveManagedCliBinDir(process.env),
      processEnv: process.env,
    }),
  };
}
