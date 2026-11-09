import {
  readBackgroundServiceSetupGuidance,
  resolveBackgroundServiceSetupReconciliationDisposition,
  runEnrollMachineFlow,
  SystemTaskExecutionError,
  type BackgroundServiceSetupGuidance,
  type BackgroundServiceSetupServiceTarget,
  type InteractiveSystemTaskKind,
  type LocalServerProfileScope,
  type EnrollMachineFlowExecutor,
} from '@happier-dev/cli-common/systemTasks';
import type { PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';

import { normalizeBootstrapChannel } from '../taskRuntime.js';

import {
  createLocalSetupFlowExecutor,
  readLocalActiveRelayProfile,
  readLocalServerProfileScopeForRelay,
  readLocalSetupCliAcquisition,
  type LocalSetupCliAcquisition,
  type LocalSetupRelayProfile,
} from './localSetupFlowExecutor.js';
import { requestTokenOnlyPairingApproval } from './tokenOnlyPairingApproval.js';

export type SetupRepairThisComputerParams = Readonly<{
  /** Relay/server URL the background service must connect to. Absent: the CLI's current relay profile. */
  activeRelayUrl?: string;
  /** Webapp URL for the active relay. Defaults to `activeRelayUrl`. */
  activeWebappUrl?: string;
  activeLocalRelayUrl?: string | null;
  /** The explicit Home's server identity (RV-11): tells apart profiles that share its URL. */
  activeServerIdentityId?: string;
  activeAccountId?: string;
  channel?: 'stable' | 'preview' | 'dev' | 'publicdev';
  surface?: string;
}>;

export type SetupRepairThisComputerInteractiveDeps = Readonly<{
  readActiveRelayProfile: (params: Readonly<{ releaseRing?: PublicReleaseRingId }>) => Promise<LocalSetupRelayProfile>;
  createFlowExecutor: (params: Readonly<{
    signal?: AbortSignal;
    releaseRing?: PublicReleaseRingId;
    scopeToConfiguredServer?: boolean;
    knownServerScope?: LocalServerProfileScope | null;
  }>) => EnrollMachineFlowExecutor;
  /** Read-only resolution of the explicit Home's saved profile; spawns the real CLI, so it has no default. */
  readServerProfileScope: (params: Readonly<{
    releaseRing?: PublicReleaseRingId;
    relayProfile: LocalSetupRelayProfile;
  }>) => Promise<LocalServerProfileScope>;
  readBackgroundServiceSetupGuidance: (params: Readonly<{
    targetReleaseChannel: PublicReleaseRingId;
    targetServerUrl: string;
    serviceTarget?: BackgroundServiceSetupServiceTarget;
    offerDefaultReleaseChannelSwitch?: boolean;
  }>) => Promise<BackgroundServiceSetupGuidance>;
  /**
   * Which `happier` CLI will perform the repair and how it was acquired. Only `managed` is
   * approved for pairing without asking; any other provenance is confirmed by a human who is
   * shown the resolved command (R8/R13).
   */
  readCliAcquisition: (params: Readonly<{ releaseRing?: PublicReleaseRingId }>) => LocalSetupCliAcquisition;
}>;

const REPAIR_PARAM_KEYS = ['activeRelayUrl', 'activeWebappUrl', 'activeLocalRelayUrl', 'activeServerIdentityId', 'activeAccountId', 'channel', 'surface'] as const;

function parseSetupRepairThisComputerParams(params: unknown): SetupRepairThisComputerParams {
  if (params == null) {
    return {};
  }
  if (typeof params !== 'object' || Array.isArray(params)) {
    throw new SystemTaskExecutionError('invalid_params', 'Invalid setup repair params.');
  }
  const record = params as Record<string, unknown>;
  if (Object.keys(record).some((key) => !(REPAIR_PARAM_KEYS as readonly string[]).includes(key))) {
    throw new SystemTaskExecutionError('invalid_params', 'Unsupported setup repair params.');
  }
  const readOptionalString = (key: typeof REPAIR_PARAM_KEYS[number]): string | undefined => {
    const value = record[key];
    if (value == null) return undefined;
    if (typeof value !== 'string') {
      throw new SystemTaskExecutionError('invalid_params', 'Invalid setup repair params.');
    }
    return value.trim() || undefined;
  };
  const activeRelayUrl = readOptionalString('activeRelayUrl');
  const activeWebappUrl = readOptionalString('activeWebappUrl');
  const activeLocalRelayUrl = readOptionalString('activeLocalRelayUrl');
  const activeServerIdentityId = readOptionalString('activeServerIdentityId');
  const activeAccountId = readOptionalString('activeAccountId');
  const channel = readOptionalString('channel');
  const surface = readOptionalString('surface');
  if (channel !== undefined && channel !== 'stable' && channel !== 'preview' && channel !== 'dev' && channel !== 'publicdev') {
    throw new SystemTaskExecutionError('invalid_params', `Unsupported channel: ${channel}`);
  }
  // R3, same rule and same reason as `setup.thisComputer.v1`: a desktop surface must name the Home
  // it selected. Falling back to the CLI's own currently selected relay would repoint this
  // machine's daemon at whatever the terminal happened to be configured for. Every TS producer
  // already sends it; a terminal repair run has no app selection and keeps the ambient fallback.
  if (surface === 'desktop.ui' && !activeRelayUrl) {
    throw new SystemTaskExecutionError(
      'invalid_params',
      'activeRelayUrl is required for surface desktop.ui.',
    );
  }
  return {
    ...(activeRelayUrl ? { activeRelayUrl } : {}),
    ...(activeWebappUrl ? { activeWebappUrl } : {}),
    ...(activeLocalRelayUrl ? { activeLocalRelayUrl } : {}),
    ...(activeServerIdentityId ? { activeServerIdentityId } : {}),
    ...(activeAccountId ? { activeAccountId } : {}),
    ...(channel ? { channel } : {}),
    ...(surface ? { surface } : {}),
  };
}

/**
 * Local drift/needs-auth repair: the same canonical local-machine flow as `setup.thisComputer.v1`
 * (configure the explicit relay → pair → install → start → prove readiness) without the guided
 * service-conflict preflight, on the repair step ids. Pairing is approved through the same blocking
 * token-only prompt the desktop approval owner already answers for local setup; a missing token-only
 * material or a declined answer fails with a named error instead of waiting on nothing.
 */
/**
 * `createFlowExecutor` is the gateway to every mutating CLI operation this kind performs
 * (relay repoint, pairing, credential write, service install/start). It has **no default**, so a
 * construction that forgets it is a compile error rather than a silent run against the developer's
 * real machine. The two read-only deps keep their defaults.
 */
type RequiredSetupRepairDepName = 'createFlowExecutor' | 'readServerProfileScope';

export type SetupRepairThisComputerInteractiveDepsInput =
  Pick<SetupRepairThisComputerInteractiveDeps, RequiredSetupRepairDepName>
  & Partial<Omit<SetupRepairThisComputerInteractiveDeps, RequiredSetupRepairDepName>>;

/** The one production composition of the required deps; `hsetup` passes it explicitly. */
export function createProductionSetupRepairThisComputerInteractiveDeps(): Pick<
  SetupRepairThisComputerInteractiveDeps,
  RequiredSetupRepairDepName
> {
  return {
    createFlowExecutor: createLocalSetupFlowExecutor,
    readServerProfileScope: readLocalServerProfileScopeForRelay,
  };
}

export function createSetupRepairThisComputerInteractiveTaskKind(
  overrides: SetupRepairThisComputerInteractiveDepsInput,
): InteractiveSystemTaskKind<Readonly<{ machineId: string }>> {
  const deps: SetupRepairThisComputerInteractiveDeps = {
    readActiveRelayProfile: readLocalActiveRelayProfile,
    readCliAcquisition: readLocalSetupCliAcquisition,
    readBackgroundServiceSetupGuidance: async (params) => await readBackgroundServiceSetupGuidance({ ...params, mode: 'user' }),
    ...overrides,
  };

  return {
    async run(ctx) {
      const parsed = parseSetupRepairThisComputerParams(ctx.params);
      const releaseRing = parsed.channel ? normalizeBootstrapChannel(parsed.channel).releaseChannel : undefined;
      const relayProfile: LocalSetupRelayProfile = parsed.activeRelayUrl
        ? {
          serverUrl: parsed.activeRelayUrl,
          webappUrl: parsed.activeWebappUrl ?? parsed.activeRelayUrl,
          localServerUrl: parsed.activeLocalRelayUrl ?? null,
          ...(parsed.activeServerIdentityId ? { serverIdentityId: parsed.activeServerIdentityId } : {}),
        }
        : await deps.readActiveRelayProfile({ releaseRing });

      ctx.emit({
        type: 'step',
        stepId: 'setup.repairThisComputer.prepare',
        message: 'Repairing this computer',
        data: {
          relayUrl: relayProfile.serverUrl,
          webappUrl: relayProfile.webappUrl,
          ...(relayProfile.localServerUrl ? { activeLocalRelayUrl: relayProfile.localServerUrl } : {}),
          ...(parsed.surface ? { surface: parsed.surface } : {}),
        },
      });

      // The same service policy as setup (R10 D3, R3-6): an explicit Home is repaired on its own
      // pinned service, the disposition owner decides install/start/restart, and repair never
      // decides about other services — a conflict needing consent is left to guided setup.
      const profileScope = parsed.activeRelayUrl
        ? await deps.readServerProfileScope({ releaseRing, relayProfile })
        : null;
      const serviceTarget: BackgroundServiceSetupServiceTarget | undefined = profileScope
        ? profileScope.targetMode === 'pinned'
          ? { targetMode: 'pinned', serverId: profileScope.serverId }
          : { targetMode: 'default-following', followedServerId: profileScope.activeServerId }
        : undefined;
      const guidance = await deps.readBackgroundServiceSetupGuidance({
        targetReleaseChannel: releaseRing ?? 'stable',
        targetServerUrl: relayProfile.serverUrl,
        ...(serviceTarget ? { serviceTarget, offerDefaultReleaseChannelSwitch: false } : {}),
      });
      if (guidance.shouldPromptForServiceReplacement) {
        throw new SystemTaskExecutionError(
          'background_service_consent_required',
          'Other background services conflict with this one. Run setup for this computer to decide what to keep.',
        );
      }

      const flowResult = await runEnrollMachineFlow({
        relayProfile,
        ...(parsed.activeAccountId ? { expectedAccountId: parsed.activeAccountId } : {}),
        executor: deps.createFlowExecutor({
          signal: ctx.signal,
          releaseRing,
          ...(parsed.activeRelayUrl ? { scopeToConfiguredServer: true, knownServerScope: profileScope } : {}),
        }),
        serviceActions: ({ paired }) => resolveBackgroundServiceSetupReconciliationDisposition({
          guidance,
          targetChanged: paired,
          tookOverManualRelayRuntime: false,
          replacedExistingServices: false,
        }),
        stepIds: {
          configureRelay: 'setup.repairThisComputer.configureRelay',
          authRequest: 'setup.repairThisComputer.authRequest',
          authWait: 'setup.repairThisComputer.authenticate',
          installService: 'setup.repairThisComputer.installService',
          startService: 'setup.repairThisComputer.startService',
          restartService: 'setup.repairThisComputer.restartService',
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
        approvePairingRequest: async (inner) => {
          const decision = await requestTokenOnlyPairingApproval({
            ctx,
            stepId: 'setup.repairThisComputer.authRequest',
            message: 'Approve pairing request',
            publicKey: inner.publicKey,
            requestPayload: inner.requestPayload,
            target: relayProfile,
            cli: deps.readCliAcquisition({ ...(releaseRing ? { releaseRing } : {}) }),
          });
          if (decision === null) {
            throw new SystemTaskExecutionError(
              'pairing_approval_unavailable',
              'The Happier CLI did not provide token-only pairing material, so this computer cannot be approved automatically.',
            );
          }
          if (!decision.approved) {
            // The approval owner's own reason, so a relay mismatch or an unreadable credential is
            // not reported as a human decline.
            throw new SystemTaskExecutionError(
              'approval_declined',
              decision.reason
                ? `Pairing request was not approved (${decision.reason}).`
                : 'Pairing request was not approved.',
            );
          }
        },
        daemonReadinessErrorMessage: 'Background service did not reach a ready state for the selected Relay.',
      });

      const daemonMachineId = flowResult.daemonStatus?.machineId?.trim() || null;
      if (!daemonMachineId) {
        throw new SystemTaskExecutionError(
          'daemon_service_not_ready',
          'Background service did not reach a ready state for the selected Relay.',
        );
      }

      ctx.emit({ type: 'progress', stepId: 'setup.repairThisComputer.finish', message: 'Repair complete' });
      return { machineId: daemonMachineId };
    },
  };
}
