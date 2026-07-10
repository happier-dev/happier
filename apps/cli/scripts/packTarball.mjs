import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path, { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { bundleWorkspaceDeps as runCanonicalBundleWorkspaceDeps } from './bundleWorkspaceDeps.mjs';
import { resolveCliPackageRoot, syncPackageDist } from './syncPackageDist.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const MAX_CAPTURED_OUTPUT_CHARS = 4000;
const DEFAULT_PACK_TARBALL_TIMEOUT_MS = 600_000;

function resolvePackTarballTimeoutMs(env, explicitTimeoutMs) {
  if (typeof explicitTimeoutMs === 'number' && Number.isFinite(explicitTimeoutMs)) {
    return Math.min(1_800_000, Math.max(30_000, Math.trunc(explicitTimeoutMs)));
  }
  const raw = String(env?.HAPPIER_CLI_PACK_TARBALL_TIMEOUT_MS ?? '').trim();
  if (!raw) return DEFAULT_PACK_TARBALL_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_PACK_TARBALL_TIMEOUT_MS;
  return Math.min(1_800_000, Math.max(30_000, parsed));
}

function resolveNpmInvocation(
  npmExecpath = process.env.npm_execpath,
  platform = process.platform,
  processExecPath = process.execPath,
  exists = fs.existsSync,
) {
  const npmCommand = platform === 'win32' ? 'npm.cmd' : 'npm';
  const nodeExecPath = String(processExecPath ?? '').trim();
  const useWin32Path = platform === 'win32' && /\\/.test(nodeExecPath);
  const platformPath = useWin32Path ? path.win32 : path;
  const npmCliFromNode =
    nodeExecPath
      ? platformPath.join(platformPath.dirname(nodeExecPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
      : '';
  const npmExecpathValue = String(npmExecpath ?? '').trim();
  if (npmExecpathValue) {
    // Yarn classic sets `npm_execpath` to its own CLI entrypoint. That breaks `npm pack --json`
    // parsing and can cause the CLI smoke lane to fail by "packing" with yarn instead of npm.
    // Only respect `npm_execpath` when it points at npm's canonical JS entrypoint.
    if (path.basename(npmExecpathValue).toLowerCase() !== 'npm-cli.js') {
      if (platform === 'win32' && npmCliFromNode && exists(npmCliFromNode)) {
        return {
          command: nodeExecPath,
          args: [npmCliFromNode],
        };
      }
      return {
        command: npmCommand,
        args: [],
      };
    }
    return {
      command: process.execPath,
      args: [npmExecpathValue],
    };
  }

  if (platform === 'win32' && npmCliFromNode && exists(npmCliFromNode)) {
    return {
      command: nodeExecPath,
      args: [npmCliFromNode],
    };
  }

  return {
    command: npmCommand,
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

function setFunctionOption(target, key, value) {
  if (typeof value === 'function') {
    target[key] = value;
  }
}

async function bundleWorkspaceDepsForPack({ packageRoot }) {
  const repoRoot = resolve(packageRoot, '..', '..');
  await runCanonicalBundleWorkspaceDeps({
    repoRoot,
    happyCliDir: packageRoot,
  });
}

export async function packTarball(options = {}) {
  const packageRoot = resolve(String(options.packageRoot ?? resolveCliPackageRoot()));
  const spawn = options.spawnSync ?? spawnSync;
  const exists = options.existsSync ?? fs.existsSync;
  const bundleWorkspaceDeps = options.bundleWorkspaceDeps ?? bundleWorkspaceDepsForPack;
  const npmInvocation = options.npmInvocation ??
    resolveNpmInvocation(options.npmExecpath, options.platform, options.processExecPath, exists);
  const destDirRaw = String(options.destDir ?? '').trim();
  const destDir = destDirRaw ? resolve(destDirRaw) : packageRoot;

  const syncPackageDistOptions = {
    packageRoot,
    distDir: options.distDir,
    packageDistDir: options.packageDistDir,
    existsSync: exists,
  };
  setFunctionOption(syncPackageDistOptions, 'cpSync', options.cpSync);
  setFunctionOption(syncPackageDistOptions, 'mkdirSync', options.mkdirSync);
  setFunctionOption(syncPackageDistOptions, 'renameSync', options.renameSync);
  setFunctionOption(syncPackageDistOptions, 'rmSync', options.rmSync);
  syncPackageDist(syncPackageDistOptions);
  await bundleWorkspaceDeps({ packageRoot });

  const env = { ...process.env, ...(options.env ?? {}) };
  const timeoutMs = resolvePackTarballTimeoutMs(env, options.timeoutMs);
  const npmCacheDir = String(options.npmCacheDir ?? '').trim() || resolveNpmCacheDir({ destDir, env });
  if (!String(env.npm_config_cache ?? '').trim()) {
    env.npm_config_cache = npmCacheDir;
  }

  fs.mkdirSync(destDir, { recursive: true });
  fs.mkdirSync(String(env.npm_config_cache), { recursive: true });

  const packArgs = [...npmInvocation.args, 'pack', '--json', '--ignore-scripts', '--pack-destination', destDir];
  const result = spawn(npmInvocation.command, packArgs, {
    cwd: packageRoot,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: timeoutMs,
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
  if (!exists(tarballPath)) {
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
    const result = await packTarball({ destDir, npmCacheDir });
    console.log(result.tarballPath);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
