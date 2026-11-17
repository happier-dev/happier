import { access, readFile, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, join } from 'node:path';
import { quoteRemotePathWithHomeExpansion } from '../../ssh/shellQuote.js';
import { readExecutablePlatform } from '../../process/executablePlatform.js';

import { normalizePublicReleaseRingId, type PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';

import type {
  FirstPartyComponentId,
  PreparedFirstPartyComponentPayload,
} from '../../firstPartyRuntime/index.js';
import {
  getFirstPartyComponentCatalogEntry,
  assertValidFirstPartyVersionId,
  prepareFirstPartyComponentPayloadFromGitHubRelease,
  readAcquisitionFailureCause,
} from '../../firstPartyRuntime/index.js';
import { SystemTaskExecutionError } from '../runSystemTask.js';
import type { GuestCliIdentityV1 } from '@happier-dev/protocol/features';
import { selectManagedGuestCliPayload, installManagedGuestCliViaRemoteDownload } from '../ssh/managedGuestCliSupplier.js';

import { createScpReadyPayloadArchive } from './createScpReadyPayloadArchive.js';
import type { SystemTaskSshConnectionConfig } from './relayRuntimeKinds.js';
import {
  buildRemoteFirstPartyPromotionCommand,
  normalizeRemoteFirstPartyHomeDir,
  normalizeRemoteReleaseArch,
  normalizeRemoteReleaseOs,
  pruneRemoteFirstPartyVersions,
  resolveRemoteFirstPartyInstallLayout,
  resolveRemoteInstalledFirstPartyBinaryPath,
  sanitizeRemoteFirstPartyPathSegment,
} from '../ssh/remoteFirstPartyInstallPath.js';
import {
  executeRemoteSelfDownloadFirstPartyInstallPlan,
  resolveRemoteSelfDownloadFirstPartyInstallPlan,
  type RemoteSelfDownloadFirstPartyInstallPlan,
} from '../ssh/remoteSelfDownloadFirstPartyInstallCommand.js';
import { normalizeScpRemotePath } from '../ssh/scpRemotePath.js';
import { buildRemoteFirstPartyStagingCleanupCommand } from '../ssh/remoteFirstPartyStagingCleanup.js';
import { redactBugReportSensitiveText, trimBugReportTextToMaxBytes } from '@happier-dev/protocol/bugs/reports/redaction';
import { DEFAULT_COMMAND_CAPTURE_MAX_BYTES } from '../../process/commandCaptureBudget.js';
import { resolveManagedGuestCliSource, type ManagedGuestCliBuildTarget, type ManagedGuestCliLocalBuildPayload, type ManagedGuestCliLocalBuildMetadata } from '../ssh/managedGuestCliSupplier.js';

export {
  normalizeRemoteReleaseArch,
  normalizeRemoteReleaseOs,
  resolveRemoteInstalledFirstPartyBinaryPath,
} from '../ssh/remoteFirstPartyInstallPath.js';

export interface RemoteFirstPartyCommandResult {
  status: number;
  stdout: string;
  stderr: string;
}

export interface RemoteFirstPartyInstallDeps {
  resolveRemoteReleaseTarget: (params: Readonly<{
    ssh: SystemTaskSshConnectionConfig;
    knownHostsMode?: 'app' | 'system';
    signal?: AbortSignal;
  }>) => Promise<Readonly<{ os: 'linux' | 'darwin'; arch: 'x64' | 'arm64' }>>;
  runRemoteText: (params: Readonly<{
    ssh: SystemTaskSshConnectionConfig;
    remoteCommand: string;
    knownHostsMode?: 'app' | 'system';
    signal?: AbortSignal;
  }>) => Promise<RemoteFirstPartyCommandResult>;
  copyLocalDirectoryToRemote: (params: Readonly<{
    ssh: SystemTaskSshConnectionConfig;
    localPath: string;
    remotePath: string;
    knownHostsMode?: 'app' | 'system';
    signal?: AbortSignal;
  }>) => Promise<void>;
  preparePayload?: (params: Readonly<{
    componentId: FirstPartyComponentId;
    channel: 'stable' | 'preview' | 'publicdev';
    os: 'linux' | 'darwin';
    arch: 'x64' | 'arm64';
    versionId?: string;
    userAgent?: string;
  }>) => Promise<PreparedFirstPartyComponentPayload>;
  resolveSelfDownloadInstallPlan?: (params: Readonly<{
    componentId: FirstPartyComponentId;
    channel: PublicReleaseRingId;
    os: 'linux' | 'darwin';
    arch: 'x64' | 'arm64';
    remoteHomeDir?: string;
    versionId?: string;
    runRemoteText: NonNullable<Parameters<typeof resolveRemoteSelfDownloadFirstPartyInstallPlan>[0]['runRemoteText']>;
  }>) => Promise<RemoteSelfDownloadFirstPartyInstallPlan>;
  now?: () => number;
}

function normalizeBootstrapReleaseChannel(raw: unknown): PublicReleaseRingId {
  return normalizePublicReleaseRingId(raw) || 'stable';
}

function assertRemotePayloadCommandSucceeded(result: RemoteFirstPartyCommandResult, phase: 'staging' | 'promotion'): void {
  if (result.status === 0) return;
  if (/No space left|\bENOSPC\b|\berrno\s*28\b/iu.test(result.stderr)) {
    throw new SystemTaskExecutionError('remote_storage_full', 'The remote machine does not have enough free disk space to install Happier.');
  }
  throw new SystemTaskExecutionError('remote_command_failed',
    `Remote payload ${phase} failed (exit ${result.status}; stdout present ${result.stdout.length > 0}; stderr present ${result.stderr.length > 0}).`
      + (result.stderr ? `\n${trimBugReportTextToMaxBytes(redactBugReportSensitiveText(result.stderr), DEFAULT_COMMAND_CAPTURE_MAX_BYTES)}` : ''));
}

/** Flat payloads remain supported; collections select the guest, never the controller. */
async function resolveLocalCliPayloadDirectory(root: string, target: Readonly<{ os: 'linux' | 'darwin'; arch: 'x64' | 'arm64' }>): Promise<string> {
  try {
    const targetRoot = join(root, `${target.os}-${target.arch}`);
    if ((await stat(targetRoot)).isDirectory()) return targetRoot;
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') {
      throw new SystemTaskExecutionError('invalid_payload', 'The local CLI payload could not be read.');
    }
  }
  return root;
}

async function readLocalCliPayloadVersion(payloadRoot: string): Promise<string | undefined> {
  let text: string;
  try {
    text = await readFile(join(payloadRoot, 'package.json'), 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw new SystemTaskExecutionError('invalid_payload', 'The local CLI payload version could not be read.', { cause: error });
  }
  try {
    const metadata: unknown = JSON.parse(text);
    return metadata && typeof metadata === 'object' && 'version' in metadata && typeof metadata.version === 'string'
      ? metadata.version : undefined;
  } catch {
    return undefined;
  }
}

async function resolveLocalCliPayloadRoot(root: string, target: Readonly<{ os: 'linux' | 'darwin'; arch: 'x64' | 'arm64' }>): Promise<string> {
  const targetId = `${target.os}-${target.arch}`;
  const payloadRoot = await resolveLocalCliPayloadDirectory(root, target);
  const binaryPath = join(payloadRoot, getFirstPartyComponentCatalogEntry('happier-cli').binaryRelativePath);
  let executable: Awaited<ReturnType<typeof readExecutablePlatform>>;
  try {
    if (!(await stat(binaryPath)).isFile()) throw new Error('Not a file');
    await access(binaryPath, constants.R_OK);
    executable = await readExecutablePlatform(binaryPath);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      throw new SystemTaskExecutionError('guest_payload_missing', `The local CLI payload has no executable for ${targetId}.`);
    }
    throw new SystemTaskExecutionError('invalid_payload', 'The local CLI payload must contain a readable CLI executable.');
  }
  // An explicit operator script is interpreted on the guest. Native payloads
  // must match its ABI even when the guest could emulate a foreign executable.
  if (executable === 'script') return payloadRoot;
  if (executable?.os !== target.os || executable.arch !== target.arch) {
    throw new SystemTaskExecutionError('guest_architecture_unsupported', `The local CLI executable does not support ${targetId}. Prepare a matching guest payload and retry setup.`);
  }
  return payloadRoot;
}

/** The existing controller-local installer owns whether a payload collection is configured. */
export function readManagedGuestCliLocalPayloadRoot(): string {
  return String(process.env.HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_ROOT ?? '').trim();
}

async function readManagedGuestCliLocalBuildPayloadSource(target: ManagedGuestCliBuildTarget) {
  const root = readManagedGuestCliLocalPayloadRoot();
  let metadata: unknown;
  try { metadata = JSON.parse(process.env.HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_METADATA ?? ''); }
  catch { throw new SystemTaskExecutionError('guest_cli_identity_unavailable', 'The source runtime has no finalized guest CLI payload identity.'); }
  if (!root || !metadata || typeof metadata !== 'object' || !('root' in metadata) || metadata.root !== root
    || !('identity' in metadata) || typeof metadata.identity !== 'string' || !/^[a-f0-9]{64}$/u.test(metadata.identity)) {
    throw new SystemTaskExecutionError('guest_cli_identity_unavailable', 'The source runtime guest CLI payload and identity do not match.');
  }
  const targetId = `${target.os}-${target.arch}`;
  let identity = metadata.identity;
  if ('targetIdentities' in metadata) {
    const identities = metadata.targetIdentities;
    if (!identities || typeof identities !== 'object' || !(targetId in identities)) {
      throw new SystemTaskExecutionError('guest_payload_missing', 'The source runtime has no guest CLI payload for this image target.');
    }
    const selected = Reflect.get(identities, targetId);
    if (typeof selected !== 'string' || !/^[a-f0-9]{64}$/u.test(selected)) {
      throw new SystemTaskExecutionError('guest_cli_identity_unavailable', 'The source runtime image target has no finalized CLI payload identity.');
    }
    identity = selected;
  }
  const payloadRoot = await resolveLocalCliPayloadRoot(root, target);
  const versionId = await readLocalCliPayloadVersion(payloadRoot);
  if (!versionId) throw new SystemTaskExecutionError('guest_cli_version_unavailable', 'The source runtime CLI payload version is unavailable.');
  return { identity, versionId, target, payloadRoot };
}

/** Finalized target metadata only; no payload tree traversal, archive or encoded bytes. */
export async function readManagedGuestCliLocalBuildPayloadMetadata(target: ManagedGuestCliBuildTarget): Promise<ManagedGuestCliLocalBuildMetadata> {
  const { identity, versionId } = await readManagedGuestCliLocalBuildPayloadSource(target);
  return { identity, versionId, target };
}

/** Filesystem adapter for the portable image supplier; the source producer owns identity. */
export async function prepareManagedGuestCliLocalBuildPayload(target: ManagedGuestCliBuildTarget): Promise<ManagedGuestCliLocalBuildPayload> {
  const { identity, versionId, payloadRoot } = await readManagedGuestCliLocalBuildPayloadSource(target);
  const archive = await createScpReadyPayloadArchive(payloadRoot);
  try {
    return { identity, versionId, target, archive: {
      contentsBase64: (await readFile(join(archive.archiveStageRoot, archive.archiveFileName))).toString('base64'),
      rootDirectory: archive.extractedPayloadDirName,
    } };
  } finally { await archive.cleanup(); }
}

export type RemoteFirstPartyPayloadInstallDeps = Readonly<{
  resolveRemoteReleaseTarget: (params: Omit<Parameters<RemoteFirstPartyInstallDeps['resolveRemoteReleaseTarget']>[0], 'ssh' | 'knownHostsMode'>) => ReturnType<RemoteFirstPartyInstallDeps['resolveRemoteReleaseTarget']>;
  runRemoteText: (params: Omit<Parameters<RemoteFirstPartyInstallDeps['runRemoteText']>[0], 'ssh' | 'knownHostsMode'>) => ReturnType<RemoteFirstPartyInstallDeps['runRemoteText']>;
  copyLocalDirectoryToRemote: (params: Omit<Parameters<RemoteFirstPartyInstallDeps['copyLocalDirectoryToRemote']>[0], 'ssh' | 'knownHostsMode'>) => Promise<void>;
  preparePayload?: RemoteFirstPartyInstallDeps['preparePayload'];
  resolveSelfDownloadInstallPlan?: RemoteFirstPartyInstallDeps['resolveSelfDownloadInstallPlan'];
  now?: () => number;
}>;

export async function installRemoteFirstPartyComponent(params: Readonly<{
  componentId: FirstPartyComponentId;
  channel?: string;
  ssh: SystemTaskSshConnectionConfig;
  knownHostsMode?: 'app' | 'system';
  installerBinaryPath?: string;
  remoteHomeDir?: string;
  strategy?: 'scp-upload' | 'remote-self-download';
  requireHomePayload?: boolean;
  guestCli?: GuestCliIdentityV1;
  homeUrl?: string;
  signal?: AbortSignal;
  onPhase?(phase: 'prepare' | 'archive' | 'transfer' | 'promote'): void;
}>, deps: RemoteFirstPartyInstallDeps): Promise<Readonly<{ binaryPath: string; versionId: string; source: string | null }>> {

  return await installRemoteFirstPartyComponentPayload(params, {
    ...deps,
    resolveRemoteReleaseTarget: async (request) => deps.resolveRemoteReleaseTarget({ ...request, ssh: params.ssh, knownHostsMode: params.knownHostsMode }),
    runRemoteText: async (request) => deps.runRemoteText({ ...request, ssh: params.ssh, knownHostsMode: params.knownHostsMode }),
    copyLocalDirectoryToRemote: async (request) => deps.copyLocalDirectoryToRemote({ ...request, ssh: params.ssh, knownHostsMode: params.knownHostsMode }),
  });
}

/** One binary payload installer; transports own only command and file IO. */
export async function installRemoteFirstPartyComponentPayload(
  params: Omit<Readonly<{
  componentId: FirstPartyComponentId;
  channel?: string;
  ssh: SystemTaskSshConnectionConfig;
  knownHostsMode?: 'app' | 'system';
  installerBinaryPath?: string;
  remoteHomeDir?: string;
  strategy?: 'scp-upload' | 'remote-self-download';
  requireHomePayload?: boolean;
  guestCli?: GuestCliIdentityV1;
  homeUrl?: string;
  signal?: AbortSignal;
  onPhase?(phase: 'prepare' | 'archive' | 'transfer' | 'promote'): void;
}>, 'ssh' | 'knownHostsMode'>,
  deps: RemoteFirstPartyPayloadInstallDeps,
): Promise<Readonly<{ binaryPath: string; versionId: string; source: string | null }>> {
  const resolvedDeps = {
    preparePayload: async (payloadParams: Parameters<NonNullable<RemoteFirstPartyInstallDeps['preparePayload']>>[0]) => await prepareFirstPartyComponentPayloadFromGitHubRelease(payloadParams),
    resolveSelfDownloadInstallPlan: async (planParams: Parameters<NonNullable<RemoteFirstPartyInstallDeps['resolveSelfDownloadInstallPlan']>>[0]) => await resolveRemoteSelfDownloadFirstPartyInstallPlan(planParams),
    now: () => Date.now(),
    ...deps,
  } satisfies Required<RemoteFirstPartyPayloadInstallDeps>;
  const channel = normalizeBootstrapReleaseChannel(params.channel);
  let localCliPayloadRoot = params.componentId === 'happier-cli'
    ? readManagedGuestCliLocalPayloadRoot()
    : '';
  if (params.requireHomePayload && !params.homeUrl) {
    throw new SystemTaskExecutionError('guest_cli_identity_unavailable', 'Managed installation requires its selected Home URL.');
  }
  const remoteHomeDir = normalizeRemoteFirstPartyHomeDir(params.remoteHomeDir);
  const pruneRemoteVersions = async (): Promise<void> => {
    const layout = resolveRemoteFirstPartyInstallLayout({ componentId: params.componentId, channel, versionId: 'current', remoteHomeDir });
    await pruneRemoteFirstPartyVersions({
      layout,
      runRemoteText: (remoteCommand) => resolvedDeps.runRemoteText({ remoteCommand, ...(params.signal ? { signal: params.signal } : {}) }),
    });
  };
  params.signal?.throwIfAborted();
  params.onPhase?.('prepare');
  const target = await resolvedDeps.resolveRemoteReleaseTarget({
    ...(params.signal ? { signal: params.signal } : {}),
  });
  if (params.componentId === 'happier-cli' && params.homeUrl && params.guestCli?.source === 'home-payload' && params.guestCli.payloads) {
    const guestCliPayload = selectManagedGuestCliPayload({ guestCli: params.guestCli, homeUrl: params.homeUrl, target });
    params.onPhase?.('transfer');
    return await installManagedGuestCliViaRemoteDownload({ homeUrl: params.homeUrl, channel, ...target,
      guestCliPayload, remoteHomeDir: params.remoteHomeDir, signal: params.signal,
      runRemoteText: remoteCommand => resolvedDeps.runRemoteText({ remoteCommand, ...(params.signal ? { signal: params.signal } : {}) }),
    });
  }
  let versionId: string | undefined;
  if (params.componentId === 'happier-cli' && params.homeUrl) {
    const localPayloadDirectory = localCliPayloadRoot ? await resolveLocalCliPayloadDirectory(localCliPayloadRoot, target) : undefined;
    const localPayloadVersion = localPayloadDirectory ? await readLocalCliPayloadVersion(localPayloadDirectory) : undefined;
    const source = await resolveManagedGuestCliSource({
      homeUrl: params.homeUrl, channel,
      binaryPath: resolveRemoteInstalledFirstPartyBinaryPath({ componentId: params.componentId, channel, remoteHomeDir }),
      runRemoteText: remoteCommand => resolvedDeps.runRemoteText({ remoteCommand, ...(params.signal ? { signal: params.signal } : {}) }),
      signal: params.signal, localPayloadAvailable: !!localCliPayloadRoot, localPayloadVersion,
    });
    if (source.kind === 'public-release') {
      localCliPayloadRoot = '';
      versionId = source.versionId;
    }
  }
  const rethrowGuestPayloadFailure = (error: unknown): never => {
    if (readAcquisitionFailureCause(error) === 'release_archive_missing') {
      throw new SystemTaskExecutionError('guest_payload_missing', `The selected release has no ${params.componentId} payload for ${target.os}-${target.arch}.`);
    }
    throw error;
  };
  if (params.strategy === 'remote-self-download' && !localCliPayloadRoot) {
    const plan = await resolvedDeps.resolveSelfDownloadInstallPlan({
      componentId: params.componentId,
      channel,
      os: target.os,
      arch: target.arch,
      ...(versionId ? { versionId } : {}),
      runRemoteText: remoteCommand => resolvedDeps.runRemoteText({ remoteCommand, ...(params.signal ? { signal: params.signal } : {}) }),
      ...(params.remoteHomeDir ? { remoteHomeDir } : {}),
    }).catch(rethrowGuestPayloadFailure);
    params.onPhase?.('transfer');
    const installResult = await executeRemoteSelfDownloadFirstPartyInstallPlan({
      componentId: params.componentId, channel, remoteHomeDir, plan,
      runRemoteText: (remoteCommand) => resolvedDeps.runRemoteText({ remoteCommand, ...(params.signal ? { signal: params.signal } : {}) }),
    });
    if (installResult.status !== 0) {
      assertRemotePayloadCommandSucceeded(installResult, 'promotion');
    }
    return {
      binaryPath: plan.binaryPath,
      versionId: plan.versionId,
      source: plan.source,
    };
  }

  params.signal?.throwIfAborted();
  let prepared: PreparedFirstPartyComponentPayload;
  if (localCliPayloadRoot) {
    const payloadRoot = await resolveLocalCliPayloadRoot(localCliPayloadRoot, target);
    prepared = {
      componentId: params.componentId, channel, versionId: `local-${channel}-${resolvedDeps.now()}`,
      payloadRoot, source: `local-payload:${payloadRoot}`, cleanup: async () => undefined,
    };
  } else {
    prepared = await resolvedDeps.preparePayload({
      componentId: params.componentId,
      channel,
      os: target.os,
      arch: target.arch,
      ...(versionId ? { versionId } : {}),
      userAgent: 'happier-bootstrap',
    }).catch(rethrowGuestPayloadFailure);
  }

  try {
    if (params.componentId === 'happier-cli' || params.componentId === 'happier-daemon') {
      assertValidFirstPartyVersionId(prepared.versionId);
    }
    params.signal?.throwIfAborted();
    params.onPhase?.('archive');
    const scpReadyPayload = await createScpReadyPayloadArchive(prepared.payloadRoot).catch((error: unknown) => {
      params.signal?.throwIfAborted();
      if (localCliPayloadRoot) throw new SystemTaskExecutionError('invalid_payload', 'The local CLI payload could not be prepared for delivery.', { cause: error });
      throw error;
    });
    const stageParent = `${remoteHomeDir}/bootstrap-staging/${sanitizeRemoteFirstPartyPathSegment(params.componentId)}-${sanitizeRemoteFirstPartyPathSegment(prepared.versionId)}-${resolvedDeps.now()}`;
    const cleanupStagingCommand = buildRemoteFirstPartyStagingCleanupCommand(quoteRemotePathWithHomeExpansion(stageParent));
    try {
      await pruneRemoteVersions();
      const stageParentForScp = normalizeScpRemotePath(stageParent);
      const stageResult = await resolvedDeps.runRemoteText({
                remoteCommand: `mkdir -p ${quoteRemotePathWithHomeExpansion(stageParent)}`,
        ...(params.signal ? { signal: params.signal } : {}),
      });
      assertRemotePayloadCommandSucceeded(stageResult, 'staging');
      params.onPhase?.('transfer');
      await resolvedDeps.copyLocalDirectoryToRemote({
                localPath: scpReadyPayload.archiveStageRoot,
        remotePath: stageParentForScp,
        ...(params.signal ? { signal: params.signal } : {}),
      });

      const remoteArchiveRoot = `${stageParent}/${sanitizeRemoteFirstPartyPathSegment(basename(scpReadyPayload.archiveStageRoot))}`;
      const remoteArchivePath = `${remoteArchiveRoot}/${sanitizeRemoteFirstPartyPathSegment(scpReadyPayload.archiveFileName)}`;
      const remoteExtractRoot = `${stageParent}/payload-extracted`;
      const remotePayloadRoot = `${remoteExtractRoot}/${sanitizeRemoteFirstPartyPathSegment(scpReadyPayload.extractedPayloadDirName)}`;
      const layout = resolveRemoteFirstPartyInstallLayout({
        componentId: params.componentId,
        channel,
        versionId: prepared.versionId,
        remoteHomeDir,
      });

      params.onPhase?.('promote');
      const promotionResult = await resolvedDeps.runRemoteText({
        remoteCommand: [
          'set -eu',
          `cleanup() { ${cleanupStagingCommand}; }`,
          'trap cleanup EXIT',
          `rm -rf ${quoteRemotePathWithHomeExpansion(remoteExtractRoot)}`,
          `mkdir -p ${quoteRemotePathWithHomeExpansion(remoteExtractRoot)}`,
          `tar -xf ${quoteRemotePathWithHomeExpansion(remoteArchivePath)} -C ${quoteRemotePathWithHomeExpansion(remoteExtractRoot)}`,
          buildRemoteFirstPartyPromotionCommand({
            layout,
            payloadRootExpression: quoteRemotePathWithHomeExpansion(remotePayloadRoot),
            ...(params.componentId === 'happier-cli' || params.componentId === 'happier-daemon'
              ? { cliInstall: { componentId: params.componentId, channel, versionId: prepared.versionId } }
              : {}),
          }),
        ].join('; '),
        ...(params.signal ? { signal: params.signal } : {}),
      });
      assertRemotePayloadCommandSucceeded(promotionResult, 'promotion');
      await pruneRemoteVersions();
    } catch (error) {
      // Promotion's remote trap cannot clean a transfer that never reaches it.
      // Cleanup must survive cancellation and preserve the original failure.
      await resolvedDeps.runRemoteText({
        remoteCommand: cleanupStagingCommand,
      }).catch(() => undefined);
      throw error;
    } finally {
      await scpReadyPayload.cleanup();
    }

    return {
      binaryPath: resolveRemoteInstalledFirstPartyBinaryPath({ componentId: params.componentId, channel: params.channel, remoteHomeDir }),
      versionId: prepared.versionId,
      source: prepared.source,
    };
  } finally {
    await prepared.cleanup();
  }
}
