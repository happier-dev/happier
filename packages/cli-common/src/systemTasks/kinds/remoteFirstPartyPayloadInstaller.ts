import { access, open, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, join } from 'node:path';
import { quoteRemotePathWithHomeExpansion } from '../../ssh/shellQuote.js';

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
    userAgent?: string;
  }>) => Promise<PreparedFirstPartyComponentPayload>;
  resolveSelfDownloadInstallPlan?: (params: Readonly<{
    componentId: FirstPartyComponentId;
    channel: PublicReleaseRingId;
    os: 'linux' | 'darwin';
    arch: 'x64' | 'arm64';
    remoteHomeDir?: string;
    runRemoteText: Parameters<typeof resolveRemoteSelfDownloadFirstPartyInstallPlan>[0]['runRemoteText'];
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
async function resolveLocalCliPayloadRoot(root: string, target: Readonly<{ os: 'linux' | 'darwin'; arch: 'x64' | 'arm64' }>): Promise<string> {
  const targetId = `${target.os}-${target.arch}`;
  let payloadRoot = root;
  try {
    if ((await stat(join(root, targetId))).isDirectory()) payloadRoot = join(root, targetId);
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') {
      throw new SystemTaskExecutionError('invalid_payload', 'The local CLI payload could not be read.');
    }
  }
  const binaryPath = join(payloadRoot, getFirstPartyComponentCatalogEntry('happier-cli').binaryRelativePath);
  let header: Buffer;
  try {
    if (!(await stat(binaryPath)).isFile()) throw new Error('Not a file');
    await access(binaryPath, constants.R_OK);
    const file = await open(binaryPath, 'r');
    try {
      // ELF e_machine and Mach-O cputype are in the fixed executable header.
      // Read only that header, not a potentially large Bun executable.
      const bytes = Buffer.alloc(20);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      header = bytes.subarray(0, bytesRead);
    } finally { await file.close(); }
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      throw new SystemTaskExecutionError('guest_payload_missing', `The local CLI payload has no executable for ${targetId}.`);
    }
    throw new SystemTaskExecutionError('invalid_payload', 'The local CLI payload must contain a readable CLI executable.');
  }
  // An explicit operator script is interpreted on the guest. Native payloads
  // must match its ABI even when the guest could emulate a foreign executable.
  if (header.subarray(0, 2).toString() === '#!') return payloadRoot;
  const elf = header.length === 20 && header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
  const macho = header.length === 20 && header.readUInt32LE(0) === 0xfeedfacf;
  const matches = (elf && target.os === 'linux' && header[4] === 2 && header[5] === 1
    && header.readUInt16LE(18) === (target.arch === 'arm64' ? 183 : 62))
    || (macho && target.os === 'darwin' && header.readUInt32LE(4) === (target.arch === 'arm64' ? 0x0100000c : 0x01000007));
  if (!matches) {
    throw new SystemTaskExecutionError('guest_architecture_unsupported', `The local CLI executable does not support ${targetId}. Prepare a matching guest payload and retry setup.`);
  }
  return payloadRoot;
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
  const localCliPayloadRoot = params.componentId === 'happier-cli'
    ? String(process.env.HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_ROOT ?? '').trim()
    : '';
  if (params.requireHomePayload && !localCliPayloadRoot) {
    throw new SystemTaskExecutionError('guest_payload_missing', 'This Home has no guest CLI payload to install.');
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
