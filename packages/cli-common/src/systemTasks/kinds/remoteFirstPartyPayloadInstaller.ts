import { basename } from 'node:path';
import { quoteRemotePathWithHomeExpansion } from '../../ssh/shellQuote.js';

import { normalizePublicReleaseRingId, type PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';

import type {
  FirstPartyComponentId,
  PreparedFirstPartyComponentPayload,
} from '../../firstPartyRuntime/index.js';
import {
  prepareFirstPartyComponentPayloadFromGitHubRelease,
} from '../../firstPartyRuntime/index.js';

import { createScpReadyPayloadArchive } from './createScpReadyPayloadArchive.js';
import type { SystemTaskSshConnectionConfig } from './relayRuntimeKinds.js';
import {
  buildRemoteFirstPartyPromotionCommand,
  normalizeRemoteFirstPartyHomeDir,
  normalizeRemoteReleaseArch,
  normalizeRemoteReleaseOs,
  resolveRemoteFirstPartyInstallLayout,
  resolveRemoteInstalledFirstPartyBinaryPath,
  sanitizeRemoteFirstPartyPathSegment,
} from '../ssh/remoteFirstPartyInstallPath.js';
import {
  resolveRemoteSelfDownloadFirstPartyInstallPlan,
  type RemoteSelfDownloadFirstPartyInstallPlan,
} from '../ssh/remoteSelfDownloadFirstPartyInstallCommand.js';
import { normalizeScpRemotePath } from '../ssh/scpRemotePath.js';

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
  }>) => Promise<RemoteSelfDownloadFirstPartyInstallPlan>;
  now?: () => number;
}

function normalizeBootstrapReleaseChannel(raw: unknown): PublicReleaseRingId {
  return normalizePublicReleaseRingId(raw) || 'stable';
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
  signal?: AbortSignal;
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
  signal?: AbortSignal;
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
  const remoteHomeDir = normalizeRemoteFirstPartyHomeDir(params.remoteHomeDir);
  params.signal?.throwIfAborted();
  const target = await resolvedDeps.resolveRemoteReleaseTarget({
    ...(params.signal ? { signal: params.signal } : {}),
  });
  if (params.strategy === 'remote-self-download') {
    const plan = await resolvedDeps.resolveSelfDownloadInstallPlan({
      componentId: params.componentId,
      channel,
      os: target.os,
      arch: target.arch,
      ...(params.remoteHomeDir ? { remoteHomeDir } : {}),
    });
    const installResult = await resolvedDeps.runRemoteText({
          remoteCommand: plan.command,
      ...(params.signal ? { signal: params.signal } : {}),
    });
    if (installResult.status !== 0) {
      throw new Error(installResult.stderr.trim() || 'Remote self-download install failed.');
    }
    return {
      binaryPath: plan.binaryPath,
      versionId: plan.versionId,
      source: plan.source,
    };
  }

  params.signal?.throwIfAborted();
  const prepared = await resolvedDeps.preparePayload({
    componentId: params.componentId,
    channel,
    os: target.os,
    arch: target.arch,
    userAgent: 'happier-bootstrap',
  });

  try {
    params.signal?.throwIfAborted();
    const scpReadyPayload = await createScpReadyPayloadArchive(prepared.payloadRoot);
    try {
      const stageParent = `${remoteHomeDir}/bootstrap-staging/${sanitizeRemoteFirstPartyPathSegment(params.componentId)}-${sanitizeRemoteFirstPartyPathSegment(prepared.versionId)}-${resolvedDeps.now()}`;
      const stageParentForScp = normalizeScpRemotePath(stageParent);
      const stageResult = await resolvedDeps.runRemoteText({
                remoteCommand: `mkdir -p ${quoteRemotePathWithHomeExpansion(stageParent)}`,
        ...(params.signal ? { signal: params.signal } : {}),
      });
      if (stageResult.status !== 0) throw new Error('Remote payload staging failed.');
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

      const promotionResult = await resolvedDeps.runRemoteText({
        remoteCommand: [
          'set -eu',
          `cleanup() { rm -rf ${quoteRemotePathWithHomeExpansion(stageParent)}; }`,
          'trap cleanup EXIT',
          `rm -rf ${quoteRemotePathWithHomeExpansion(remoteExtractRoot)}`,
          `mkdir -p ${quoteRemotePathWithHomeExpansion(remoteExtractRoot)}`,
          `tar -xf ${quoteRemotePathWithHomeExpansion(remoteArchivePath)} -C ${quoteRemotePathWithHomeExpansion(remoteExtractRoot)}`,
          buildRemoteFirstPartyPromotionCommand({
            layout,
            payloadRootExpression: quoteRemotePathWithHomeExpansion(remotePayloadRoot),
          }),
        ].join('; '),
        ...(params.signal ? { signal: params.signal } : {}),
      });
      if (promotionResult.status !== 0) throw new Error('Remote payload promotion failed.');
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
