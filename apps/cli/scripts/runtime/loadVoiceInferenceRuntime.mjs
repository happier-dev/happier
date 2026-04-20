import { createReadStream, existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGunzip } from 'node:zlib';

import * as tar from 'tar';

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

function isSafeDeferredRuntimeArchiveEntry(rawPath, entry, runtimeRoot) {
  if (typeof rawPath !== 'string' || rawPath.length === 0) {
    return { ok: false, reason: 'missing_path' };
  }

  if (rawPath.includes('\0')) {
    return { ok: false, reason: 'nul_path' };
  }

  // Guard against absolute paths / Windows drive paths / path traversal.
  if (rawPath.startsWith('/') || rawPath.startsWith('\\')) {
    return { ok: false, reason: 'absolute_path' };
  }
  if (/^[A-Za-z]:[\\/]/.test(rawPath)) {
    return { ok: false, reason: 'drive_path' };
  }

  // We only expect to unpack into node_modules/** (see buildCliBinaryArtifactPayload.ts).
  const normalized = rawPath.replace(/\\/g, '/');
  if (normalized !== 'node_modules' && !normalized.startsWith('node_modules/')) {
    return { ok: false, reason: 'unexpected_root' };
  }

  const destPath = resolve(runtimeRoot, normalized);
  const runtimeRootResolved = resolve(runtimeRoot);
  const runtimeRootPrefix = runtimeRootResolved.endsWith(sep)
    ? runtimeRootResolved
    : `${runtimeRootResolved}${sep}`;
  if (destPath !== runtimeRootResolved && !destPath.startsWith(runtimeRootPrefix)) {
    return { ok: false, reason: 'path_escape' };
  }

  const type = entry && typeof entry === 'object' ? entry.type : null;
  if (type && type !== 'File' && type !== 'Directory') {
    return { ok: false, reason: `unsupported_type:${type}` };
  }

  return { ok: true };
}

async function validateDeferredVoiceInferenceRuntimeArchive(archivePath, runtimeRoot) {
  await new Promise((resolvePromise, rejectPromise) => {
    const parser = new tar.Parser({ strict: true });
    const source = createReadStream(archivePath);
    const gunzip = createGunzip();

    let finished = false;
    const finishOnce = (fn, value) => {
      if (finished) {
        return;
      }
      finished = true;
      try {
        source.destroy();
      } catch {
        // ignore
      }
      try {
        gunzip.destroy();
      } catch {
        // ignore
      }
      try {
        parser.destroy();
      } catch {
        // ignore
      }
      fn(value);
    };

    const fail = (error) => finishOnce(rejectPromise, error);

    parser.on('entry', (entry) => {
      const verdict = isSafeDeferredRuntimeArchiveEntry(entry.path, entry, runtimeRoot);
      if (!verdict.ok) {
        fail(new Error(
          `voice_inference_runtime_archive_unsafe_entry:${verdict.reason}:${String(entry.path ?? '')}`,
        ));
      }
      entry.resume();
    });
    parser.once('error', fail);
    parser.once('end', () => finishOnce(resolvePromise));
    source.once('error', fail);
    gunzip.once('error', fail);

    source.pipe(gunzip).pipe(parser);
  });
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

      // Validate the full archive before extracting so a malicious archive cannot partially write.
      await validateDeferredVoiceInferenceRuntimeArchive(archivePath, runtimeRoot);

      await mkdir(join(runtimeRoot, 'node_modules'), { recursive: true });
      await tar.x({
        file: archivePath,
        cwd: runtimeRoot,
        strict: true,
        preserveOwner: false,
      });

      if (!canResolveSherpaRuntime()) {
        throw new Error('voice_inference_runtime_archive_extract_failed');
      }
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
