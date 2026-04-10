import { basename } from 'node:path';

import { normalizePublicReleaseRingId, type PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';

import type {
  FirstPartyComponentId,
  PreparedFirstPartyComponentPayload,
} from '../../firstPartyRuntime/index.js';
import {
  getFirstPartyComponentCatalogEntry,
  prepareFirstPartyComponentPayloadFromGitHubRelease,
  resolveFirstPartyComponentPublicReleaseVariant,
} from '../../firstPartyRuntime/index.js';

import { createScpReadyPayloadArchive } from './createScpReadyPayloadArchive.js';
import type { SystemTaskSshConnectionConfig } from './relayRuntimeKinds.js';
import { normalizeScpRemotePath } from '../ssh/scpRemotePath.js';

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
  now?: () => number;
}

function sanitizeRemotePathSegment(value: string): string {
  const sanitized = String(value ?? '').trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/-+/g, '-');
  return sanitized || 'payload';
}

function quoteShellSingleArg(value: string): string {
  const raw = String(value ?? '');
  if (raw === '') return "''";
  return `'${raw.replaceAll("'", `'\"'\"'`)}'`;
}

function normalizeBootstrapReleaseChannel(raw: unknown): PublicReleaseRingId {
  return normalizePublicReleaseRingId(raw) || 'stable';
}

function normalizeRemoteHomeDir(raw: unknown): string {
  const trimmed = String(raw ?? '').trim();
  const normalized = trimmed || '$HOME/.happier';
  if (normalized === '~') {
    return '$HOME';
  }
  if (normalized.startsWith('~/')) {
    return normalizeRemoteHomeDir(`$HOME${normalized.slice(1)}`);
  }
  if (normalized.startsWith('$HOME')) {
    const rest = normalized.slice('$HOME'.length);
    if (rest && !rest.startsWith('/')) {
      throw new Error(`Unsupported remote home dir: ${normalized}`);
    }
    const segments = rest
      ? rest.slice(1).split('/').filter(Boolean)
      : [];
    for (const segment of segments) {
      if (segment === '.' || segment === '..' || !/^[A-Za-z0-9._-]+$/u.test(segment)) {
        throw new Error(`Unsupported remote home dir: ${normalized}`);
      }
    }
    return normalized;
  }
  if (normalized.startsWith('/')) {
    const segments = normalized.slice(1).split('/').filter(Boolean);
    for (const segment of segments) {
      if (segment === '.' || segment === '..' || !/^[A-Za-z0-9._-]+$/u.test(segment)) {
        throw new Error(`Unsupported remote home dir: ${normalized}`);
      }
    }
    return normalized;
  }
  throw new Error(`Unsupported remote home dir: ${normalized}`);
}

export function normalizeRemoteReleaseOs(value: unknown): 'linux' | 'darwin' {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized.includes('darwin')) return 'darwin';
  if (normalized.includes('linux')) return 'linux';
  throw new Error(`Unsupported remote bootstrap platform: ${normalized || 'unknown'}`);
}

export function normalizeRemoteReleaseArch(value: unknown): 'x64' | 'arm64' {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === 'x86_64' || normalized === 'amd64' || normalized === 'x64') return 'x64';
  if (normalized === 'aarch64' || normalized === 'arm64') return 'arm64';
  throw new Error(`Unsupported remote bootstrap architecture: ${normalized || 'unknown'}`);
}

export function resolveRemoteInstalledFirstPartyBinaryPath(params: Readonly<{
  componentId: FirstPartyComponentId;
  channel?: string;
  remoteHomeDir?: string;
}>): string {
  const channel = normalizeBootstrapReleaseChannel(params.channel);
  const component = getFirstPartyComponentCatalogEntry(params.componentId);
  const variant = resolveFirstPartyComponentPublicReleaseVariant({
    componentId: params.componentId,
    channel,
  });
  const remoteHomeDir = normalizeRemoteHomeDir(params.remoteHomeDir);
  return `${remoteHomeDir}/${variant.installRootName}/current/${component.binaryRelativePath}`;
}

export async function installRemoteFirstPartyComponent(params: Readonly<{
  componentId: FirstPartyComponentId;
  channel?: string;
  ssh: SystemTaskSshConnectionConfig;
  knownHostsMode?: 'app' | 'system';
  installerBinaryPath?: string;
  remoteHomeDir?: string;
}>, deps: RemoteFirstPartyInstallDeps): Promise<Readonly<{ binaryPath: string; versionId: string; source: string | null }>> {
  const resolvedDeps = {
    preparePayload: async (payloadParams: Parameters<NonNullable<RemoteFirstPartyInstallDeps['preparePayload']>>[0]) => await prepareFirstPartyComponentPayloadFromGitHubRelease(payloadParams),
    now: () => Date.now(),
    ...deps,
  } satisfies Required<RemoteFirstPartyInstallDeps>;
  const channel = normalizeBootstrapReleaseChannel(params.channel);
  const remoteHomeDir = normalizeRemoteHomeDir(params.remoteHomeDir);
  const target = await resolvedDeps.resolveRemoteReleaseTarget({
    ssh: params.ssh,
    knownHostsMode: params.knownHostsMode,
  });
  const prepared = await resolvedDeps.preparePayload({
    componentId: params.componentId,
    channel,
    os: target.os,
    arch: target.arch,
    userAgent: 'happier-bootstrap',
  });

  try {
    const scpReadyPayload = await createScpReadyPayloadArchive(prepared.payloadRoot);
    const component = getFirstPartyComponentCatalogEntry(params.componentId);
    try {
      const variant = resolveFirstPartyComponentPublicReleaseVariant({
        componentId: params.componentId,
        channel,
      });
      const stageParent = `${remoteHomeDir}/bootstrap-staging/${sanitizeRemotePathSegment(params.componentId)}-${sanitizeRemotePathSegment(prepared.versionId)}-${resolvedDeps.now()}`;
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

      const remoteArchiveRoot = `${stageParent}/${sanitizeRemotePathSegment(basename(scpReadyPayload.archiveStageRoot))}`;
      const remoteArchivePath = `${remoteArchiveRoot}/${sanitizeRemotePathSegment(scpReadyPayload.archiveFileName)}`;
      const remoteExtractRoot = `${stageParent}/payload-extracted`;
      const remotePayloadRoot = `${remoteExtractRoot}/${sanitizeRemotePathSegment(scpReadyPayload.extractedPayloadDirName)}`;
      const installRoot = `${remoteHomeDir}/${variant.installRootName}`;
      const versionsDir = `${installRoot}/versions`;
      const versionDir = `${versionsDir}/${sanitizeRemotePathSegment(prepared.versionId)}`;
      const currentPath = `${installRoot}/current`;
      const previousPath = `${installRoot}/previous`;
      const binaryPath = `${currentPath}/${component.binaryRelativePath}`;

      await resolvedDeps.runRemoteText({
        ssh: params.ssh,
        knownHostsMode: params.knownHostsMode,
        remoteCommand: [
          'set -eu',
          `cleanup() { rm -rf ${stageParent}; }`,
          'trap cleanup EXIT',
          `mkdir -p ${versionsDir}`,
          `rm -rf ${versionDir}`,
          `rm -rf ${remoteExtractRoot}`,
          `mkdir -p ${remoteExtractRoot}`,
          `tar -xf ${remoteArchivePath} -C ${remoteExtractRoot}`,
          `cp -R ${remotePayloadRoot} ${versionDir}`,
          `if [ -L ${currentPath} ]; then prev="$(readlink ${currentPath} || true)"; if [ -n "$prev" ]; then ln -sfn "$prev" ${previousPath}; fi; fi`,
          `ln -sfn ${versionDir} ${currentPath}`,
          `chmod +x ${binaryPath}`,
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
