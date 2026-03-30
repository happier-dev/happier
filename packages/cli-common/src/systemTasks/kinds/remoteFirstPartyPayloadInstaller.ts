import { basename } from 'node:path';

import type {
  FirstPartyComponentId,
  PreparedFirstPartyComponentPayload,
} from '../../firstPartyRuntime/index.js';
import {
  getFirstPartyComponentCatalogEntry,
  prepareFirstPartyComponentPayloadFromGitHubRelease,
  resolveFirstPartyComponentPublicReleaseVariant,
} from '../../firstPartyRuntime/index.js';

import type { SystemTaskSshConnectionConfig } from './relayRuntimeKinds.js';

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

function normalizeBootstrapReleaseChannel(raw: unknown): 'stable' | 'preview' | 'publicdev' {
  const text = String(raw ?? '').trim().toLowerCase();
  if (text === 'preview') {
    return 'preview';
  }
  if (text === 'dev' || text === 'publicdev') {
    return 'publicdev';
  }
  return 'stable';
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
    const component = getFirstPartyComponentCatalogEntry(params.componentId);
    const stageParent = `${remoteHomeDir}/bootstrap-staging/${sanitizeRemotePathSegment(params.componentId)}-${sanitizeRemotePathSegment(prepared.versionId)}-${resolvedDeps.now()}`;
    await resolvedDeps.runRemoteText({
      ssh: params.ssh,
      knownHostsMode: params.knownHostsMode,
      remoteCommand: `mkdir -p ${stageParent}`,
    });
    await resolvedDeps.copyLocalDirectoryToRemote({
      ssh: params.ssh,
      knownHostsMode: params.knownHostsMode,
      localPath: prepared.payloadRoot,
      remotePath: stageParent,
    });

    const remotePayloadRoot = `${stageParent}/${sanitizeRemotePathSegment(basename(prepared.payloadRoot))}`;
    const installerBinaryPath = params.installerBinaryPath
      ? params.installerBinaryPath
      : params.componentId === 'happier-cli'
        ? `${remotePayloadRoot}/${component.binaryRelativePath}`
        : null;
    if (!installerBinaryPath) {
      throw new Error(`Remote installer binary is required to install ${params.componentId}.`);
    }

    const installPayloadCommand = [
      `env HAPPIER_HOME_DIR=${remoteHomeDir}`,
      `${installerBinaryPath} self __install-payload`,
      `--component '${params.componentId}'`,
      `--payload-root ${remotePayloadRoot}`,
      `--version '${prepared.versionId}'`,
      `--channel '${channel}'`,
    ].join(' ');

    await resolvedDeps.runRemoteText({
      ssh: params.ssh,
      knownHostsMode: params.knownHostsMode,
      remoteCommand: [
        'set -eu',
        `cleanup() { rm -rf ${stageParent}; }`,
        'trap cleanup EXIT',
        `mkdir -p ${remoteHomeDir}`,
        `chmod +x ${installerBinaryPath}`,
        `bash -lc ${quoteShellSingleArg(installPayloadCommand)}`,
      ].join('; '),
    });

    return {
      binaryPath: resolveRemoteInstalledFirstPartyBinaryPath({
        componentId: params.componentId,
        channel: params.channel,
        remoteHomeDir,
      }),
      versionId: prepared.versionId,
      source: prepared.source,
    };
  } finally {
    await prepared.cleanup();
  }
}
