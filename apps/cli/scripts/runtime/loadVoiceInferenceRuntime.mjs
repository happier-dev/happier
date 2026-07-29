import { existsSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, rename, rm, rmdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CLI_DEFERRED_VOICE_RUNTIME_ARCHIVE_ROOTS,
  CLI_DEFERRED_VOICE_RUNTIME_PACKAGES,
} from '@happier-dev/cli-common/componentArtifacts/deferredVoiceRuntimePackages';
import { extractArchivePayloadToDirectory } from '@happier-dev/release-runtime/archiveExtraction';

const require = createRequire(import.meta.url);
const DEFERRED_VOICE_RUNTIME_ARCHIVE_PREFIX = 'voice-inference-runtime';
let runtimeInstallPromise = null;

function createRuntimeUnavailableError(error) {
  const runtimeError = new Error(
    error instanceof Error && error.message.trim().length > 0
      ? `voice_inference_runtime_unavailable:${error.message}`
      : 'voice_inference_runtime_unavailable',
  );
  runtimeError.code = 'runtime_unavailable';
  return runtimeError;
}

function normalizeNodePlatform(platform) {
  return platform === 'win32' ? 'windows' : platform;
}

function isModuleResolutionFailure(error) {
  const code = error && typeof error === 'object' ? Reflect.get(error, 'code') : null;
  const message = error instanceof Error ? error.message : String(error ?? '');
  return (
    code === 'MODULE_NOT_FOUND'
    || message.includes('Cannot find module')
    || message.includes('Cannot find package')
    || message.includes('ERR_MODULE_NOT_FOUND')
  );
}

function resolveRuntimeRootPath() {
  return fileURLToPath(new URL('../../', import.meta.url));
}

function resolveDeferredVoiceInferenceRuntimeArchivePath() {
  const runtimeRoot = resolveRuntimeRootPath();
  const archiveName = `${DEFERRED_VOICE_RUNTIME_ARCHIVE_PREFIX}-${normalizeNodePlatform(process.platform)}-${process.arch}.tar.gz`;
  return join(runtimeRoot, 'tools', 'archives', archiveName);
}

function canResolveSherpaRuntime() {
  try {
    require.resolve('sherpa-onnx-node');
    return true;
  } catch (error) {
    if (isModuleResolutionFailure(error)) {
      return false;
    }
    throw error;
  }
}

async function pathStatsOrNull(path) {
  return await lstat(path).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
}

async function installDeferredRuntimePackagesFromArchive({
  archivePath,
  runtimeRoot,
}) {
  const extractedRuntimeRoot = await mkdtemp(join(runtimeRoot, '.voice-runtime-payload-'));
  const promotedPackagePaths = [];
  const createdParentPaths = [];
  try {
    await extractArchivePayloadToDirectory({
      allowedEntryRoots: CLI_DEFERRED_VOICE_RUNTIME_ARCHIVE_ROOTS,
      archiveName: archivePath,
      archivePath,
      extractDir: extractedRuntimeRoot,
    });

    const stagedPackages = [];
    for (const packageName of CLI_DEFERRED_VOICE_RUNTIME_PACKAGES) {
      const packageSegments = packageName.split('/');
      const stagedPackagePath = join(extractedRuntimeRoot, 'node_modules', ...packageSegments);
      const stagedPackageStats = await pathStatsOrNull(stagedPackagePath);
      if (!stagedPackageStats) continue;
      if (!stagedPackageStats.isDirectory() || stagedPackageStats.isSymbolicLink()) {
        throw new Error(`voice_inference_runtime_archive_invalid_package:${packageName}`);
      }
      const installedPackagePath = join(runtimeRoot, 'node_modules', ...packageSegments);
      if (await pathStatsOrNull(installedPackagePath)) {
        throw new Error(`voice_inference_runtime_package_already_exists:${packageName}`);
      }
      stagedPackages.push({
        installedPackagePath,
        packageName,
        stagedPackagePath,
      });
    }
    if (!stagedPackages.some(({ packageName }) => packageName === 'sherpa-onnx-node')) {
      throw new Error('voice_inference_runtime_archive_missing_sherpa');
    }

    const installedNodeModulesPath = join(runtimeRoot, 'node_modules');
    const installedNodeModulesStats = await pathStatsOrNull(installedNodeModulesPath);
    if (
      installedNodeModulesStats
      && (!installedNodeModulesStats.isDirectory() || installedNodeModulesStats.isSymbolicLink())
    ) {
      throw new Error('voice_inference_runtime_node_modules_invalid');
    }
    if (!installedNodeModulesStats) {
      await mkdir(installedNodeModulesPath);
      createdParentPaths.push(installedNodeModulesPath);
    }

    for (const { installedPackagePath, stagedPackagePath } of stagedPackages) {
      const parentPath = dirname(installedPackagePath);
      const parentStats = await pathStatsOrNull(parentPath);
      if (parentStats && (!parentStats.isDirectory() || parentStats.isSymbolicLink())) {
        throw new Error('voice_inference_runtime_package_parent_invalid');
      }
      if (!parentStats) {
        await mkdir(parentPath);
        createdParentPaths.push(parentPath);
      }
      await rename(stagedPackagePath, installedPackagePath);
      promotedPackagePaths.push(installedPackagePath);
    }

    if (!canResolveSherpaRuntime()) {
      throw new Error('voice_inference_runtime_archive_extract_failed');
    }
  } catch (error) {
    await Promise.all(promotedPackagePaths.map(async (path) => {
      await rm(path, { recursive: true, force: true });
    }));
    for (const path of [...createdParentPaths].reverse()) {
      await rmdir(path).catch((cleanupError) => {
        if (cleanupError?.code !== 'ENOENT' && cleanupError?.code !== 'ENOTEMPTY') {
          throw cleanupError;
        }
      });
    }
    throw error;
  } finally {
    await rm(extractedRuntimeRoot, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 10,
    });
  }
}

async function ensureDeferredVoiceInferenceRuntimeInstalled() {
  if (!runtimeInstallPromise) {
    runtimeInstallPromise = (async () => {
      if (canResolveSherpaRuntime()) {
        return;
      }

      const runtimeRoot = resolveRuntimeRootPath();
      const archivePath = resolveDeferredVoiceInferenceRuntimeArchivePath();
      if (!existsSync(archivePath)) {
        throw new Error('Cannot find module sherpa-onnx-node');
      }

      await installDeferredRuntimePackagesFromArchive({ archivePath, runtimeRoot });
    })();
  }

  try {
    await runtimeInstallPromise;
  } catch (error) {
    runtimeInstallPromise = null;
    throw error;
  }
}

try {
  await ensureDeferredVoiceInferenceRuntimeInstalled();
  await import('sherpa-onnx-node');
} catch (error) {
  throw createRuntimeUnavailableError(error);
}

export { voiceInferenceRuntimeEngine } from '../../package-dist/daemon/voiceInference/runtime/packagedVoiceInferenceRuntime.mjs';
