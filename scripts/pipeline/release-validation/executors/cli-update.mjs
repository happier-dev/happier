// @ts-check

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

import { execYarn } from '../../../workspaces/execYarnCommand.mjs';
import { resolveCoreE2eSlowSuiteCommand } from './core-e2e-slow-suite.mjs';

const CLI_UPDATE_CONTINUITY_TEST_FILES = [
  'suites/core-e2e/session.continuity.fakeClaude.cliUpdate.slow.e2e.test.ts',
];

/**
 * @typedef {{ kind: string; ref: string }} ReleaseValidationSource
 * @typedef {{ from: ReleaseValidationSource; to: ReleaseValidationSource }} ReleaseValidationUpdate
 * @typedef {(command: string, args: string[], options?: import('node:child_process').ExecFileSyncOptions) => unknown} ExecFileSyncLike
 */

/**
 * @param {string} repoRoot
 * @returns {string}
 */
function createLocalBuildPackDir(repoRoot) {
  const packDir = resolve(
    repoRoot,
    '.project',
    'tmp',
    'release-validation',
    'cli-update-local-packs',
    `${process.pid}-${Date.now()}`,
  );
  mkdirSync(packDir, { recursive: true });
  return packDir;
}

/**
 * @param {string} packDir
 * @param {unknown} raw
 * @returns {string}
 */
function resolvePackedTarballPath(packDir, raw) {
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw ?? '');
  const explicit = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .reverse()
    .find((line) => line.endsWith('.tgz'));
  if (explicit) {
    const resolved = resolve(explicit);
    if (existsSync(resolved)) return resolved;
    const fromPackDir = resolve(packDir, explicit);
    if (existsSync(fromPackDir)) return fromPackDir;
  }

  const candidates = readdirSync(packDir)
    .filter((entry) => entry.endsWith('.tgz'))
    .map((entry) => {
      const abs = resolve(packDir, entry);
      return { abs, mtimeMs: statSync(abs).mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  const newest = candidates[0]?.abs;
  if (!newest || !existsSync(newest)) {
    throw new Error(`Expected cli-update local-build packaging to produce a .tgz under ${packDir}`);
  }
  return newest;
}

/**
 * @param {{ tarballPath: string; exec: ExecFileSyncLike }} params
 */
function assertCliPackHasRuntimeEntrypoints({ tarballPath, exec }) {
  const raw = exec('tar', ['-tzf', tarballPath], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const listing = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw ?? '');
  const entries = new Set(listing.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean));
  const requiredEntries = ['package/dist/index.mjs', 'package/package-dist/index.mjs'];
  const missing = requiredEntries.filter((entry) => !entries.has(entry));
  if (missing.length > 0) {
    throw new Error(`cli-update local-build pack is missing required runtime entries: ${missing.join(', ')} (${tarballPath})`);
  }
}

/**
 * @param {{ repoRoot: string; exec: ExecFileSyncLike; platform?: NodeJS.Platform; npmExecPath?: string; comspec?: string }} params
 * @returns {ReleaseValidationSource}
 */
function packLocalBuildCliSource({ repoRoot, exec, platform = process.platform, npmExecPath = process.env.npm_execpath, comspec }) {
  const packDir = createLocalBuildPackDir(repoRoot);
  execYarn(['-s', 'workspace', '@happier-dev/cli', 'build'], {
    execFileSync: exec,
    platform,
    npmExecPath,
    comspec,
    cwd: repoRoot,
    env: {
      ...process.env,
      CI: '1',
    },
    stdio: 'inherit',
    timeout: 10 * 60_000,
  });
  const tarballRaw = exec(process.execPath, [resolve(repoRoot, 'apps', 'cli', 'scripts', 'packTarball.mjs'), '--dest-dir', packDir], {
    cwd: resolve(repoRoot, 'apps', 'cli'),
    env: {
      ...process.env,
      CI: '1',
      npm_config_loglevel: 'silent',
    },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    timeout: 10 * 60_000,
  });
  const tarballPath = resolvePackedTarballPath(packDir, tarballRaw);
  assertCliPackHasRuntimeEntrypoints({ tarballPath, exec });
  return { kind: 'local-pack', ref: tarballPath };
}

/**
 * @param {{ repoRoot: string; update: ReleaseValidationUpdate; exec: ExecFileSyncLike; platform?: NodeJS.Platform; npmExecPath?: string; comspec?: string }} params
 * @returns {ReleaseValidationUpdate}
 */
function materializeCliUpdateSourcesForExecution({ repoRoot, update, exec, platform, npmExecPath, comspec }) {
  if (update.to.kind !== 'local-build') {
    return update;
  }
  return {
    ...update,
    to: packLocalBuildCliSource({ repoRoot, exec, platform, npmExecPath, comspec }),
  };
}

/**
 * @param {ReleaseValidationUpdate | null} update
 * @returns {ReleaseValidationUpdate}
 */
function requireCliUpdateSources(update) {
  if (!update) {
    throw new Error('cli-update requires --from-source/--from-ref and --to-source/--to-ref');
  }
  return update;
}

/**
 * @param {ReleaseValidationUpdate} update
 * @returns {Record<string, string>}
 */
function buildCliUpdateEnv(update) {
  return {
    HAPPIER_RELEASE_VALIDATION_CLI_UPDATE_FROM_SOURCE_KIND: update.from.kind,
    HAPPIER_RELEASE_VALIDATION_CLI_UPDATE_FROM_SOURCE_REF: update.from.ref,
    HAPPIER_RELEASE_VALIDATION_CLI_UPDATE_TO_SOURCE_KIND: update.to.kind,
    HAPPIER_RELEASE_VALIDATION_CLI_UPDATE_TO_SOURCE_REF: update.to.ref,
  };
}

/**
 * @param {{ repoRoot: string; update: ReleaseValidationUpdate | null }} params
 */
export function resolveCliUpdateExecution({ repoRoot, update }) {
  const resolvedUpdate = requireCliUpdateSources(update);
  return {
    ...resolveCoreE2eSlowSuiteCommand({
      repoRoot,
      testFiles: CLI_UPDATE_CONTINUITY_TEST_FILES,
    }),
    env: buildCliUpdateEnv(resolvedUpdate),
  };
}

/**
 * @param {{ repoRoot: string; update: ReleaseValidationUpdate | null; exec?: ExecFileSyncLike; platform?: NodeJS.Platform; npmExecPath?: string; comspec?: string }} params
 */
export function runCliUpdateValidation({
  repoRoot,
  update,
  exec = execFileSync,
  platform = process.platform,
  npmExecPath = process.env.npm_execpath,
  comspec,
}) {
  const execution = resolveCliUpdateExecution({
    repoRoot,
    update: materializeCliUpdateSourcesForExecution({
      repoRoot,
      update: requireCliUpdateSources(update),
      exec,
      platform,
      npmExecPath,
      comspec,
    }),
  });
  exec(execution.command, execution.args, {
    cwd: execution.cwd,
    env: {
      ...process.env,
      ...execution.env,
    },
    stdio: 'inherit',
  });
}
