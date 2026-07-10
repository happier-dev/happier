import { createRequire } from 'node:module';
import { cpSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, isAbsolute, join, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const DEFAULT_BUILD_OUTPUT_DIR = 'dist';
const DEFAULT_PKGROLL_TIMEOUT_MS = 600_000;
const FIRST_PARTY_STATIC_ASSETS_SOURCE_RELATIVE_PATH = 'src/plugins/projection/registry/static-assets';
const FIRST_PARTY_STATIC_ASSETS_DIST_RELATIVE_PATH = 'dist/plugins/projection/registry/static-assets';

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

function rebasePackageEntrypointOutputPath(value, outputDir = DEFAULT_BUILD_OUTPUT_DIR) {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/\\/g, '/').replace(/^\.\/+/, '');
  for (const sourceRoot of ['dist', 'package-dist']) {
    if (normalized === sourceRoot) return outputDir;
    const prefix = `${sourceRoot}/`;
    if (normalized.startsWith(prefix)) return `${outputDir}/${normalized.slice(prefix.length)}`;
  }
  return null;
}

function collectEntrypointOutputPaths(value, outputDir, out) {
  const outputPath = rebasePackageEntrypointOutputPath(value, outputDir);
  if (outputPath) {
    out.add(outputPath);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectEntrypointOutputPaths(item, outputDir, out);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const entryValue of Object.values(value)) {
    collectEntrypointOutputPaths(entryValue, outputDir, out);
  }
}

export function collectPkgrollInputPaths(manifest, options = {}) {
  const outputDir = resolveBuildOutputDir({}, options.outputDir);
  const paths = new Set();
  for (const key of ['main', 'module', 'types', 'exports', 'imports']) {
    if (Object.prototype.hasOwnProperty.call(manifest, key)) {
      collectEntrypointOutputPaths(manifest[key], outputDir, paths);
    }
  }
  return [...paths].sort();
}

export function resolveBuildOutputDir(env = process.env, explicitOutputDir) {
  const candidate = String(explicitOutputDir ?? env?.HAPPIER_CLI_BUILD_OUTPUT_DIR ?? '').trim();
  if (!candidate || candidate.startsWith('-')) return DEFAULT_BUILD_OUTPUT_DIR;
  if (isAbsolute(candidate)) return DEFAULT_BUILD_OUTPUT_DIR;
  const segments = candidate.split(/[\\/]+/g).filter(Boolean);
  if (segments.length === 0) return DEFAULT_BUILD_OUTPUT_DIR;
  if (segments.includes('.') || segments.includes('..')) return DEFAULT_BUILD_OUTPUT_DIR;
  return segments.join('/');
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
  const packageJsonPath = resolve(String(options.packageJsonPath ?? join(cwd, 'package.json')));
  const packageRoot = dirname(packageJsonPath);
  const outputDir = resolveBuildOutputDir(env, options.outputDir);
  const read = options.readFileSync ?? readFileSync;
  const pkgrollCliPath = options.pkgrollCliPath ?? resolvePkgrollCliPath();
  const manifest = JSON.parse(read(packageJsonPath, 'utf8'));
  const inputPaths = collectPkgrollInputPaths(manifest, { outputDir });
  if (inputPaths.length === 0) {
    throw new Error('No package entrypoints found for pkgroll build');
  }

  if (readPkgrollCliKind(pkgrollCliPath, read) !== 'node-module') {
    throw new Error(
      `Local pkgroll install is invalid at ${pkgrollCliPath}: expected a JavaScript entrypoint but found a shell wrapper. Reinstall dependencies before building apps/cli.`,
    );
  }
  const pkgrollArgs = [pkgrollCliPath, '--packagejson=false', '--srcdist', `src:${outputDir}`];
  for (const inputPath of inputPaths) {
    pkgrollArgs.push('--input', inputPath);
  }

  const result = spawn(nodeExecutable, pkgrollArgs, {
    cwd: packageRoot,
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
  copyFirstPartyStaticAssets(packageRoot, outputDir);
}

function copyFirstPartyStaticAssets(cwd, outputDir) {
  const sourceDir = join(cwd, FIRST_PARTY_STATIC_ASSETS_SOURCE_RELATIVE_PATH);
  if (!existsSync(sourceDir)) return;

  const distDir = join(cwd, outputDir, FIRST_PARTY_STATIC_ASSETS_DIST_RELATIVE_PATH.slice('dist/'.length));
  rmSync(distDir, { recursive: true, force: true });
  cpSync(sourceDir, distDir, { recursive: true });
}

const isEntrypoint = (() => {
  const arg = typeof process.argv?.[1] === 'string' ? process.argv[1] : '';
  return arg.endsWith('/runPkgrollBuild.mjs') || arg.endsWith('\\runPkgrollBuild.mjs');
})();

if (isEntrypoint) {
  runPkgrollBuild();
}
