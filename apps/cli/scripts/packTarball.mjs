import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveCliPackageRoot, syncPackageDist } from './syncPackageDist.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

function resolveNpmInvocation(npmExecpath = process.env.npm_execpath) {
  const npmExecpathValue = String(npmExecpath ?? '').trim();
  if (npmExecpathValue) {
    return {
      command: process.execPath,
      args: [npmExecpathValue],
    };
  }

  return {
    command: 'npm',
    args: [],
  };
}

function parseTarballName(stdout) {
  const raw = String(stdout ?? '').trim();
  if (!raw) return '';

  try {
    const parsed = JSON.parse(raw);
    const entry = Array.isArray(parsed) ? parsed.at(-1) : parsed;
    return String(entry?.filename ?? '').trim();
  } catch {
    return raw.split('\n').map((line) => line.trim()).filter(Boolean).at(-1) ?? '';
  }
}

export function packTarball(options = {}) {
  const packageRoot = resolve(String(options.packageRoot ?? resolveCliPackageRoot()));
  const spawn = options.spawnSync ?? spawnSync;
  const npmInvocation = options.npmInvocation ?? resolveNpmInvocation(options.npmExecpath);

  syncPackageDist({
    packageRoot,
    distDir: options.distDir,
    packageDistDir: options.packageDistDir,
    existsSync: options.existsSync,
    cpSync: options.cpSync,
    rmSync: options.rmSync,
  });

  const result = spawn(npmInvocation.command, [...npmInvocation.args, 'pack', '--json'], {
    cwd: packageRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (typeof result.status === 'number' && result.status !== 0) {
    throw new Error(`[pack-tarball] npm pack exited with status ${result.status}`);
  }
  if (result.error) {
    throw result.error;
  }

  const tarballName = parseTarballName(result.stdout);
  if (!tarballName) {
    throw new Error('[pack-tarball] npm pack did not report a tarball filename');
  }

  const tarballPath = resolve(packageRoot, tarballName);
  if (!existsSync(tarballPath)) {
    throw new Error(`[pack-tarball] missing tarball output: ${tarballPath}`);
  }

  return {
    packageRoot,
    tarballName,
    tarballPath,
  };
}

const invokedAsMain = (() => {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  return resolve(argv1) === resolve(fileURLToPath(import.meta.url));
})();

if (invokedAsMain) {
  try {
    const result = packTarball();
    console.log(result.tarballPath);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
