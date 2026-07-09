import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const CLI_DIST_INTEGRITY_PROBE_ENV = 'HAPPIER_CLI_DIST_INTEGRITY_PROBE';
export const CLI_DIST_BUILD_MANIFEST = '.build-manifest.json';

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
  return readCliDistBuildManifest(entrypoint);
}

export function readCliDistBuildManifest(entrypoint) {
  if (!entrypoint || !existsSync(entrypoint)) {
    return {
      ok: false,
      reason: 'missing_entrypoint',
      fingerprint: null,
      fileCount: 0,
      manifestPath: null,
    };
  }
  const manifestPath = join(dirname(String(entrypoint)), CLI_DIST_BUILD_MANIFEST);
  if (!existsSync(manifestPath)) {
    return {
      ok: false,
      reason: 'missing_build_manifest',
      fingerprint: null,
      fileCount: 0,
      manifestPath,
    };
  }
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    const fingerprint = String(manifest?.fingerprint ?? '').trim();
    if (!/^[a-f0-9]{16}$/i.test(fingerprint)) {
      return {
        ok: false,
        reason: 'invalid_build_manifest_fingerprint',
        fingerprint: null,
        fileCount: 0,
        manifestPath,
      };
    }
    const fileCount = Number(manifest?.fileCount);
    return {
      ok: true,
      reason: 'manifest',
      fingerprint: fingerprint.toLowerCase(),
      fileCount: Number.isFinite(fileCount) && fileCount >= 0 ? Math.trunc(fileCount) : 0,
      manifestPath,
      manifest,
    };
  } catch {
    return {
      ok: false,
      reason: 'invalid_build_manifest',
      fingerprint: null,
      fileCount: 0,
      manifestPath,
    };
  }
}

export const readCliDistClosureFingerprint = readCliDistBuildManifest;

export async function probeCliDistRuntimeImport(entrypoint, options = {}) {
  const entry = String(entrypoint ?? '').trim();
  if (!entry) {
    throw new Error('[cli-dist] runtime import probe missing entrypoint');
  }
  const nodeExecutable = options.nodeExecutable ?? process.execPath;
  const timeoutMsRaw = Number(options.timeoutMs ?? 30_000);
  const timeoutMs = Number.isFinite(timeoutMsRaw) && timeoutMsRaw > 0 ? Math.trunc(timeoutMsRaw) : 30_000;
  const env = {
    ...process.env,
    ...(options.env ?? {}),
    [CLI_DIST_INTEGRITY_PROBE_ENV]: '1',
  };
  const source = `await import(${JSON.stringify(pathToFileURL(entry).href)});`;

  await new Promise((resolve, reject) => {
    const child = spawn(nodeExecutable, ['--input-type=module', '--eval', source], {
      cwd: options.cwd,
      env,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`[cli-dist] runtime import probe timed out after ${timeoutMs}ms for ${entry}`));
    }, timeoutMs);
    timeout.unref?.();
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (code === 0) {
        resolve();
        return;
      }
      const suffix = stderr.trim() ? `\n${stderr.trim().split('\n').slice(-8).join('\n')}` : '';
      reject(new Error(`[cli-dist] runtime import probe failed for ${entry} (code=${code}, signal=${signal ?? 'none'}).${suffix}`));
    });
  });
}
