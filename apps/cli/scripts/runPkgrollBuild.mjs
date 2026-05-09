import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const DEFAULT_PKGROLL_PACKAGE_JSON_FILTER = 'dist/**';
const DEFAULT_PKGROLL_TIMEOUT_MS = 600_000;

function resolvePkgrollTimeoutMs(env, explicitTimeoutMs) {
  if (typeof explicitTimeoutMs === 'number' && Number.isFinite(explicitTimeoutMs)) {
    return Math.min(1_800_000, Math.max(60_000, Math.trunc(explicitTimeoutMs)));
  }
  const raw = String(env?.HAPPIER_CLI_PKGROLL_TIMEOUT_MS ?? '').trim();
  if (!raw) return DEFAULT_PKGROLL_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_PKGROLL_TIMEOUT_MS;
  return Math.min(1_800_000, Math.max(60_000, parsed));
}

export function resolvePkgrollCliPath() {
  return require.resolve('pkgroll/dist/cli.mjs');
}

function readPkgrollCliKind(pkgrollCliPath, read = readFileSync) {
  const source = read(pkgrollCliPath, 'utf8');
  const prefix = source.slice(0, 64);
  if (/^#!\/bin\/sh\b/.test(prefix) || /^@echo off\b/i.test(prefix)) {
    return 'shell-wrapper';
  }
  return 'node-module';
}

export function runPkgrollBuild(options = {}) {
  const spawn = options.spawn ?? spawnSync;
  const nodeExecutable = options.nodeExecutable ?? process.execPath;
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const timeoutMs = resolvePkgrollTimeoutMs(env, options.timeoutMs);
  const packageJsonFilter = options.packageJsonFilter ?? DEFAULT_PKGROLL_PACKAGE_JSON_FILTER;
  const read = options.readFileSync ?? readFileSync;
  const pkgrollCliPath = options.pkgrollCliPath ?? resolvePkgrollCliPath();

  if (readPkgrollCliKind(pkgrollCliPath, read) !== 'node-module') {
    throw new Error(
      `Local pkgroll install is invalid at ${pkgrollCliPath}: expected a JavaScript entrypoint but found a shell wrapper. Reinstall dependencies before building apps/cli.`,
    );
  }
  const result = spawn(nodeExecutable, [pkgrollCliPath, '--packagejson', packageJsonFilter], {
    cwd,
    stdio: ['ignore', 'inherit', 'inherit'],
    timeout: timeoutMs,
  });
  if (typeof result.status === 'number' && result.status !== 0) {
    throw new Error(`pkgroll exited with status ${result.status}`);
  }
  if (result.error) {
    const errorCode = typeof result.error?.code === 'string' ? result.error.code : '';
    if (errorCode === 'ETIMEDOUT') {
      throw new Error(`pkgroll timed out after ${timeoutMs}ms`);
    }
    throw result.error;
  }
}

const isEntrypoint = (() => {
  const arg = typeof process.argv?.[1] === 'string' ? process.argv[1] : '';
  return arg.endsWith('/runPkgrollBuild.mjs') || arg.endsWith('\\runPkgrollBuild.mjs');
})();

if (isEntrypoint) {
  runPkgrollBuild();
}
