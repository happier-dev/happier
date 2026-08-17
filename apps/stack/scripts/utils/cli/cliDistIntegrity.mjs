import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

import cliDistBuildManifest from './cliDistBuildManifestLoader.mjs';

export const CLI_DIST_INTEGRITY_PROBE_ENV = 'HAPPIER_CLI_DIST_INTEGRITY_PROBE';
export const CLI_DIST_BUILD_MANIFEST = cliDistBuildManifest.CLI_DIST_BUILD_MANIFEST;
export const DEFAULT_CLI_DIST_RUNTIME_IMPORT_TIMEOUT_MS = 120_000;

export function isCliScriptEntrypoint(pathLike) {
  const value = String(pathLike ?? '').trim().toLowerCase();
  return value.endsWith('.mjs') || value.endsWith('.js') || value.endsWith('.cjs');
}

export function isCliDirectExecutableCommand(cliBin) {
  const bin = String(cliBin ?? '').trim();
  if (!bin) return false;
  return !isCliScriptEntrypoint(bin);
}

export function resolveCliDistEntrypointFromBin(cliBin) {
  const bin = String(cliBin ?? '').trim();
  if (!bin) return null;
  if (!isCliScriptEntrypoint(bin)) return null;
  try {
    const binDir = dirname(bin);
    const fallbackBuildEntrypoint = join(binDir, '..', 'dist', 'index.mjs');
    const candidates = [
      fallbackBuildEntrypoint,
      join(binDir, '..', 'package-dist', 'index.mjs'),
    ];
    let firstExistingCandidate = null;
    for (const candidate of candidates) {
      if (!existsSync(candidate)) continue;
      firstExistingCandidate ??= candidate;
      if (readCliDistIntegrity(candidate).ok) return candidate;
    }
    return firstExistingCandidate ?? fallbackBuildEntrypoint;
  } catch {
    return null;
  }
}

export function readCliDistIntegrity(entrypoint) {
  return cliDistBuildManifest.readCliDistBuildManifest(entrypoint);
}

export function readCliDistBuildManifest(entrypoint) {
  if (!entrypoint || !existsSync(entrypoint)) {
    return {
      ok: false,
      reason: 'missing_entrypoint',
      fingerprint: null,
      maxMtimeMs: null,
      fileCount: 0,
      manifestPath: null,
    };
  }
  try {
    const entrypointStat = statSync(entrypoint);
    if (!entrypointStat.isFile() || entrypointStat.size === 0) {
      return {
        ok: false,
        reason: 'empty_entrypoint',
        fingerprint: null,
        maxMtimeMs: null,
        fileCount: 0,
        manifestPath: join(dirname(String(entrypoint)), CLI_DIST_BUILD_MANIFEST),
      };
    }
  } catch {
    return {
      ok: false,
      reason: 'unreadable_entrypoint',
      fingerprint: null,
      maxMtimeMs: null,
      fileCount: 0,
      manifestPath: join(dirname(String(entrypoint)), CLI_DIST_BUILD_MANIFEST),
    };
  }
  const manifestPath = join(dirname(String(entrypoint)), CLI_DIST_BUILD_MANIFEST);
  if (!existsSync(manifestPath)) {
    return {
      ok: false,
      reason: 'missing_build_manifest',
      fingerprint: null,
      maxMtimeMs: null,
      fileCount: 0,
      manifestPath,
    };
  }
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    const fingerprint = String(manifest?.fingerprint ?? '').trim().toLowerCase();
    if (!/^[a-f0-9]{16}$/.test(fingerprint)) {
      return {
        ok: false,
        reason: 'invalid_build_manifest_fingerprint',
        fingerprint: null,
        maxMtimeMs: null,
        fileCount: 0,
        manifestPath,
      };
    }
    const fileCount = Number(manifest?.fileCount);
    return {
      ok: true,
      reason: 'manifest',
      fingerprint,
      maxMtimeMs: null,
      fileCount: Number.isFinite(fileCount) && fileCount >= 0 ? Math.trunc(fileCount) : 0,
      manifestPath,
      manifest,
    };
  } catch {
    return {
      ok: false,
      reason: 'invalid_build_manifest',
      fingerprint: null,
      maxMtimeMs: null,
      fileCount: 0,
      manifestPath,
    };
  }
}

export const readCliDistClosureFingerprint = cliDistBuildManifest.readCliDistClosureFingerprint;
export const writeCliDistBuildManifest = cliDistBuildManifest.writeCliDistBuildManifest;

export async function probeCliDistRuntimeImport(entrypoint, options = {}) {
  const entry = String(entrypoint ?? '').trim();
  if (!entry) {
    throw new Error('[cli-dist] runtime import probe missing entrypoint');
  }
  const nodeExecutable = options.nodeExecutable ?? process.execPath;
  const timeoutMsRaw = Number(options.timeoutMs ?? DEFAULT_CLI_DIST_RUNTIME_IMPORT_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(timeoutMsRaw) && timeoutMsRaw > 0
    ? Math.trunc(timeoutMsRaw)
    : DEFAULT_CLI_DIST_RUNTIME_IMPORT_TIMEOUT_MS;
  const env = {
    ...process.env,
    ...(options.env ?? {}),
    // Run the real daemon command loader rather than suppressing CLI dispatch.
    // This reaches command-owned lazy imports while --help keeps the probe side-effect free.
    [CLI_DIST_INTEGRITY_PROBE_ENV]: 'daemon-command',
    HAPPIER_CLI_RUNTIME_DISABLE: '1',
    HAPPIER_CLI_UPDATE_CHECK: '0',
  };

  await new Promise((resolve, reject) => {
    const child = spawn(nodeExecutable, [entry, 'daemon', '--help'], {
      cwd: options.cwd,
      env,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let spawnError = null;
    const timeout = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    timeout.unref?.();
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (error) => {
      spawnError = error;
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (timedOut) {
        reject(new Error(`[cli-dist] runtime import probe timed out after ${timeoutMs}ms for ${entry}`));
        return;
      }
      if (spawnError) {
        reject(spawnError);
        return;
      }
      if (code === 0) {
        resolve();
        return;
      }
      const suffix = stderr.trim() ? `\n${stderr.trim().split('\n').slice(-8).join('\n')}` : '';
      reject(new Error(`[cli-dist] runtime import probe failed for ${entry} (code=${code}, signal=${signal ?? 'none'}).${suffix}`));
    });
  });
}
