import { createHash } from 'node:crypto';
import { constants as fsConstants, createReadStream } from 'node:fs';
import { access, chmod, mkdir, readFile, rename, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { z } from 'zod/mini';

import {
  createManagedToolScratchDir,
  downloadGitHubReleaseAsset,
  AgentCliDownloadError,
  promoteManagedCurrentInstall,
  resolveManagedToolsRoot,
} from '@happier-dev/cli-common/agents';
import { ExecFileTerminationError } from '@happier-dev/cli-common/process';
import { removeHappierTempDirAsync } from '@happier-dev/cli-common/tempDirs';
import { ArchiveExtractionTimeoutError, extractArchivePayloadToDirectory } from '@happier-dev/release-runtime/archiveExtraction';

import type { InstallableDependencyDescriptor, InstallChecksumStateV1 } from '@happier-dev/protocol/installables';

import { configuration } from '@/configuration';
import { writeBytesAtomic } from '@/utils/fs/writeJsonAtomic';
import type { RuntimeInstallableAdapter, RuntimeInstallableCapabilityStatusParams, RuntimeInstallableInstallErrorCode, RuntimeInstallableInstallOptions, RuntimeInstallableLaunchCommandParams } from '../registry';

export type PinnedArchiveAsset = Readonly<{
  archiveUrl: string;
  sha256?: string;
  kind?: 'archive' | 'executable';
  executableSubpath: string;
  args?: readonly string[];
}>;

export type PinnedArchiveInstallResult =
  | Readonly<{ ok: true; executablePath: string; version: string; integrityDigest: string | null; checksum: InstallChecksumStateV1 }>
  | Readonly<{ ok: false; errorMessage: string; errorCode?: RuntimeInstallableInstallErrorCode }>;

function installRoot(installId: string, env?: NodeJS.ProcessEnv): string {
  return join(resolveManagedToolsRoot(env ?? { ...process.env, HAPPIER_HOME_DIR: configuration.happyHomeDir }), installId);
}

const MANAGED_VERSION_FILENAME = '.happier-managed-version';
const MANAGED_EXECUTABLE_DIGEST_FILENAME = '.happier-managed-executable-sha256';

const PinnedArchiveManagedDefinitionReceiptSchema = z.strictObject({
  version: z.string().check(z.minLength(1)),
  definitionId: z.string().check(z.trim(), z.minLength(1)),
  title: z.string().check(z.trim(), z.minLength(1)),
  kind: z.literal('archive'),
});
const PinnedArchiveManagedDefinitionStoredReceiptSchema = (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: undefined }) as z.ZodMiniObject<T['shape'], z.core.$strip>)(PinnedArchiveManagedDefinitionReceiptSchema);

export type PinnedArchiveManagedVersion =
  | Readonly<{ version: string; kind?: undefined; definitionId?: undefined; title?: undefined }>
  | Readonly<z.infer<typeof PinnedArchiveManagedDefinitionReceiptSchema>>;

export async function readPinnedArchiveManagedVersion(params: Readonly<{
  installId: string;
  env?: NodeJS.ProcessEnv;
}>): Promise<PinnedArchiveManagedVersion | null> {
  try {
    const stored = await readFile(join(currentRoot(params.installId, params.env), MANAGED_VERSION_FILENAME), 'utf8');
    if (!stored) return null;
    // Built-in artifacts still write their plain version; Account definitions
    // write the same file as a minimal receipt for removal and Storage labels.
    if (!stored.trimStart().startsWith('{')) return { version: stored };
    const decoded: unknown = JSON.parse(stored);
    const parsed = PinnedArchiveManagedDefinitionStoredReceiptSchema.safeParse(decoded);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function removePinnedArchiveManagedInstall(params: Readonly<{
  installId: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}>): Promise<void> {
  params.signal?.throwIfAborted();
  await rm(installRoot(params.installId, params.env), { recursive: true, force: true });
}

async function computeFileSha256Hex(path: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path, { signal })) {
    signal?.throwIfAborted();
    hash.update(chunk);
  }
  return hash.digest('hex');
}

function currentRoot(installId: string, env?: NodeJS.ProcessEnv): string {
  return join(installRoot(installId, env), 'current');
}

/** Replacement guards observe physical current bytes, including an older pin or damaged receipt. */
export async function hasPinnedArchiveManagedInstall(params: Readonly<{ installId: string; env?: NodeJS.ProcessEnv }>): Promise<boolean> {
  try { await access(currentRoot(params.installId, params.env)); return true; }
  catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}

function safeExecutablePath(root: string, executableSubpath: string): string | null {
  if (isAbsolute(executableSubpath)) return null;
  const candidate = join(root, executableSubpath);
  const fromRoot = relative(root, candidate);
  if (!fromRoot || fromRoot === '..' || fromRoot.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(fromRoot)) {
    return null;
  }
  return candidate;
}

export async function resolveInstalledPinnedArchiveExecutable(params: Readonly<{
  installId: string;
  executableSubpath: string;
  version?: string;
  platform?: NodeJS.Platform | string;
  env?: NodeJS.ProcessEnv;
}>): Promise<string | null> {
  if (params.version) {
    const installedVersion = await readPinnedArchiveManagedVersion(params);
    if (installedVersion?.version !== params.version) return null;
  }
  const candidate = safeExecutablePath(currentRoot(params.installId, params.env), params.executableSubpath);
  if (!candidate) return null;
  try {
    await access(candidate, (params.platform ?? process.platform) === 'win32' ? fsConstants.F_OK : fsConstants.X_OK);
  } catch {
    return null;
  }
  try {
    const storedDigest = (await readFile(join(currentRoot(params.installId, params.env), MANAGED_EXECUTABLE_DIGEST_FILENAME), 'utf8')).trim();
    if (!/^sha256:[0-9a-f]{64}$/i.test(storedDigest)) return null;
    const actualDigest = `sha256:${await computeFileSha256Hex(candidate)}`;
    if (actualDigest.toLowerCase() !== storedDigest.toLowerCase()) return null;
    return candidate;
  } catch {
    return null;
  }
}

export async function installPinnedArchive(params: Readonly<{
  installId: string;
  version: string;
  asset: PinnedArchiveAsset;
  archiveExtractionLimits?: Extract<InstallableDependencyDescriptor['source'], { kind: 'pinned_archive' }>['archiveExtractionLimits'];
  platform?: NodeJS.Platform | string;
}> & RuntimeInstallableInstallOptions): Promise<PinnedArchiveInstallResult> {
  const platform = params.platform ?? process.platform;
  const root = installRoot(params.installId, params.env);
  const scratchDir = await createManagedToolScratchDir({ installDir: root, prefix: params.installId });
  let errorCode: RuntimeInstallableInstallErrorCode = 'download-failed';
  try {
    params.signal?.throwIfAborted();
    const archiveName = basename(new URL(params.asset.archiveUrl).pathname) || 'archive.zip';
    const archivePath = join(scratchDir, 'download');
    const extractDir = join(scratchDir, 'extract');
    const candidateDir = join(scratchDir, 'candidate');
    const integrityDigest = params.asset.sha256 ? `sha256:${params.asset.sha256}` : null;
    await downloadGitHubReleaseAsset({
      signal: params.signal,
      onProgress: params.onProgress,
      url: params.asset.archiveUrl,
      destinationPath: archivePath,
      digest: integrityDigest,
      userAgent: 'happier-cli',
    });
    params.signal?.throwIfAborted();
    errorCode = 'verification-failed';
    const candidateExecutable = safeExecutablePath(candidateDir, params.asset.executableSubpath);
    if (!candidateExecutable) {
      return { ok: false, errorMessage: 'Pinned archive executable path is unsafe', errorCode };
    }
    if (params.asset.kind === 'executable') {
      await mkdir(dirname(candidateExecutable), { recursive: true });
      await rename(archivePath, candidateExecutable);
    } else {
      params.onProgress?.({ t: 'log', line: 'Extracting archive' });
      await extractArchivePayloadToDirectory({
        signal: params.signal,
        archivePath,
        archiveName,
        extractDir,
        limits: params.archiveExtractionLimits,
      });
      params.signal?.throwIfAborted();
      // Keep the archive root so companion files and explicit wrapper paths agree.
      await rename(extractDir, candidateDir);
    }
    params.signal?.throwIfAborted();
    try {
      await access(candidateExecutable, fsConstants.F_OK);
    } catch {
      return { ok: false, errorMessage: `Pinned archive executable missing at ${params.asset.executableSubpath}`, errorCode };
    }
    if (platform !== 'win32') await chmod(candidateExecutable, 0o755);
    params.onProgress?.({ t: 'log', line: 'Verifying executable' });
    const executableDigest = `sha256:${await computeFileSha256Hex(candidateExecutable, params.signal)}`;
    const versionContent = params.managedAcpDefinition
      ? JSON.stringify(PinnedArchiveManagedDefinitionReceiptSchema.parse({
        version: params.version,
        definitionId: params.managedAcpDefinition.definitionId,
        title: params.managedAcpDefinition.title,
        kind: 'archive',
      }))
      : params.version;
    await writeBytesAtomic(join(candidateDir, MANAGED_VERSION_FILENAME), new TextEncoder().encode(versionContent));
    await writeBytesAtomic(join(candidateDir, MANAGED_EXECUTABLE_DIGEST_FILENAME), new TextEncoder().encode(executableDigest));
    await promoteManagedCurrentInstall({
      signal: params.signal,
      installRoot: root,
      candidatePath: candidateDir,
      preserveExistingCurrent: params.managedAcpDefinition !== undefined,
      currentPath: currentRoot(params.installId, params.env),
    });
    const executablePath = safeExecutablePath(currentRoot(params.installId, params.env), params.asset.executableSubpath);
    if (!executablePath) return { ok: false, errorMessage: 'Pinned archive executable path is unsafe' };
    return { ok: true, executablePath, version: params.version, integrityDigest, checksum: integrityDigest ? 'verified' : 'not_published' };
  } catch (error) {
    if (error instanceof ExecFileTerminationError) throw error;
    if (!(error instanceof AgentCliDownloadError) && !(error instanceof ArchiveExtractionTimeoutError)
      && ((params.signal?.aborted && error === params.signal.reason)
        || (error instanceof Error && error.name === 'AbortError'))) throw error;
    return {
      ok: false,
      errorMessage: error instanceof Error ? error.message : 'Pinned archive install failed',
      errorCode: error instanceof ArchiveExtractionTimeoutError
        ? 'command-timed-out'
        : error instanceof AgentCliDownloadError ? error.errorCode : errorCode,
    };
  } finally {
    await removeHappierTempDirAsync(scratchDir);
  }
}

export function createPinnedArchiveRuntimeInstallableAdapter(params: Readonly<{
  installId: `dep.${string}`;
  /** Retained product-source storage, when older installs predate their dep.* capability. */
  managedInstallId?: string;
  version: string;
  asset: PinnedArchiveAsset;
  archiveExtractionLimits?: Extract<InstallableDependencyDescriptor['source'], { kind: 'pinned_archive' }>['archiveExtractionLimits'];
  platform?: NodeJS.Platform | string;
}>): RuntimeInstallableAdapter {
  const managedInstallId = params.managedInstallId ?? params.installId;
  const resolve = async (env?: NodeJS.ProcessEnv) => await resolveInstalledPinnedArchiveExecutable({
    env,
    installId: managedInstallId,
    executableSubpath: params.asset.executableSubpath,
    version: params.version,
    platform: params.platform,
  });
  return Object.freeze({
    key: params.installId,
    capabilityId: params.installId,
    async detectCapabilityStatus(options: RuntimeInstallableCapabilityStatusParams = {}) {
      const executablePath = await resolve(options.env);
      // One status shape for both readers: the managed-dependency host reads
      // `version`/`availableVersion`, the capability/UI installables path reads
      // the `installed` projection. A pinned artifact has no update discovery,
      // so the installed version is also the available version. This installer
      // writes no install log, and the installed executable is not one.
      return Object.freeze({
        installed: executablePath !== null,
        installedVersion: executablePath ? params.version : null,
        sourceKind: 'pinned_archive' as const,
        lastInstallLogPath: null,
        lastBackgroundUpdateCheckAtMs: null,
        ...(executablePath ? { version: params.version, availableVersion: params.version } : {}),
      });
    },
    async detectLaunchResolution(options: Readonly<{ env?: NodeJS.ProcessEnv }> = {}) {
      const executablePath = await resolve(options.env);
      return Object.freeze({
        availability: executablePath
          ? Object.freeze({ ok: true as const })
          : Object.freeze({ ok: false as const, errorMessage: 'Pinned archive executable is not installed' }),
        canAutoInstall: true,
        canBackgroundAutoUpdate: false,
      });
    },
    async resolveLaunchCommand(options: RuntimeInstallableLaunchCommandParams = {}) {
      const command = await resolve(options.env);
      return command
        ? Object.freeze({ ok: true as const, command, args: Object.freeze([...(params.asset.args ?? [])]), source: 'managed' as const })
        : Object.freeze({ ok: false as const, errorMessage: 'Pinned archive executable is not installed', canAutoInstall: true });
    },
    async installOrUpgrade(options: RuntimeInstallableInstallOptions = {}) {
      const result = await installPinnedArchive({ ...params, ...options, installId: managedInstallId });
      return result.ok
        ? Object.freeze({ ok: true as const, logPath: null, checksum: result.checksum })
        : Object.freeze({ ok: false as const, errorMessage: result.errorMessage, errorCode: result.errorCode, logPath: null });
    },
    async removeManagedInstall(options: Readonly<{ env?: NodeJS.ProcessEnv; signal?: AbortSignal }> = {}) {
      await removePinnedArchiveManagedInstall({ ...options, installId: managedInstallId });
    },
    async runBackgroundAutoUpdateCheck() {},
  });
}

type PinnedArchiveSource = Extract<InstallableDependencyDescriptor['source'], { kind: 'pinned_archive' }>;

/**
 * Resolves the pinned-archive adapter for a projected installables descriptor,
 * so capability status/install and the launch-time managed-dependency host
 * share this one installer. Returns `null` when the pinned source publishes no
 * artifact for the running host, which is an unsupported platform rather than
 * an install failure.
 */
export function getPinnedArchiveRuntimeInstallableAdapter(
  descriptor: InstallableDependencyDescriptor,
  host: Readonly<{ platform?: NodeJS.Platform; architecture?: string }> = {},
): RuntimeInstallableAdapter | null {
  if (descriptor.source.kind !== 'pinned_archive') return null;
  const platform = host.platform ?? process.platform;
  const architecture = host.architecture ?? process.arch;
  if (platform !== 'darwin' && platform !== 'linux' && platform !== 'win32') return null;
  if (architecture !== 'arm64' && architecture !== 'x64') return null;
  const platformKey = `${platform}-${architecture}` as keyof PinnedArchiveSource['assetsByPlatform'];
  const asset = descriptor.source.assetsByPlatform[platformKey];
  if (!asset) return null;
  return createPinnedArchiveRuntimeInstallableAdapter({
    installId: descriptor.capabilityId,
    version: descriptor.source.version,
    asset,
    archiveExtractionLimits: descriptor.source.archiveExtractionLimits,
    platform,
  });
}
