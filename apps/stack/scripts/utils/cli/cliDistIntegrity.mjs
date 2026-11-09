import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import cliDistBuildManifest from './cliDistBuildManifestLoader.mjs';
import { probeRuntimeImport } from '../proc/runtimeImportProbe.mjs';

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

export const readCliDistBuildManifest = cliDistBuildManifest.readCliDistBuildManifest;

export const readCliDistClosureFingerprint = cliDistBuildManifest.readCliDistClosureFingerprint;
export const writeCliDistBuildManifest = cliDistBuildManifest.writeCliDistBuildManifest;

export async function probeCliDistRuntimeImport(entrypoint, options = {}) {
  const entry = String(entrypoint ?? '').trim();
  if (!entry) {
    throw new Error('[cli-dist] runtime import probe missing entrypoint');
  }
  const nodeExecutable = options.nodeExecutable ?? process.execPath;
  const timeoutMsRaw = Number(options.timeoutMs ?? DEFAULT_CLI_DIST_RUNTIME_IMPORT_TIMEOUT_MS);
  // Source preparation passes null: the enclosing request owns cancellation.
  const timeoutMs = options.timeoutMs === null ? undefined : Number.isFinite(timeoutMsRaw) && timeoutMsRaw > 0
    ? Math.trunc(timeoutMsRaw)
    : DEFAULT_CLI_DIST_RUNTIME_IMPORT_TIMEOUT_MS;
  const scratch = await mkdtemp(join(tmpdir(), 'hstack-cli-import-probe-'));
  const env = {
    ...process.env,
    ...(options.env ?? {}),
    // Run the real daemon command loader rather than suppressing CLI dispatch.
    // This reaches command-owned lazy imports while --help keeps the probe side-effect free.
    [CLI_DIST_INTEGRITY_PROBE_ENV]: 'daemon-command',
    HAPPIER_CLI_RUNTIME_DISABLE: '1',
    HAPPIER_CLI_UPDATE_CHECK: '0',
    // Index bootstrap can read credentials before command dispatch. A module
    // probe must neither query the incumbent Account nor share its daemon lock.
    HAPPIER_HOME_DIR: scratch,
    HAPPIER_STACK_CLI_HOME_DIR: scratch,
  };
  try {
    const result = await probeRuntimeImport({ entrypoint: entry, args: ['daemon', '--help'],
      nodeExecutable, cwd: options.cwd, env, signal: options.signal, timeoutMs });
    if (result.status === 'failed') {
      const message = result.loadError?.code === 'import_timeout'
        ? `[cli-dist] runtime import probe timed out after ${timeoutMs}ms for ${entry}`
        : `[cli-dist] runtime import probe failed for ${entry} (code=${result.exitCode}, signal=${result.signal ?? 'none'}).\n${result.loadError?.name}: ${result.loadError?.message}`;
      throw Object.assign(new Error(message), {
        firstFailingModule: result.firstFailingModule, loadError: result.loadError,
      });
    }
  } finally { await rm(scratch, { recursive: true, force: true }); }
}
