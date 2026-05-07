import { basename } from 'node:path';

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
  }>) => Promise<Readonly<{ os: 'linux' | 'darwin'; arch: 'x64' | 'arm64' }>>;
  runRemoteText: (params: Readonly<{
    ssh: SystemTaskSshConnectionConfig;
    remoteCommand: string;
    knownHostsMode?: 'app' | 'system';
  }>) => Promise<RemoteFirstPartyCommandResult>;
  copyLocalDirectoryToRemote: (params: Readonly<{
    ssh: SystemTaskSshConnectionConfig;
    localPath: string;
    remotePath: string;
    knownHostsMode?: 'app' | 'system';
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

export async function installRemoteFirstPartyComponent(params: Readonly<{
  componentId: FirstPartyComponentId;
  channel?: string;
  ssh: SystemTaskSshConnectionConfig;
  knownHostsMode?: 'app' | 'system';
  installerBinaryPath?: string;
  remoteHomeDir?: string;
  strategy?: 'scp-upload' | 'remote-self-download';
}>, deps: RemoteFirstPartyInstallDeps): Promise<Readonly<{ binaryPath: string; versionId: string; source: string | null }>> {
  const resolvedDeps = {
    preparePayload: async (payloadParams: Parameters<NonNullable<RemoteFirstPartyInstallDeps['preparePayload']>>[0]) => await prepareFirstPartyComponentPayloadFromGitHubRelease(payloadParams),
    resolveSelfDownloadInstallPlan: async (planParams: Parameters<NonNullable<RemoteFirstPartyInstallDeps['resolveSelfDownloadInstallPlan']>>[0]) => await resolveRemoteSelfDownloadFirstPartyInstallPlan(planParams),
    now: () => Date.now(),
    ...deps,
  } satisfies Required<RemoteFirstPartyInstallDeps>;
  const channel = normalizeBootstrapReleaseChannel(params.channel);
  const remoteHomeDir = normalizeRemoteFirstPartyHomeDir(params.remoteHomeDir);
  const target = await resolvedDeps.resolveRemoteReleaseTarget({
    ssh: params.ssh,
    knownHostsMode: params.knownHostsMode,
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
      ssh: params.ssh,
      knownHostsMode: params.knownHostsMode,
      remoteCommand: plan.command,
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

  const prepared = await resolvedDeps.preparePayload({
    componentId: params.componentId,
    channel,
    os: target.os,
    arch: target.arch,
    userAgent: 'happier-bootstrap',
  });

  try {
    const scpReadyPayload = await createScpReadyPayloadArchive(prepared.payloadRoot);
    try {
      const stageParent = `${remoteHomeDir}/bootstrap-staging/${sanitizeRemoteFirstPartyPathSegment(params.componentId)}-${sanitizeRemoteFirstPartyPathSegment(prepared.versionId)}-${resolvedDeps.now()}`;
      const stageParentForScp = normalizeScpRemotePath(stageParent);
      await resolvedDeps.runRemoteText({
        ssh: params.ssh,
        knownHostsMode: params.knownHostsMode,
        remoteCommand: `mkdir -p ${stageParent}`,
      });
      await resolvedDeps.copyLocalDirectoryToRemote({
        ssh: params.ssh,
        knownHostsMode: params.knownHostsMode,
        localPath: scpReadyPayload.archiveStageRoot,
        remotePath: stageParentForScp,
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

      await resolvedDeps.runRemoteText({
        ssh: params.ssh,
        knownHostsMode: params.knownHostsMode,
        remoteCommand: [
          'set -eu',
          `cleanup() { rm -rf ${stageParent}; }`,
          'trap cleanup EXIT',
          `rm -rf ${remoteExtractRoot}`,
          `mkdir -p ${remoteExtractRoot}`,
          `tar -xf ${remoteArchivePath} -C ${remoteExtractRoot}`,
          buildRemoteFirstPartyPromotionCommand({
            layout,
            payloadRootExpression: remotePayloadRoot,
          }),
        ].join('; '),
      });
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
