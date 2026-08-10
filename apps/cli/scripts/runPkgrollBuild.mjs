import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const require = createRequire(import.meta.url);
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

function normalizePkgrollOutputDir(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return 'dist';
  if (raw.startsWith('-')) return 'dist';
  const normalized = raw.replace(/\\/g, '/').replace(/^\.\/+/, '');
  const segments = normalized.split('/').filter(Boolean);
  if (!segments.length) return 'dist';
  if (segments.includes('.') || segments.includes('..')) return 'dist';
  if (normalized.startsWith('/')) return 'dist';
  return segments.join('/');
}

function resolveRequiredPkgrollOutputDir(value) {
  const raw = String(value ?? '').trim();
  const slashNormalized = raw.replace(/\\/g, '/').replace(/^\.\/+/, '');
  const segments = slashNormalized.split('/').filter(Boolean);
  if (
    !raw
    || raw.startsWith('-')
    || slashNormalized.startsWith('/')
    || /^[A-Za-z]:\//.test(slashNormalized)
    || segments.length === 0
    || segments.includes('.')
    || segments.includes('..')
    || segments.some((segment) => segment.includes(':'))
  ) {
    throw new Error('runPkgrollBuild requires an explicit relative builder-owned output directory');
  }
  return segments.join('/');
}

function rewritePackageDistPath(value, outputDir = 'dist') {
  if (typeof value !== 'string') return value;
  const outputRoot = `./${normalizePkgrollOutputDir(outputDir)}`;
  if (value === './package-dist') return outputRoot;
  if (value.startsWith('./package-dist/')) {
    return `${outputRoot}/${value.slice('./package-dist/'.length)}`;
  }
  return value;
}

function rebasePackageEntrypointOutputPath(value, outputDir = 'dist') {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/\\/g, '/').replace(/^\.\/+/, '');
  const outputRoot = normalizePkgrollOutputDir(outputDir);
  for (const sourceRoot of ['dist', 'package-dist']) {
    if (normalized === sourceRoot) {
      return outputRoot;
    }
    const prefix = `${sourceRoot}/`;
    if (normalized.startsWith(prefix)) {
      return `${outputRoot}/${normalized.slice(prefix.length)}`;
    }
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
    for (const item of value) {
      collectEntrypointOutputPaths(item, outputDir, out);
    }
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const entryValue of Object.values(value)) {
    collectEntrypointOutputPaths(entryValue, outputDir, out);
  }
}

export function collectPkgrollInputPaths(manifest, options = {}) {
  const outputDir = normalizePkgrollOutputDir(options.outputDir);
  const paths = new Set();
  for (const key of ['main', 'module', 'types', 'exports', 'imports']) {
    if (Object.prototype.hasOwnProperty.call(manifest, key)) {
      collectEntrypointOutputPaths(manifest[key], outputDir, paths);
    }
  }
  return [...paths].sort();
}

export function preparePkgrollPackageManifest(value, options = {}) {
  const outputDir = normalizePkgrollOutputDir(options.outputDir);
  if (Array.isArray(value)) {
    return value.map((item) => preparePkgrollPackageManifest(item, { outputDir }));
  }
  if (!value || typeof value !== 'object') {
    return rewritePackageDistPath(value, outputDir);
  }

  const out = {};
  for (const [key, entryValue] of Object.entries(value)) {
    // Pkgroll warns for bin entries outside its output, but does not use them as inputs.
    if (key === 'bin') continue;
    if (key === 'files') {
      out[key] = entryValue;
      continue;
    }
    out[key] = preparePkgrollPackageManifest(entryValue, { outputDir });
  }
  return out;
}

function prepareRuntimeGenerationManifest(manifest, outputDir) {
  const prepared = preparePkgrollPackageManifest(manifest, { outputDir });
  const bundled = new Set(
    (Array.isArray(manifest?.bundledDependencies) ? manifest.bundledDependencies : [])
      .map((name) => String(name))
      .filter((name) => name.startsWith('@happier-dev/')),
  );
  if (bundled.size === 0) return prepared;

  const dependencies = { ...(prepared.dependencies ?? {}) };
  const devDependencies = { ...(prepared.devDependencies ?? {}) };
  for (const packageName of bundled) {
    if (!Object.prototype.hasOwnProperty.call(dependencies, packageName)) continue;
    devDependencies[packageName] = dependencies[packageName];
    delete dependencies[packageName];
  }
  return {
    ...prepared,
    dependencies,
    devDependencies,
  };
}

function rebaseManifestOutputPathToStage(value, outputDir) {
  if (typeof value !== 'string') return value;
  const normalized = value.replace(/\\/g, '/').replace(/^\.\/+/, '');
  for (const outputRoot of [outputDir, 'dist', 'package-dist']) {
    if (normalized === outputRoot) return '.';
    const prefix = `${outputRoot}/`;
    if (normalized.startsWith(prefix)) {
      return `./${normalized.slice(prefix.length)}`;
    }
  }
  return value;
}

function prepareStageOwnedManifest(value, outputDir) {
  if (Array.isArray(value)) {
    return value.map((item) => prepareStageOwnedManifest(item, outputDir));
  }
  if (!value || typeof value !== 'object') {
    return rebaseManifestOutputPathToStage(value, outputDir);
  }

  const out = {};
  for (const [key, entryValue] of Object.entries(value)) {
    if (key === 'files') {
      out[key] = entryValue;
      continue;
    }
    out[key] = prepareStageOwnedManifest(entryValue, outputDir);
  }
  return out;
}

function toSlashNormalizedRelativePath(from, to) {
  const value = relative(from, to).replace(/\\/g, '/');
  return value || '.';
}

function rebasePkgrollInputPathToStage(inputPath, outputDir) {
  const normalized = String(inputPath).replace(/\\/g, '/').replace(/^\.\/+/, '');
  const prefix = `${outputDir}/`;
  if (!normalized.startsWith(prefix)) {
    throw new Error(`Pkgroll input is outside the builder-owned output directory: ${inputPath}`);
  }
  return normalized.slice(prefix.length);
}

export function resolvePkgrollCliPath() {
  return require.resolve('pkgroll/dist/cli.mjs');
}

function runPkgrollBuildStage(options = {}) {
  const packageJsonPath = resolve(String(options.packageJsonPath ?? 'package.json'));
  const packageRoot = dirname(packageJsonPath);
  const spawn = options.spawn ?? spawnSync;
  const nodeExecutable = options.nodeExecutable ?? process.execPath;
  const env = options.env ?? process.env;
  const timeoutMs = resolvePkgrollTimeoutMs(env, options.timeoutMs);
  const outputDir = resolveRequiredPkgrollOutputDir(
    options.outputDir ?? env?.HAPPIER_CLI_BUILD_OUTPUT_DIR,
  );
  const stagingDir = resolve(packageRoot, outputDir);
  const sourceDir = resolve(packageRoot, 'src');
  const manifest = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  const buildManifest = prepareRuntimeGenerationManifest(manifest, outputDir);
  const stageManifest = prepareStageOwnedManifest(buildManifest, outputDir);
  const stageManifestRaw = `${JSON.stringify(stageManifest, null, 2)}\n`;
  const stageManifestPath = join(stagingDir, 'package.json');
  const pkgrollCliPath = options.pkgrollCliPath ?? resolvePkgrollCliPath();
  const inputPaths = collectPkgrollInputPaths(manifest, { outputDir })
    .map((inputPath) => rebasePkgrollInputPathToStage(inputPath, outputDir));
  if (inputPaths.length === 0) {
    throw new Error('No package entrypoints found for pkgroll build');
  }

  mkdirSync(stagingDir, { recursive: true });
  const physicalStagingDir = realpathSync.native(stagingDir);
  const srcdist = `${toSlashNormalizedRelativePath(physicalStagingDir, sourceDir)}:.`;
  const pkgrollArgs = [pkgrollCliPath, '--packagejson=false', '--srcdist', srcdist];
  for (const inputPath of inputPaths) {
    pkgrollArgs.push('--input', inputPath);
  }

  let result;
  let manifestWritten = false;
  try {
    writeFileSync(stageManifestPath, stageManifestRaw, { encoding: 'utf8', flag: 'wx' });
    manifestWritten = true;
    result = spawn(nodeExecutable, pkgrollArgs, {
      cwd: physicalStagingDir,
      env,
      stdio: ['ignore', 'inherit', 'inherit'],
      timeout: timeoutMs,
    });
  } finally {
    if (manifestWritten) {
      rmSync(stageManifestPath, { force: true });
    }
  }
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

export function runPkgrollBuild(options = {}) {
  const packageJsonPath = realpathSync.native(
    resolve(String(options.packageJsonPath ?? 'package.json')),
  );
  return runPkgrollBuildStage({ ...options, packageJsonPath });
}
