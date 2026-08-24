// @ts-check

import { execFileSync } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { sanitizePackageArtifactEnv } from './sanitize-package-artifact-env.mjs';
import {
  runSdkDualOriginValidation,
  SDK_DUAL_ORIGIN_VALIDATION_TIMEOUT_MS,
} from '../release-validation/executors/sdk-dual-origin.mjs';

export const PUBLIC_SDK_TARBALL_CONSUMER_TIMEOUT_MS = 10 * 60_000;

function requireAbsoluteTarballPath(value, name) {
  const tarballPath = String(value ?? '').trim();
  if (!tarballPath) throw new Error(`${name} is required`);
  if (!isAbsolute(tarballPath)) throw new Error(`${name} must be an absolute tarball path`);
  return resolve(tarballPath);
}

export function parsePublicSdkTarballValidationArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      'plugin-sdk-tarball': { type: 'string', default: '' },
      'plugin-ui-tarball': { type: 'string', default: '' },
      'sdk-tarball': { type: 'string', default: '' },
    },
    allowPositionals: false,
  });
  const pluginSdkInput = String(values['plugin-sdk-tarball'] ?? '').trim();
  const pluginUiInput = String(values['plugin-ui-tarball'] ?? '').trim();
  const sdkInput = String(values['sdk-tarball'] ?? '').trim();
  if (Boolean(pluginSdkInput) !== Boolean(pluginUiInput)) {
    throw new Error('--plugin-sdk-tarball and --plugin-ui-tarball must be supplied together');
  }
  if (!pluginSdkInput && !sdkInput) {
    throw new Error('At least one public SDK tarball target is required');
  }
  const pluginSdkTarball = pluginSdkInput
    ? requireAbsoluteTarballPath(pluginSdkInput, '--plugin-sdk-tarball')
    : null;
  const pluginUiTarball = pluginUiInput
    ? requireAbsoluteTarballPath(pluginUiInput, '--plugin-ui-tarball')
    : null;
  const sdkTarball = sdkInput
    ? requireAbsoluteTarballPath(sdkInput, '--sdk-tarball')
    : null;
  if (pluginSdkTarball && pluginUiTarball && pluginSdkTarball === pluginUiTarball) {
    throw new Error('--plugin-sdk-tarball and --plugin-ui-tarball must be distinct exact archives');
  }
  return Object.freeze({ pluginSdkTarball, pluginUiTarball, sdkTarball });
}

export function buildPublicSdkTarballValidationPlan({
  repoRoot,
  pluginSdkTarball = null,
  pluginUiTarball = null,
  sdkTarball = null,
}) {
  /** @type {Array<{ label: string; scriptPath: string; args: string[] }>} */
  const commands = [];
  if (pluginSdkTarball || pluginUiTarball) {
    if (!pluginSdkTarball || !pluginUiTarball) {
      throw new Error('Plugin SDK exact-tarball validation requires both pair archives');
    }
    commands.push({
      label: 'Plugin SDK NodeNext and Vite consumers',
      scriptPath: resolve(repoRoot, 'packages/tests/pluginSdkConsumers/run-probes.mjs'),
      args: [`--tarball=${pluginSdkTarball}`],
    });
    commands.push({
      label: 'Plugin UI external-author, targeted, and Metro/RNW consumers',
      scriptPath: resolve(repoRoot, 'packages/plugin-ui/scripts/validateExternalAuthoringFixture.mjs'),
      args: [
        '--sdk-tarball', pluginSdkTarball,
        '--plugin-ui-tarball', pluginUiTarball,
      ],
    });
  }
  if (sdkTarball) {
    commands.push({
      label: 'SDK NodeNext consumer',
      scriptPath: resolve(repoRoot, 'packages/sdk/scripts/validateNodeNextConsumer.mjs'),
      args: ['--tarball', sdkTarball],
    });
  }
  return Object.freeze(commands.map((command) => Object.freeze({
    ...command,
    scriptPath: resolve(command.scriptPath),
    args: Object.freeze([...command.args]),
  })));
}

/**
 * The parent phase owns one ceiling derived from the exact child command plan.
 * @param {{ repoRoot: string; pluginSdkTarball?: string | null; pluginUiTarball?: string | null; sdkTarball?: string | null }} options
 */
export function resolvePublicSdkTarballValidationTimeoutMs(options) {
  const commands = buildPublicSdkTarballValidationPlan(options);
  return (commands.length * PUBLIC_SDK_TARBALL_CONSUMER_TIMEOUT_MS)
    + (options.sdkTarball ? SDK_DUAL_ORIGIN_VALIDATION_TIMEOUT_MS : 0);
}

async function assertExactTarball(tarballPath, label) {
  const stats = await lstat(tarballPath).catch((error) => {
    if (error?.code === 'ENOENT') {
      throw new Error(`${label} tarball does not exist: ${tarballPath}`);
    }
    throw error;
  });
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`${label} tarball must be an exact regular file: ${tarballPath}`);
  }
}

function runValidationCommand({ repoRoot, env, command, execFileSyncImpl }) {
  process.stdout.write(`[pipeline] validate public package artifact: ${command.label}\n`);
  execFileSyncImpl(process.execPath, [command.scriptPath, ...command.args], {
    cwd: repoRoot,
    env,
    stdio: 'inherit',
    timeout: PUBLIC_SDK_TARBALL_CONSUMER_TIMEOUT_MS,
  });
}

export async function validatePublicSdkTarballs({
  repoRoot,
  pluginSdkTarball = null,
  pluginUiTarball = null,
  sdkTarball = null,
  env = process.env,
  execFileSyncImpl = execFileSync,
}) {
  const commands = buildPublicSdkTarballValidationPlan({
    repoRoot,
    pluginSdkTarball,
    pluginUiTarball,
    sdkTarball,
  });
  await Promise.all([
    ...(pluginSdkTarball ? [assertExactTarball(pluginSdkTarball, 'Plugin SDK')] : []),
    ...(pluginUiTarball ? [assertExactTarball(pluginUiTarball, 'Plugin UI')] : []),
    ...(sdkTarball ? [assertExactTarball(sdkTarball, 'SDK')] : []),
  ]);
  const artifactEnv = sanitizePackageArtifactEnv(env);
  for (const command of commands) {
    runValidationCommand({
      repoRoot,
      env: artifactEnv,
      command,
      execFileSyncImpl,
    });
  }
  if (sdkTarball) {
    process.stdout.write(`[pipeline] validate public package artifact: SDK dual-origin exact candidate (${sdkTarball})\n`);
    runSdkDualOriginValidation({
      repoRoot,
      source: { kind: 'local-pack', ref: sdkTarball },
      env: artifactEnv,
      exec: execFileSyncImpl,
    });
  }
}

export async function main(argv = process.argv.slice(2)) {
  const args = parsePublicSdkTarballValidationArgs(argv);
  await validatePublicSdkTarballs({
    repoRoot: resolve(fileURLToPath(new URL('../../..', import.meta.url))),
    ...args,
  });
}

const invokedAsMain = process.argv[1]
  ? resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (invokedAsMain) {
  await main();
}
