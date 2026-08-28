import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  commandExists,
  resolveBunCommand,
  resolveYarnCommand,
  SERVER_BINARY_DEFAULT_EXTERNALS,
} from '@happier-dev/cli-common/componentArtifacts';
import {
  resolveInternalWorkspacePackageNameClosure,
  resolveWorkspaceSourceDir,
} from '@happier-dev/cli-common/workspaces';

import { createRuntimeFingerprint } from '../runtime/shared/runtime_fingerprint.mjs';
import { runCapture } from '../utils/proc/proc.mjs';
import { readHappyCliRuntimeInputFreshness } from '../utils/proc/cli_runtime_inputs.mjs';
import { readDevReloadWatchChangeSignatureAsync } from '../utils/dev/watchSignature.mjs';

const RUNTIME_COMPONENTS = Object.freeze(['web', 'server', 'daemon']);

function normalizeFingerprint(value, label) {
  const fingerprint = String(value ?? '').trim();
  if (!fingerprint || fingerprint === '.' || fingerprint === '..' || /[\\/\u0000]/.test(fingerprint)) {
    throw new Error(`[build] ${label} must be a non-empty fingerprint.`);
  }
  return fingerprint;
}

function readInternalWorkspaceDependencyNames(packageJsonPath) {
  let packageJson = null;
  try {
    packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  } catch {
    return [];
  }
  return [...new Set([
    ...Object.keys(packageJson?.dependencies ?? {}),
    ...Object.keys(packageJson?.optionalDependencies ?? {}),
  ])]
    .filter((packageName) => packageName.startsWith('@happier-dev/'))
    .sort((left, right) => left.localeCompare(right));
}

function collectWorkspaceSourcePaths({ repoDir, hostDir }) {
  const dependencyNames = readInternalWorkspaceDependencyNames(join(hostDir, 'package.json'));
  const closure = resolveInternalWorkspacePackageNameClosure({
    repoRoot: repoDir,
    packageNames: dependencyNames,
  });
  return closure.flatMap((packageName) => {
    const packageDir = resolveWorkspaceSourceDir({ repoRoot: repoDir, packageName });
    return [
      join(packageDir, 'src'),
      join(packageDir, 'package.json'),
      join(packageDir, 'tsconfig.json'),
      join(packageDir, 'tsconfig.build.json'),
    ];
  }).filter((path) => existsSync(path));
}

async function readSourcePathFingerprint({ component, paths }) {
  const signature = await readDevReloadWatchChangeSignatureAsync(paths);
  if (!signature) {
    throw new Error(`[build] ${component} runtime artifact identity has no readable source inputs.`);
  }
  return createHash('sha256')
    .update(`happier:runtime-${component}-source:v1\0`)
    .update(signature)
    .digest('hex');
}

/**
 * This deliberately stays component-local. It reuses the existing package
 * closure and runtime-input readers rather than constructing a repository-wide
 * build graph or reusing whole-checkout git provenance as an invalidator.
 */
export async function readRuntimeComponentSourceFingerprint({
  component,
  sourceMetadata,
  readDaemonRuntimeInputFreshnessImpl = readHappyCliRuntimeInputFreshness,
  readSourcePathFingerprintImpl = readSourcePathFingerprint,
}) {
  const normalizedComponent = String(component ?? '').trim();
  if (!RUNTIME_COMPONENTS.includes(normalizedComponent)) {
    throw new Error(`[build] unknown runtime artifact component: ${normalizedComponent || '<empty>'}.`);
  }
  const repoDir = String(sourceMetadata?.repoDir ?? '').trim();
  if (!repoDir) throw new Error('[build] runtime artifact identity requires a repository directory.');

  if (normalizedComponent === 'daemon') {
    const freshness = await readDaemonRuntimeInputFreshnessImpl(join(repoDir, 'apps', 'cli'));
    return normalizeFingerprint(freshness?.fingerprint, 'daemon runtime source identity');
  }

  const hostDir = join(repoDir, 'apps', normalizedComponent === 'web' ? 'ui' : 'server');
  const ownPaths = normalizedComponent === 'web'
    ? [
        join(hostDir, 'sources'),
        join(hostDir, 'assets'),
        join(hostDir, 'app.config.js'),
        join(hostDir, 'babel.config.js'),
        join(hostDir, 'metro.config.js'),
        join(hostDir, 'package.json'),
        join(hostDir, 'tsconfig.json'),
        join(hostDir, 'patches'),
        join(repoDir, 'yarn.lock'),
      ]
    : [
        join(hostDir, 'sources'),
        join(hostDir, 'scripts'),
        join(hostDir, 'prisma'),
        join(hostDir, 'package.json'),
        join(hostDir, 'tsconfig.json'),
        join(hostDir, 'tsconfig.build.json'),
        join(repoDir, 'yarn.lock'),
      ];
  const paths = [...new Set([
    ...ownPaths.filter((path) => existsSync(path)),
    ...collectWorkspaceSourcePaths({ repoDir, hostDir }),
  ])].sort((left, right) => left.localeCompare(right));
  return await readSourcePathFingerprintImpl({ component: normalizedComponent, paths });
}

export async function collectRuntimeComponentSourceFingerprints({
  selection,
  sourceMetadata,
  readRuntimeComponentSourceFingerprintImpl = readRuntimeComponentSourceFingerprint,
}) {
  const fingerprints = {};
  for (const component of RUNTIME_COMPONENTS) {
    if (!selection?.components?.[component]) continue;
    fingerprints[component] = await readRuntimeComponentSourceFingerprintImpl({
      component,
      sourceMetadata,
    });
  }
  return fingerprints;
}

export function assertSelectedBuildPrerequisites({
  selection,
  commandProbe = commandExists,
  env = process.env,
}) {
  const needsServerBinary = Boolean(selection?.components?.server);
  const needsDaemonBinary = Boolean(selection?.components?.daemon);
  if (needsServerBinary || needsDaemonBinary) {
    if (!resolveBunCommand({ commandProbe, processEnv: env })) {
      const targetLabel = needsServerBinary && needsDaemonBinary
        ? 'server and daemon'
        : needsServerBinary
          ? 'server'
          : 'daemon';
      throw new Error(`[build] bun is required before starting ${targetLabel} binary artifact builds.`);
    }
  }
  if (needsDaemonBinary) {
    resolveYarnCommand({ commandProbe });
    if (!commandProbe('go')) {
      throw new Error('[build] Go is required before starting daemon support artifact builds.');
    }
  }
}

export async function collectRuntimeBuildToolchainInputs({
  selection,
  env = process.env,
  commandProbe = commandExists,
  resolveBunCommandImpl = resolveBunCommand,
  resolveYarnCommandImpl = resolveYarnCommand,
  runCaptureImpl = runCapture,
  nodeVersion = process.version,
}) {
  const nodeInput = `node=${String(nodeVersion ?? '').trim()}`;
  let bunInput = null;
  let yarnInput = null;
  if (selection?.components?.server || selection?.components?.daemon) {
    const bunCommand = resolveBunCommandImpl({ commandProbe, processEnv: env });
    if (!bunCommand) {
      throw new Error('[build] bun is required before collecting runtime build toolchain identity.');
    }
    const bunVersion = String(await runCaptureImpl(bunCommand, ['--version'], {
      env,
      timeoutMs: 10_000,
    })).trim();
    if (!bunVersion) throw new Error('[build] bun returned an empty version while collecting runtime build identity.');
    bunInput = `bun=${bunVersion}`;
  }
  if (selection?.components?.daemon) {
    const yarn = resolveYarnCommandImpl({ commandProbe });
    const yarnVersion = String(await runCaptureImpl(yarn.cmd, [...yarn.args, '--version'], {
      env,
      timeoutMs: 10_000,
    })).trim();
    if (!yarnVersion) throw new Error('[build] Yarn returned an empty version while collecting runtime build identity.');
    yarnInput = `yarn=${yarnVersion}`;
  }
  return {
    web: selection?.components?.web ? [nodeInput] : [],
    server: selection?.components?.server ? [nodeInput, bunInput] : [],
    daemon: selection?.components?.daemon ? [nodeInput, bunInput, yarnInput] : [],
  };
}

export function createRuntimeArtifactFingerprint({
  component,
  sourceMetadata,
  componentSourceFingerprint,
  toolchainInputs = [],
  supportArtifactFingerprint = '',
  env = process.env,
  platform = process.platform,
  arch = process.arch,
}) {
  const normalizedComponent = String(component ?? '').trim();
  if (!RUNTIME_COMPONENTS.includes(normalizedComponent)) {
    throw new Error(`[build] unknown runtime artifact component: ${normalizedComponent || '<empty>'}.`);
  }
  const buildInputs = [
    'runtimeArtifactRecipe=v2',
    `source=${normalizeFingerprint(componentSourceFingerprint, `${normalizedComponent} runtime source identity`)}`,
    ...toolchainInputs.filter(Boolean),
  ];
  if (normalizedComponent === 'server') {
    const defaultServerExternals = SERVER_BINARY_DEFAULT_EXTERNALS.join(',');
    buildInputs.push(
      `serverComponent=${String(sourceMetadata?.serverComponent ?? '').trim()}`,
      `dbProvider=${String(sourceMetadata?.dbProvider ?? '').trim()}`,
      `bunExternals=${String(env.HAPPIER_SERVER_BUN_EXTERNALS ?? defaultServerExternals).trim() || defaultServerExternals}`,
      `platform=${platform}`,
      `arch=${arch}`,
      `support=${normalizeFingerprint(supportArtifactFingerprint, 'server runtime support identity')}`,
    );
  }
  if (normalizedComponent === 'daemon') {
    buildInputs.push(
      `bunExternals=${String(env.HAPPIER_CLI_BUN_EXTERNALS ?? '').trim()}`,
      `platform=${platform}`,
      `arch=${arch}`,
      `support=${normalizeFingerprint(supportArtifactFingerprint, 'daemon runtime support identity')}`,
    );
  }
  return createRuntimeFingerprint({
    components: [normalizedComponent],
    buildInputs,
  });
}
