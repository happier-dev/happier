import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { run } from '../../stack/scripts/utils/proc/proc.mjs';
import { resolveWorkspaceBuildMode } from '../../../scripts/workspaces/workspaceChildBuildEnv.mjs';

import { PLUGIN_HOST_SHARED_RUNTIME_PACKAGES } from './pluginHostSharedRuntimePackages.mjs';
import {
  DEFAULT_CLI_PKGROLL_NODE_HEAP_LIMIT_MB,
  upsertMaxOldSpaceSize,
} from './withNodeHeapLimit.mjs';

const require = createRequire(import.meta.url);
const DEFAULT_BUILD_OUTPUT_DIR = 'dist';
const FIRST_PARTY_STATIC_ASSETS_SOURCE_RELATIVE_PATH = 'src/plugins/projection/registry/static-assets';
const FIRST_PARTY_STATIC_ASSETS_DIST_RELATIVE_PATH = 'dist/plugins/projection/registry/static-assets';

function resolvePkgrollTimeoutMs(env, explicitTimeoutMs) {
  const timeoutMs = typeof explicitTimeoutMs === 'number'
    ? explicitTimeoutMs
    : Number(String(env?.HAPPIER_CLI_PKGROLL_TIMEOUT_MS ?? '').trim());
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return undefined;
  // Node's subprocess timer converts an overflowing delay to 1ms. Reject an
  // unrepresentable operator budget rather than silently shortening it.
  if (timeoutMs > 2_147_483_647) {
    throw new RangeError('pkgroll timeout exceeds the Node timer maximum of 2147483647ms');
  }
  return timeoutMs;
}

function normalizePkgrollOutputDir(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return DEFAULT_BUILD_OUTPUT_DIR;
  const normalized = raw.replace(/\\/g, '/').replace(/^\.\/+/, '');
  const segments = normalized.split('/').filter(Boolean);
  if (
    raw.startsWith('-')
    || normalized.startsWith('/')
    || /^[A-Za-z]:\//.test(normalized)
    || segments.length === 0
    || segments.includes('.')
    || segments.includes('..')
    || segments.some((segment) => segment.includes(':'))
  ) {
    return DEFAULT_BUILD_OUTPUT_DIR;
  }
  return segments.join('/');
}

function resolveRequiredPkgrollOutputDir(value) {
  const raw = String(value ?? '').trim();
  const normalized = raw.replace(/\\/g, '/').replace(/^\.\/+/, '');
  const segments = normalized.split('/').filter(Boolean);
  if (
    !raw
    || raw.startsWith('-')
    || normalized.startsWith('/')
    || /^[A-Za-z]:\//.test(normalized)
    || segments.length === 0
    || segments.includes('.')
    || segments.includes('..')
    || segments.some((segment) => segment.includes(':'))
  ) {
    throw new Error('runPkgrollBuild requires an explicit relative builder-owned output directory');
  }
  return segments.join('/');
}

function rebasePackageEntrypointOutputPath(value, outputDir = DEFAULT_BUILD_OUTPUT_DIR) {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/\\/g, '/').replace(/^\.\/+/, '');
  const outputRoot = normalizePkgrollOutputDir(outputDir);
  for (const sourceRoot of ['dist', 'package-dist']) {
    if (normalized === sourceRoot) return outputRoot;
    const prefix = `${sourceRoot}/`;
    if (normalized.startsWith(prefix)) return `${outputRoot}/${normalized.slice(prefix.length)}`;
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
  const outputDir = normalizePkgrollOutputDir(options.outputDir);
  const paths = new Set();
  for (const key of ['main', 'module', 'types', 'exports', 'imports']) {
    if (Object.prototype.hasOwnProperty.call(manifest, key)) {
      collectEntrypointOutputPaths(manifest[key], outputDir, paths);
    }
  }
  return [...paths].sort();
}

function rewritePackageDistPath(value, outputDir) {
  if (typeof value !== 'string') return value;
  const outputRoot = `./${normalizePkgrollOutputDir(outputDir)}`;
  if (value === './package-dist') return outputRoot;
  if (value.startsWith('./package-dist/')) {
    return `${outputRoot}/${value.slice('./package-dist/'.length)}`;
  }
  return value;
}

function preparePkgrollPackageManifest(value, outputDir) {
  if (Array.isArray(value)) {
    return value.map((item) => preparePkgrollPackageManifest(item, outputDir));
  }
  if (!value || typeof value !== 'object') {
    return rewritePackageDistPath(value, outputDir);
  }

  const out = {};
  for (const [key, entryValue] of Object.entries(value)) {
    if (key === 'bin') continue;
    if (key === 'files') {
      out[key] = entryValue;
      continue;
    }
    out[key] = preparePkgrollPackageManifest(entryValue, outputDir);
  }
  return out;
}

function prepareRuntimeGenerationManifest(manifest, outputDir) {
  const prepared = preparePkgrollPackageManifest(manifest, outputDir);
  // Bundled internals are inlined into the host, except the packages plugins
  // also import at runtime: those stay external so host and plugins share one
  // module instance from the packaged closure. Inline password sodium through
  // its authored CommonJS seam too: externalizing its require as an ESM import
  // selects 0.7.16's export with an unshipped sibling. Other dependencies such
  // as Ink remain external ESM imports, preserving top-level await.
  const bundledRuntimePackages = new Set(
    (Array.isArray(manifest?.bundledDependencies) ? manifest.bundledDependencies : [])
      .map((name) => String(name))
      .filter((name) => name.startsWith('@happier-dev/') || name === 'libsodium-wrappers-sumo')
      .filter((name) => !PLUGIN_HOST_SHARED_RUNTIME_PACKAGES.includes(name)),
  );
  if (bundledRuntimePackages.size === 0) return prepared;

  const dependencies = { ...(prepared.dependencies ?? {}) };
  const devDependencies = { ...(prepared.devDependencies ?? {}) };
  for (const packageName of bundledRuntimePackages) {
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
    if (normalized.startsWith(prefix)) return `./${normalized.slice(prefix.length)}`;
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

function isDeclarationOutputPath(inputPath) {
  return /\.d\.(?:c|m)?ts$/i.test(inputPath);
}

function supplyEsmCommonJsDirname(outputDirectory, includeJs) {
  const prelude = [
    "import { dirname as __happierPkgrollPathDirname } from 'node:path';",
    "import { fileURLToPath as __happierPkgrollFileURLToPath } from 'node:url';",
    'const __happierPkgrollDirname = __happierPkgrollPathDirname(__happierPkgrollFileURLToPath(import.meta.url));',
    '',
  ].join('\n');
  for (const entry of readdirSync(outputDirectory, { withFileTypes: true })) {
    const outputPath = join(outputDirectory, entry.name);
    if (entry.isDirectory()) {
      supplyEsmCommonJsDirname(outputPath, includeJs);
      continue;
    }
    if (!entry.isFile() || !(entry.name.endsWith('.mjs') || (includeJs && entry.name.endsWith('.js')))) continue;
    const source = readFileSync(outputPath, 'utf8');
    if (!source.includes('__happierPkgrollDirname')) continue;
    const newline = source.indexOf('\n');
    const headerEnd = source.startsWith('#!') ? (newline < 0 ? source.length : newline + 1) : 0;
    const header = source.slice(0, headerEnd);
    if (source.slice(headerEnd).startsWith(prelude)) continue;
    // Pkgroll shares code across entries: supply the binding in the actual
    // generated chunks, not just the declared entry modules. Keep hashbangs
    // first and retain the documented Node 20.0 floor.
    writeFileSync(outputPath, header + (header && !header.endsWith('\n') ? '\n' : '') + prelude + source.slice(headerEnd));
  }
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

function copyFirstPartyStaticAssets(packageRoot, outputDir) {
  const sourceDir = join(packageRoot, FIRST_PARTY_STATIC_ASSETS_SOURCE_RELATIVE_PATH);
  if (!existsSync(sourceDir)) return;

  const distDir = join(
    packageRoot,
    outputDir,
    FIRST_PARTY_STATIC_ASSETS_DIST_RELATIVE_PATH.slice('dist/'.length),
  );
  rmSync(distDir, { recursive: true, force: true });
  cpSync(sourceDir, distDir, { recursive: true });
}

async function runPkgrollCommand(command, args, { timeout, ...options }) {
  try {
    await run(command, args, {
      ...options,
      ...(timeout !== undefined ? { timeoutMs: timeout } : {}),
      ownedProcessGroup: true,
    });
    return { status: 0 };
  } catch (error) {
    return { error };
  }
}

async function runPkgrollBuildInStage(options = {}) {
  const packageJsonPath = resolve(String(options.packageJsonPath));
  const packageRoot = dirname(packageJsonPath);
  const outputDir = resolveRequiredPkgrollOutputDir(options.outputDir);
  const stagingDir = resolve(packageRoot, outputDir);
  const sourceDir = resolve(packageRoot, 'src');
  const spawn = options.spawn ?? runPkgrollCommand;
  const nodeExecutable = options.nodeExecutable ?? process.execPath;
  const env = options.env ?? process.env;
  const timeoutMs = resolvePkgrollTimeoutMs(env, options.timeoutMs);
  const childEnv = {
    ...env,
    NODE_OPTIONS: upsertMaxOldSpaceSize(
      env.NODE_OPTIONS,
      DEFAULT_CLI_PKGROLL_NODE_HEAP_LIMIT_MB,
    ),
  };
  const read = options.readFileSync ?? readFileSync;
  const pkgrollCliPath = options.pkgrollCliPath ?? resolvePkgrollCliPath();
  const manifest = JSON.parse(read(packageJsonPath, 'utf8'));
  const buildManifest = prepareRuntimeGenerationManifest(manifest, outputDir);
  const stageManifest = prepareStageOwnedManifest(buildManifest, outputDir);
  const stageManifestRaw = `${JSON.stringify(stageManifest, null, 2)}\n`;
  const inputPaths = collectPkgrollInputPaths(manifest, { outputDir })
    .map((inputPath) => rebasePkgrollInputPathToStage(inputPath, outputDir));
  if (inputPaths.length === 0) {
    throw new Error('No package entrypoints found for pkgroll build');
  }
  if (readPkgrollCliKind(pkgrollCliPath, read) !== 'node-module') {
    throw new Error(
      `Local pkgroll install is invalid at ${pkgrollCliPath}: expected a JavaScript entrypoint but found a shell wrapper. Reinstall dependencies before building apps/cli.`,
    );
  }

  mkdirSync(stagingDir, { recursive: true });
  const physicalStagingDir = realpathSync.native(stagingDir);
  const stageManifestPath = join(physicalStagingDir, 'package.json');
  const srcdist = `${toSlashNormalizedRelativePath(physicalStagingDir, sourceDir)}:.`;
  const runtimeInputs = inputPaths.filter((inputPath) => !isDeclarationOutputPath(inputPath));
  const bundlesPasswordSodium = Object.prototype.hasOwnProperty.call(
    buildManifest.devDependencies ?? {}, 'libsodium-wrappers-sumo',
  );
  const esmInputs = bundlesPasswordSodium ? runtimeInputs.filter((inputPath) =>
    inputPath.endsWith('.mjs') || (inputPath.endsWith('.js') && buildManifest.type === 'module'),
  ) : [];
  const inputGroups = [
    ...(bundlesPasswordSodium
      ? [esmInputs, runtimeInputs.filter((inputPath) => !esmInputs.includes(inputPath))]
      : [runtimeInputs]),
    // Runtime consumers need executable bytes. Public package publication retains declarations.
    ...(resolveWorkspaceBuildMode({ env }) === 'strict'
      ? [inputPaths.filter(isDeclarationOutputPath)]
      : []),
  ].filter((group) => group.length > 0);

  let manifestWritten = false;
  try {
    writeFileSync(stageManifestPath, stageManifestRaw, { encoding: 'utf8', flag: 'wx' });
    manifestWritten = true;
    for (const inputGroup of inputGroups) {
      const pkgrollArgs = [pkgrollCliPath, '--packagejson=false', '--srcdist', srcdist];
      if (inputGroup === esmInputs) {
        // Inlined sodium uses CommonJS's module-local directory. Pkgroll
        // already shims require, but leaves this global unresolved in ESM.
        // Keep CJS's native directory semantics untouched.
        pkgrollArgs.push('--define.__dirname=__happierPkgrollDirname');
      }
      for (const inputPath of inputGroup) {
        pkgrollArgs.push('--input', inputPath);
      }
      const result = await spawn(nodeExecutable, pkgrollArgs, {
        cwd: physicalStagingDir,
        env: childEnv,
        stdio: ['ignore', 'inherit', 'inherit'],
        ...(timeoutMs !== undefined ? { timeout: timeoutMs } : {}),
      });
      if (result.error) {
        const errorCode = typeof result.error?.code === 'string' ? result.error.code : '';
        if (errorCode === 'ETIMEDOUT') {
          throw new Error(`pkgroll timed out after ${timeoutMs}ms`);
        }
        throw result.error;
      }
      if (result.signal) {
        const error = new Error(`pkgroll terminated by signal ${result.signal}`);
        error.signal = result.signal;
        throw error;
      }
      if (result.status !== 0) {
        throw new Error(`pkgroll exited without success (status=${result.status ?? 'null'})`);
      }
      if (inputGroup === esmInputs) {
        supplyEsmCommonJsDirname(physicalStagingDir, buildManifest.type === 'module');
      }
    }
  } finally {
    if (manifestWritten) rmSync(stageManifestPath, { force: true });
  }
  copyFirstPartyStaticAssets(packageRoot, outputDir);
}

export async function runPkgrollBuild(options = {}) {
  const lexicalPackageJsonPath = resolve(String(
    options.packageJsonPath
      ?? join(options.cwd ?? process.cwd(), 'package.json'),
  ));
  const packageJsonPath = realpathSync.native(lexicalPackageJsonPath);
  return runPkgrollBuildInStage({ ...options, packageJsonPath });
}
