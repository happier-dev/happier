import {
  createLocalHappierJsonExecutor,
  createEnrollMachineFlowExecutorFromHappierJsonExecutor,
  DEFAULT_HAPPIER_CLI_ENV_VAR_NAMES,
  readLocalServerProfileScope,
  resolveExplicitOrInstalledLocalFirstPartyCommand,
  scopeHappierJsonExecutor,
  SystemTaskExecutionError,
  type HappierServerScope,
  type LocalFirstPartyCommandProvenance,
  type LocalServerProfileScope,
  type EnrollMachineFlowExecutor,
} from '@happier-dev/cli-common/systemTasks';
import { readMachineDaemonOwnershipMetadataFromSocketAuth, type MachineDaemonOwnershipMetadata } from '@happier-dev/protocol';
import type { PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';

export type LocalSetupRelayProfile = Readonly<{
  serverUrl: string;
  webappUrl: string;
  localServerUrl: string | null;
  /** The explicit Home's server identity, when the app knows it (RV-11). */
  serverIdentityId?: string | null;
}>;

/**
 * The one local-machine flow executor behind `setup.thisComputer.v1` and
 * `setup.repairThisComputer.v1`: every setup/repair step runs the managed `happier` CLI for the
 * selected release ring through the canonical JSON executor and its canonical status readers.
 */
export function createLocalSetupFlowExecutor(params: Readonly<{
  signal?: AbortSignal;
  releaseRing?: PublicReleaseRingId;
  takeOverManualRelayRuntime?: boolean;
  scopeToConfiguredServer?: boolean;
  knownServerScope?: LocalServerProfileScope | null;
}>): EnrollMachineFlowExecutor {
  return createEnrollMachineFlowExecutorFromHappierJsonExecutor({
    executor: createLocalHappierJsonExecutor({ releaseRing: params.releaseRing, signal: params.signal }),
    options: {
      takeOverManualRelayRuntime: params.takeOverManualRelayRuntime,
      scopeToConfiguredServer: params.scopeToConfiguredServer,
      knownServerScope: params.knownServerScope,
    },
  });
}

/** Reads the CLI's currently selected relay profile; used only when a task supplies no explicit target. */
export async function readLocalActiveRelayProfile(params: Readonly<{
  releaseRing?: PublicReleaseRingId;
}>): Promise<LocalSetupRelayProfile> {
  const executor = createLocalHappierJsonExecutor({ releaseRing: params.releaseRing });
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
}

/**
 * Which `happier` CLI this local run will drive, and how it was acquired.
 *
 * Only a CLI the managed release path actually installed here may be approved for pairing
 * unattended (R13); an env or repo-local override is a development convenience that has been
 * through no release verification, and an unresolvable command is treated the same way. The
 * resolved command travels with the provenance because the person asked to vouch for a
 * non-managed CLI decides about a specific program on disk, not about the word "override" — one
 * read of one canonical resolver answers both, so the path shown can never describe a different
 * binary than the one that was classified.
 */
export type LocalSetupCliAcquisition = Readonly<{
  provenance: LocalFirstPartyCommandProvenance;
  /** The resolved command, or `null` when no CLI could be resolved at all. */
  command: string | null;
}>;

export function readLocalSetupCliAcquisition(params: Readonly<{
  releaseRing?: PublicReleaseRingId;
  processEnv?: NodeJS.ProcessEnv;
}>): LocalSetupCliAcquisition {
  const resolved = resolveExplicitOrInstalledLocalFirstPartyCommand({
    componentId: 'happier-cli',
    processEnv: params.processEnv ?? process.env,
    envVarNames: DEFAULT_HAPPIER_CLI_ENV_VAR_NAMES,
    ...(params.releaseRing ? { releaseRing: params.releaseRing } : {}),
  });
  return {
    provenance: resolved?.provenance ?? 'override',
    command: resolved?.command ?? null,
  };
}

/**
 * The manual (non-service) daemon owner of the target, read through `service status`. With a
 * `scope` it is the explicit Home's own daemon: daemons are per-server, so a manual daemon of
 * another server never conflicts with this Home's service (R3-5).
 */
export async function readLocalCurrentRelayOwner(params: Readonly<{
  releaseRing?: PublicReleaseRingId;
  scope?: HappierServerScope;
}>): Promise<Pick<MachineDaemonOwnershipMetadata, 'serviceManaged' | 'publicReleaseChannel' | 'cliVersion'> | null> {
  const baseExecutor = createLocalHappierJsonExecutor({ releaseRing: params.releaseRing });
  const executor = params.scope ? scopeHappierJsonExecutor(baseExecutor, params.scope) : baseExecutor;
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
}

/** Read-only `server list --json` resolution of an explicit Home's saved profile (R10 D3). */
export async function readLocalServerProfileScopeForRelay(params: Readonly<{
  releaseRing?: PublicReleaseRingId;
  relayProfile: LocalSetupRelayProfile;
}>): Promise<LocalServerProfileScope> {
  return await readLocalServerProfileScope(
    createLocalHappierJsonExecutor({ releaseRing: params.releaseRing }),
    {
      serverUrl: params.relayProfile.serverUrl,
      localServerUrl: params.relayProfile.localServerUrl,
      serverIdentityId: params.relayProfile.serverIdentityId ?? null,
    },
    { releaseRing: params.releaseRing },
  );
}
