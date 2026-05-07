import { basename, dirname, join } from 'node:path';
import { readFile, realpath } from 'node:fs/promises';

import { configuration } from '@/configuration';
import { resolveInvokerName } from '@/cli/runtime/resolveInvokerName';

import {
  listInstalledVersionIdsNewestFirst,
  resolveFirstPartyVersionInstallPath,
  resolveInstalledFirstPartyComponentPaths,
} from '@happier-dev/cli-common/firstPartyRuntime';
import { getReleaseRingCatalogEntry, type PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';
import type { DoctorSnapshot } from '@happier-dev/protocol';

type HappierInstallations = NonNullable<NonNullable<DoctorSnapshot['installations']>['happier']>;
type HappierInstallation = HappierInstallations['installations'][number];
type HappierActiveInvocation = NonNullable<HappierInstallations['activeInvocation']>;
type SnapshotRing = NonNullable<HappierInstallation['ring']>;

const CLI_CHANNELS: readonly PublicReleaseRingId[] = ['stable', 'preview', 'publicdev'];

function toSnapshotRing(channel: PublicReleaseRingId): SnapshotRing {
  return getReleaseRingCatalogEntry(channel).publicLabel;
}

async function readPackageVersion(packageRoot: string): Promise<string | null> {
  const root = String(packageRoot ?? '').trim();
  if (!root) {
    return null;
  }

  try {
    const parsed = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { version?: unknown };
    const version = typeof parsed.version === 'string' ? parsed.version.trim() : '';
    return version || null;
  } catch {
    return null;
  }
}

async function resolveRealPath(path: string): Promise<string | null> {
  const value = String(path ?? '').trim();
  if (!value) {
    return null;
  }

  try {
    return await realpath(value);
  } catch {
    return null;
  }
}

function resolveBinaryPathForVersion(params: Readonly<{
  channel: PublicReleaseRingId;
  versionId: string;
}>): string {
  const versionRoot = resolveFirstPartyVersionInstallPath({
    componentId: 'happier-cli',
    channel: params.channel,
    versionId: params.versionId,
    processEnv: process.env,
  });
  return join(versionRoot, process.platform === 'win32' ? 'happier.exe' : 'happier');
}

function isPathDirectoryOnPath(path: string): boolean {
  const normalized = String(path ?? '').trim();
  if (!normalized) {
    return false;
  }

  const pathEntries = String(process.env.PATH ?? '')
    .split(process.platform === 'win32' ? ';' : ':')
    .map((entry) => entry.trim())
    .filter(Boolean);
  return pathEntries.includes(normalized);
}

async function readManagedInstallation(channel: PublicReleaseRingId): Promise<HappierInstallation | null> {
  const paths = resolveInstalledFirstPartyComponentPaths({
    componentId: 'happier-cli',
    channel,
    processEnv: process.env,
  });
  // Read package.json from the JUNCTION-FREE resolved path; on Windows the
  // `current` junction is unreliable to traverse for fs reads. When the
  // marker file is missing (legacy installs / fresh boxes) `paths.currentPath`
  // is still used as a last resort so we don't regress non-Windows envs.
  const currentVersion = await readPackageVersion(paths.resolvedCurrentPath ?? paths.currentPath);
  const fallbackVersion = currentVersion ?? (await listInstalledVersionIdsNewestFirst({
    componentId: 'happier-cli',
    channel,
    processEnv: process.env,
  }))[0] ?? null;

  if (!fallbackVersion) {
    return null;
  }

  const binaryPath = currentVersion
    ? (paths.resolvedBinaryPath ?? paths.binaryPath)
    : resolveBinaryPathForVersion({
        channel,
        versionId: fallbackVersion,
      });

  return {
    id: `firstPartyManaged:${toSnapshotRing(channel)}`,
    source: 'firstPartyManaged',
    components: ['happier-cli'],
    ring: toSnapshotRing(channel),
    version: fallbackVersion,
    path: binaryPath,
    realPath: await resolveRealPath(binaryPath),
    shimName: paths.shimPaths[0] ? basename(paths.shimPaths[0]).replace(/\.exe$/i, '') : null,
    onPath: paths.shimPaths.some((shimPath) => isPathDirectoryOnPath(dirname(shimPath))),
    managedRoot: paths.installRoot,
  };
}

function resolveActiveInstallationId(
  activeInvocation: HappierActiveInvocation | null,
  installations: readonly HappierInstallation[],
): string | null {
  if (!activeInvocation) {
    return null;
  }

  const invokedPaths = new Set(
    [activeInvocation.path, activeInvocation.realPath]
      .map((value) => String(value ?? '').trim())
      .filter(Boolean),
  );

  for (const installation of installations) {
    const candidatePaths = [installation.path, installation.realPath]
      .map((value) => String(value ?? '').trim())
      .filter(Boolean);
    if (candidatePaths.some((value) => invokedPaths.has(value))) {
      return installation.id;
    }
  }

  const currentRing = activeInvocation.ring;
  if (!currentRing) {
    return null;
  }

  return installations.find((installation) => installation.ring === currentRing)?.id ?? null;
}

async function readActiveInvocation(installations: readonly HappierInstallation[]): Promise<HappierActiveInvocation | null> {
  const envInvokedPath = String(process.env.HAPPIER_CLI_INVOKED_PATH ?? '').trim();
  const path = envInvokedPath || String(process.argv[1] ?? '').trim();
  if (!path) {
    return null;
  }

  const activeInvocation: HappierActiveInvocation = {
    path,
    realPath: await resolveRealPath(path),
    invokerName: resolveInvokerName(),
    ring: toSnapshotRing(configuration.publicReleaseRing),
    version: String(configuration.currentCliVersion ?? '').trim() || null,
    installationId: null,
  };
  activeInvocation.installationId = resolveActiveInstallationId(activeInvocation, installations);
  return activeInvocation;
}

export async function readDoctorInstallations(): Promise<HappierInstallations> {
  const managedInstallations = (
    await Promise.all(CLI_CHANNELS.map(async (channel) => await readManagedInstallation(channel)))
  ).filter((installation): installation is HappierInstallation => installation !== null);

  const activeInvocation = await readActiveInvocation(managedInstallations);
  const installations = [...managedInstallations];

  if (activeInvocation && !activeInvocation.installationId) {
    installations.unshift({
      id: `active:${activeInvocation.path}`,
      source: 'pathBinary',
      components: ['happier-cli'],
      ring: activeInvocation.ring,
      version: activeInvocation.version,
      path: activeInvocation.path,
      realPath: activeInvocation.realPath,
      shimName: activeInvocation.invokerName,
      onPath: true,
      managedRoot: null,
    });
  }

  return {
    activeInvocation,
    installations,
  };
}
