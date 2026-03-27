import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path, { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { resolveCliPackageRoot, syncPackageDist } from './syncPackageDist.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const MAX_CAPTURED_OUTPUT_CHARS = 4000;

function resolveNpmInvocation(npmExecpath = process.env.npm_execpath) {
  const npmExecpathValue = String(npmExecpath ?? '').trim();
  if (npmExecpathValue) {
    // Yarn classic sets `npm_execpath` to its own CLI entrypoint. That breaks `npm pack --json`
    // parsing and can cause the CLI smoke lane to fail by "packing" with yarn instead of npm.
    // Only respect `npm_execpath` when it points at npm's canonical JS entrypoint.
    if (path.basename(npmExecpathValue).toLowerCase() !== 'npm-cli.js') {
      return {
        command: 'npm',
        args: [],
      };
    }
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
    // `npm pack --json` can still emit prepack script output to stdout. When that happens,
    // the overall output is no longer valid JSON even though it still contains the filename.
    // Prefer extracting the last `"filename": "<...>.tgz"` occurrence.
    const filenameMatches = Array.from(raw.matchAll(/"filename"\s*:\s*"([^"]+?\.tgz)"/g));
    const lastFilename = filenameMatches.at(-1)?.[1];
    if (lastFilename) return String(lastFilename).trim();

    // Fall back to scanning lines for a .tgz token (supports both npm and yarn variants).
    const lines = raw.split('\n').map((line) => line.trim()).filter(Boolean);
    const tgzLine = lines.slice().reverse().find((line) => line.includes('.tgz'));
    if (tgzLine) {
      const parts = tgzLine.split(/\s+/).filter(Boolean);
      const tgzToken = parts.slice().reverse().find((part) => part.endsWith('.tgz') || part.includes('.tgz'));
      if (tgzToken) return tgzToken.replaceAll('"', '').replaceAll("'", '').trim();
    }

    return lines.at(-1) ?? '';
  }
}

function truncate(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  if (raw.length <= MAX_CAPTURED_OUTPUT_CHARS) return raw;
  return `${raw.slice(0, MAX_CAPTURED_OUTPUT_CHARS)}\n…(truncated ${raw.length - MAX_CAPTURED_OUTPUT_CHARS} chars)`;
}

function formatSpawnFailure({ packageRoot, npmInvocation, packArgs, result }) {
  const stdout = truncate(result?.stdout);
  const stderr = truncate(result?.stderr);
  const status = typeof result?.status === 'number' ? result.status : 'null';
  const signal = result?.signal ?? 'null';
  const errorMessage = result?.error ? String(result.error?.message ?? result.error) : '';
  const invocationPrintable = [npmInvocation.command, ...packArgs]
    .map((arg) => (String(arg).includes(' ') ? JSON.stringify(String(arg)) : String(arg)))
    .join(' ');

  return [
    `[pack-tarball] npm pack failed`,
    `cwd: ${packageRoot}`,
    `invocation: ${invocationPrintable}`,
    `status: ${status}`,
    `signal: ${signal}`,
    ...(errorMessage ? [`error: ${errorMessage}`] : []),
    ...(stdout ? [`stdout:\n${stdout}`] : []),
    ...(stderr ? [`stderr:\n${stderr}`] : []),
  ].join('\n');
}

function resolveNpmCacheDir({ destDir, env }) {
  const configured = String(env?.npm_config_cache ?? '').trim();
  if (configured) return configured;
  if (destDir) return path.join(destDir, '.npm-cache');
  return path.join(os.tmpdir(), `happier-npm-cache-${process.pid}`);
}

export function packTarball(options = {}) {
  const packageRoot = resolve(String(options.packageRoot ?? resolveCliPackageRoot()));
  const spawn = options.spawnSync ?? spawnSync;
  const npmInvocation = options.npmInvocation ?? resolveNpmInvocation(options.npmExecpath);
  const destDirRaw = String(options.destDir ?? '').trim();
  const destDir = destDirRaw ? resolve(destDirRaw) : packageRoot;

  syncPackageDist({
    packageRoot,
    distDir: options.distDir,
    packageDistDir: options.packageDistDir,
    existsSync: options.existsSync,
    cpSync: options.cpSync,
    rmSync: options.rmSync,
  });

  const env = { ...process.env, ...(options.env ?? {}) };
  const npmCacheDir = String(options.npmCacheDir ?? '').trim() || resolveNpmCacheDir({ destDir, env });
  if (!String(env.npm_config_cache ?? '').trim()) {
    env.npm_config_cache = npmCacheDir;
  }

  fs.mkdirSync(destDir, { recursive: true });
  fs.mkdirSync(String(env.npm_config_cache), { recursive: true });

  const packArgs = [...npmInvocation.args, 'pack', '--json', '--pack-destination', destDir];
  const result = spawn(npmInvocation.command, packArgs, {
    cwd: packageRoot,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (typeof result.status === 'number' && result.status !== 0) {
    throw new Error(formatSpawnFailure({ packageRoot, npmInvocation, packArgs, result }));
  }
  if (result.error) {
    throw new Error(formatSpawnFailure({ packageRoot, npmInvocation, packArgs, result }));
  }

  const tarballName = parseTarballName(result.stdout);
  if (!tarballName) {
    throw new Error('[pack-tarball] npm pack did not report a tarball filename');
  }

  const tarballPath = resolve(destDir, tarballName);
  if (!fs.existsSync(tarballPath)) {
    throw new Error(`[pack-tarball] missing tarball output: ${tarballPath}`);
  }

  return {
    packageRoot,
    tarballName,
    tarballPath,
  };
}

function parseCliOptions(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      'dest-dir': { type: 'string' },
      'npm-cache-dir': { type: 'string' },
    },
    allowPositionals: true,
    strict: false,
  });

  return {
    destDir: values['dest-dir'],
    npmCacheDir: values['npm-cache-dir'],
  };
}

const invokedAsMain = (() => {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  return resolve(argv1) === resolve(fileURLToPath(import.meta.url));
})();

if (invokedAsMain) {
  try {
    const { destDir, npmCacheDir } = parseCliOptions(process.argv.slice(2));
    const result = packTarball({ destDir, npmCacheDir });
    console.log(result.tarballPath);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
