import { basename } from 'node:path';

import {
  getFirstPartyComponentCatalogEntry,
  prepareFirstPartyComponentPayloadFromGitHubRelease,
  resolveFirstPartyComponentPublicReleaseVariant,
} from '@happier-dev/cli-common/firstPartyRuntime';
import { normalizePublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';

import { run, runCapture } from '../proc/proc.mjs';

function safeBashSingleQuote(value) {
  const raw = String(value ?? '');
  if (raw === '') return "''";
  return `'${raw.replaceAll("'", `'\"'\"'`)}'`;
}

function parseJsonLinesBestEffort(stdout) {
  const out = String(stdout ?? '');
  const lines = out
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of lines) {
    try {
      return JSON.parse(line);
    } catch {
      continue;
    }
  }
  return null;
}

function sanitizeRemotePathSegment(value) {
  const sanitized = String(value ?? '')
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-');
  return sanitized || 'payload';
}

function normalizeRemoteReleaseOs(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized.includes('darwin')) return 'darwin';
  if (normalized.includes('linux')) return 'linux';
  throw new Error(`Unsupported remote bootstrap platform: ${normalized || 'unknown'}`);
}

function normalizeRemoteReleaseArch(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === 'x86_64' || normalized === 'amd64' || normalized === 'x64') return 'x64';
  if (normalized === 'aarch64' || normalized === 'arm64') return 'arm64';
  throw new Error(`Unsupported remote bootstrap architecture: ${normalized || 'unknown'}`);
}

async function runRemoteText({ target, command }) {
  await run('ssh', [target, 'bash', '-lc', safeBashSingleQuote(command)], { env: process.env });
}

async function runRemoteJson({ target, command }) {
  const out = await runCapture('ssh', [target, 'bash', '-lc', safeBashSingleQuote(command)], { env: process.env });
  const parsed = parseJsonLinesBestEffort(out);
  if (!parsed) {
    throw new Error('Remote command did not return valid JSON');
  }
  return parsed;
}

function normalizeChannel(channel) {
  return normalizePublicReleaseRingId(channel) || 'stable';
}

export function resolveRemoteInstalledFirstPartyBinaryPath({ componentId, channel, remoteHomeDir = '$HOME/.happier' }) {
  const normalizedChannel = normalizeChannel(channel);
  const component = getFirstPartyComponentCatalogEntry(componentId);
  const variant = resolveFirstPartyComponentPublicReleaseVariant({
    componentId,
    channel: normalizedChannel,
  });
  return `${remoteHomeDir}/${variant.installRootName}/current/${component.binaryRelativePath}`;
}

async function resolveRemoteReleaseTarget({ target, runRemoteJsonImpl = runRemoteJson }) {
  const preflight = await runRemoteJsonImpl({
    target,
    command: [
      `printf '{"platform":"%s","arch":"%s"}\\n'`,
      `"$(uname -s | tr '[:upper:]' '[:lower:]')"`,
      `"$(uname -m | tr '[:upper:]' '[:lower:]')"`,
    ].join(' '),
  });

  return {
    os: normalizeRemoteReleaseOs(preflight?.platform),
    arch: normalizeRemoteReleaseArch(preflight?.arch),
  };
}

const DEFAULT_REMOTE_INSTALL_DEPS = {
  preparePayload: async (params) => await prepareFirstPartyComponentPayloadFromGitHubRelease(params),
  runRemoteText: async (params) => await runRemoteText(params),
  runRemoteJson: async (params) => await runRemoteJson(params),
  runScp: async ({ localPath, remoteTarget }) => {
    await run('scp', ['-r', localPath, remoteTarget], { env: process.env });
  },
  now: () => Date.now(),
};

export async function installRemoteFirstPartyComponent(
  {
    componentId,
    channel,
    target,
    remoteHomeDir = '$HOME/.happier',
    userAgent = 'hstack-remote-bootstrap',
  },
  deps = {},
) {
  const normalizedChannel = normalizeChannel(channel);
  const resolvedDeps = {
    ...DEFAULT_REMOTE_INSTALL_DEPS,
    ...deps,
  };
  const releaseTarget = await resolveRemoteReleaseTarget({ target, runRemoteJsonImpl: resolvedDeps.runRemoteJson });
  const prepared = await resolvedDeps.preparePayload({
    componentId,
    channel: normalizedChannel,
    os: releaseTarget.os,
    arch: releaseTarget.arch,
    userAgent,
  });

  try {
    const component = getFirstPartyComponentCatalogEntry(componentId);
    const stageParent = `${remoteHomeDir}/bootstrap-staging/${sanitizeRemotePathSegment(componentId)}-${sanitizeRemotePathSegment(prepared.versionId)}-${resolvedDeps.now()}`;
    await resolvedDeps.runRemoteText({
      target,
      command: `mkdir -p ${stageParent}`,
    });
    await resolvedDeps.runScp({
      localPath: prepared.payloadRoot,
      remoteTarget: `${target}:${stageParent}`,
    });

    const remotePayloadRoot = `${stageParent}/${basename(prepared.payloadRoot)}`;
    const installerBinaryPath = `${remotePayloadRoot}/${component.binaryRelativePath}`;
    await resolvedDeps.runRemoteText({
      target,
      command: [
        'set -euo pipefail',
        `cleanup() { rm -rf ${stageParent}; }`,
        'trap cleanup EXIT',
        `mkdir -p ${remoteHomeDir}`,
        `env HAPPIER_HOME_DIR=${remoteHomeDir} ${installerBinaryPath} self __install-payload --component '${componentId}' --payload-root ${remotePayloadRoot} --version '${prepared.versionId}' --channel '${normalizedChannel}'`,
      ].join('; '),
    });

    return {
      binaryPath: resolveRemoteInstalledFirstPartyBinaryPath({
        componentId,
        channel: normalizedChannel,
        remoteHomeDir,
      }),
      versionId: prepared.versionId,
      source: prepared.source,
    };
  } finally {
    await prepared.cleanup();
  }
}
