import { spawnSync } from 'node:child_process';
import {
  existsSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

import { resolveYarnCommandInvocation } from '../../../scripts/workspaces/execYarnCommand.mjs';
import { verifyPackageExportTargets } from './verifyExports.mjs';

function rand() {
  return Math.random().toString(16).slice(2);
}

function sanitizeBuildId(value) {
  const raw = String(value ?? '').trim();
  return raw.replace(/[^a-zA-Z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '') || `${Date.now()}.${process.pid}.${rand()}`;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function collectTargetStrings(value, acc) {
  if (typeof value === 'string') {
    acc.push(value);
    return;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return;
  }
  for (const nested of Object.values(value)) {
    collectTargetStrings(nested, acc);
  }
}

function collectExpectedPackageTargets(packageJson) {
  const targets = [];
  for (const key of ['main', 'module', 'types']) {
    const value = packageJson?.[key];
    if (typeof value === 'string' && value.trim()) {
      targets.push(value.trim());
    }
  }
  collectTargetStrings(packageJson?.exports ?? {}, targets);
  return [...new Set(targets.map((target) => String(target).trim()).filter(Boolean))];
}

function resolveTargetInStagedBuild({ packageDir, tempDistDir, target }) {
  const normalized = String(target ?? '').replace(/^\.\//, '');
  if (normalized === 'dist') {
    return tempDistDir;
  }
  if (normalized.startsWith('dist/')) {
    return join(tempDistDir, normalized.slice('dist/'.length));
  }
  return resolve(packageDir, normalized);
}

function verifyStagedExportTargets({ packageDir, tempDistDir, packageJson }) {
  const missing = collectExpectedPackageTargets(packageJson)
    .filter((target) => target.startsWith('./') || target.startsWith('dist/'))
    .map((target) => ({
      target,
      path: resolveTargetInStagedBuild({ packageDir, tempDistDir, target }),
    }))
    .filter(({ path }) => !existsSync(path));

  if (missing.length === 0) {
    return;
  }

  throw new Error(
    `Staged cli-common build is missing declared package export files:\n` +
      missing.map(({ target }) => `- ${target}`).join('\n'),
  );
}

function workspacePackageLockSlug(packageDir, packageJson) {
  const raw = String(packageJson?.name ?? '').trim() || resolve(packageDir);
  const slug = raw.replace(/^@/, '').replace(/[^a-zA-Z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'cli-common';
}

export function resolveCliCommonDistBuildLockPath(packageDir) {
  const resolvedPackageDir = resolve(packageDir);
  const repoRoot = resolve(resolvedPackageDir, '..', '..');
  const packageJson = readJson(join(resolvedPackageDir, 'package.json'));
  return join(repoRoot, '.project', 'tmp', 'workspace-dist-builds', `${workspacePackageLockSlug(resolvedPackageDir, packageJson)}.lock`);
}

function parseLockOwner(lockPath) {
  try {
    const raw = readFileSync(lockPath, 'utf8').trim();
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function isPidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function shouldReclaimLock(lockPath, staleAfterMs, nowMs) {
  const owner = parseLockOwner(lockPath);
  if (!owner) return true;
  if (owner.pid && !isPidAlive(owner.pid)) return true;
  const updatedAtMs = Number(owner.updatedAtMs ?? owner.createdAtMs ?? 0);
  return Boolean(updatedAtMs && nowMs - updatedAtMs > staleAfterMs);
}

function serializeLockOwner(nowMs) {
  return JSON.stringify({ pid: process.pid, createdAtMs: nowMs, updatedAtMs: nowMs });
}

export async function withWorkspaceDistBuildLock(fn, options) {
  const lockPath = options?.lockPath;
  if (!lockPath) throw new Error('withWorkspaceDistBuildLock requires lockPath');

  const env = options?.env ?? process.env;
  if (String(env.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD ?? '').trim() === lockPath) {
    return await fn({ waited: false });
  }

  mkdirSync(dirname(lockPath), { recursive: true });

  const timeoutMs = options?.timeoutMs ?? 240_000;
  const pollIntervalMs = options?.pollIntervalMs ?? 250;
  const staleAfterMs = options?.staleAfterMs ?? timeoutMs;
  const startedAt = Date.now();
  let fd = null;
  let heartbeat = null;
  let waited = false;

  while (true) {
    try {
      fd = openSync(lockPath, 'wx');
      writeFileSync(fd, serializeLockOwner(Date.now()), 'utf8');
      closeSync(fd);
      break;
    } catch (error) {
      if (fd !== null) {
        try {
          closeSync(fd);
        } catch {
          // best-effort cleanup
        }
        fd = null;
      }
      if (error?.code !== 'EEXIST') throw error;
      if (shouldReclaimLock(lockPath, staleAfterMs, Date.now())) {
        rmSync(lockPath, { force: true });
        continue;
      }
      if (Date.now() - startedAt > timeoutMs) {
        throw new Error(`Timed out waiting for workspace dist build lock: ${lockPath}`);
      }
      waited = true;
      await delay(pollIntervalMs);
    }
  }

  try {
    heartbeat = setInterval(() => {
      try {
        writeFileSync(lockPath, serializeLockOwner(Date.now()), 'utf8');
      } catch {
        // best-effort heartbeat
      }
    }, Math.max(500, Math.min(5_000, Math.floor(staleAfterMs / 4))));
    return await fn({ waited });
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    if (fd !== null) {
      try {
        unlinkSync(lockPath);
      } catch {
        // best-effort cleanup
      }
    }
  }
}

function runChecked(command, args, options, runCommandImpl) {
  const result = runCommandImpl(command, args, options);
  if (result?.error) {
    throw result.error;
  }
  if ((result?.status ?? 0) !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with code ${result?.status ?? 'unknown'}`);
  }
}

export function resolveCliCommonBuildTscInvocations({
  env = process.env,
  platform = process.platform,
  tscArgs,
} = {}) {
  const args = Array.isArray(tscArgs) ? tscArgs : [];
  const npmExecPath = typeof env?.npm_execpath === 'string' ? env.npm_execpath.trim() : '';
  return [
    resolveYarnCommandInvocation(args, {
      npmExecPath,
      platform,
      processExecPath: process.execPath,
      comspec: env?.COMSPEC ?? env?.ComSpec ?? env?.comspec,
    }),
  ];
}

function runFirstAvailableChecked(candidates, options, runCommandImpl) {
  let lastError = null;
  for (const candidate of candidates) {
    try {
      runChecked(candidate.command, candidate.args, {
        ...options,
        ...(candidate.windowsVerbatimArguments
          ? { windowsVerbatimArguments: candidate.windowsVerbatimArguments }
          : {}),
      }, runCommandImpl);
      return;
    } catch (error) {
      lastError = error;
      if (!error?.code || candidate === candidates.at(-1)) {
        throw error;
      }
    }
  }
  throw lastError ?? new Error('No package-manager command candidates were available');
}

async function replaceDistWithStagedBuild({ distDir, tempDistDir, backupDir }) {
  let hadExisting = false;
  await rm(backupDir, { recursive: true, force: true });
  try {
    await rename(distDir, backupDir);
    hadExisting = true;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  try {
    await rename(tempDistDir, distDir);
  } catch (error) {
    if (hadExisting) {
      await rename(backupDir, distDir).catch((restoreError) => {
        error.restoreError = restoreError;
      });
    }
    throw error;
  }

  if (hadExisting) {
    await rm(backupDir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function buildCliCommonDist(options = {}) {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const packageDir = resolve(options.packageDir ?? dirname(scriptsDir));
  const packageJson = readJson(join(packageDir, 'package.json'));
  const buildId = sanitizeBuildId(options.buildId);
  const distDir = join(packageDir, 'dist');
  const tempDistDir = join(packageDir, `.dist.build.${buildId}`);
  const backupDir = join(packageDir, `.dist.backup.${buildId}`);
  const tempTsconfigPath = join(packageDir, `.tsconfig.build.${buildId}.json`);
  const lockPath = options.lockPath ?? resolveCliCommonDistBuildLockPath(packageDir);
  const runCommandImpl = options.runCommandImpl ?? spawnSync;
  const commandEnv = {
    ...process.env,
    ...(options.env ?? {}),
  };

  return await withWorkspaceDistBuildLock(async () => {
    await rm(tempDistDir, { recursive: true, force: true });
    await rm(backupDir, { recursive: true, force: true });
    await mkdir(tempDistDir, { recursive: true });

    const tempTsconfig = {
      extends: './tsconfig.json',
      compilerOptions: {
        outDir: tempDistDir,
        tsBuildInfoFile: join(tempDistDir, '.tsbuildinfo'),
      },
    };

    await writeFile(tempTsconfigPath, `${JSON.stringify(tempTsconfig, null, 2)}\n`, 'utf8');

    try {
      runFirstAvailableChecked(
        resolveCliCommonBuildTscInvocations({
          env: commandEnv,
          platform: options.platform ?? process.platform,
          tscArgs: ['-s', 'tsc', '-p', tempTsconfigPath],
        }),
        {
          cwd: packageDir,
          stdio: options.stdio ?? 'inherit',
          env: {
            ...commandEnv,
            HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD: lockPath,
          },
        },
        runCommandImpl,
      );

      verifyStagedExportTargets({ packageDir, tempDistDir, packageJson });
      await replaceDistWithStagedBuild({ distDir, tempDistDir, backupDir });
      verifyPackageExportTargets({ packageDir, packageJson });
    } finally {
      await rm(tempDistDir, { recursive: true, force: true }).catch(() => {});
      await rm(backupDir, { recursive: true, force: true }).catch(() => {});
      await rm(tempTsconfigPath, { force: true }).catch(() => {});
    }

    const indexPath = join(distDir, 'index.js');
    const marker = await readFile(indexPath, 'utf8').catch(() => '');
    if (!marker.trim()) {
      throw new Error(`cli-common build produced an empty dist entrypoint: ${relative(packageDir, indexPath)}`);
    }
  }, { lockPath, env: commandEnv });
}

export async function main() {
  await buildCliCommonDist();
}

const isEntrypoint = (() => {
  const arg = typeof process.argv?.[1] === 'string' ? process.argv[1] : '';
  if (!arg) return false;
  return arg.endsWith('/scripts/build.mjs') || arg.endsWith('\\scripts\\build.mjs');
})();

if (isEntrypoint) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
