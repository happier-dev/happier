// @ts-check

import { execFileSync } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

import { sanitizePackageArtifactEnv } from './sanitize-package-artifact-env.mjs';

export const PUBLIC_SDK_PUBLICATION_CONSUMER_TIMEOUT_MS = 10 * 60_000;

function requireAbsoluteTarballPath(value, label) {
  const tarballPath = String(value ?? '').trim();
  if (!tarballPath) throw new Error(`${label} tarball is required`);
  if (!isAbsolute(tarballPath)) throw new Error(`${label} tarball must be an absolute path`);
  return resolve(tarballPath);
}

export function buildPublicSdkPublicationTarballValidationPlan({
  repoRoot,
  pluginSdkTarball = null,
  pluginUiTarball = null,
  sdkTarball = null,
}) {
  if (Boolean(pluginSdkTarball) !== Boolean(pluginUiTarball)) {
    throw new Error('Plugin SDK publication validation requires both pair archives');
  }

  /** @type {Array<{ label: string; scriptPath: string; args: string[] }>} */
  const commands = [];
  if (pluginSdkTarball && pluginUiTarball) {
    const pluginSdkPath = requireAbsoluteTarballPath(pluginSdkTarball, 'Plugin SDK');
    const pluginUiPath = requireAbsoluteTarballPath(pluginUiTarball, 'Plugin UI');
    if (pluginSdkPath === pluginUiPath) {
      throw new Error('Plugin SDK and Plugin UI publication archives must be distinct');
    }
    commands.push({
      label: 'Plugin SDK NodeNext and Vite consumers',
      scriptPath: resolve(repoRoot, 'packages/tests/pluginSdkConsumers/run-probes.mjs'),
      args: [`--tarball=${pluginSdkPath}`],
    }, {
      label: 'Plugin UI external-author, NodeNext, Vite, Metro, and RNW consumers',
      scriptPath: resolve(repoRoot, 'packages/plugin-ui/scripts/validateExternalAuthoringFixture.mjs'),
      args: [
        '--sdk-tarball', pluginSdkPath,
        '--plugin-ui-tarball', pluginUiPath,
      ],
    });
  }
  if (sdkTarball) {
    const sdkPath = requireAbsoluteTarballPath(sdkTarball, 'SDK');
    commands.push({
      label: 'SDK NodeNext consumer',
      scriptPath: resolve(repoRoot, 'packages/sdk/scripts/validateNodeNextConsumer.mjs'),
      args: ['--tarball', sdkPath],
    });
  }
  if (commands.length === 0) {
    throw new Error('At least one public SDK publication archive is required');
  }
  return Object.freeze(commands.map((command) => Object.freeze({
    ...command,
    args: Object.freeze([...command.args]),
  })));
}

async function assertExactRegularTarball(tarballPath, label) {
  const stats = await lstat(tarballPath).catch((error) => {
    if (error?.code === 'ENOENT') {
      throw new Error(`${label} publication archive does not exist: ${tarballPath}`);
    }
    throw error;
  });
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`${label} publication archive must be an exact regular file: ${tarballPath}`);
  }
}

/**
 * Validates the already-exported npm archives at the publication preparation
 * choke point. This is artifact consumer validation, not feature QA: ordinary
 * source development never creates or freezes another release representation.
 */
export async function validatePublicSdkPublicationTarballs({
  repoRoot,
  pluginSdkTarball = null,
  pluginUiTarball = null,
  sdkTarball = null,
  env = process.env,
  execFileSyncImpl = execFileSync,
}) {
  const exactPluginSdkTarball = pluginSdkTarball
    ? requireAbsoluteTarballPath(pluginSdkTarball, 'Plugin SDK')
    : null;
  const exactPluginUiTarball = pluginUiTarball
    ? requireAbsoluteTarballPath(pluginUiTarball, 'Plugin UI')
    : null;
  const exactSdkTarball = sdkTarball
    ? requireAbsoluteTarballPath(sdkTarball, 'SDK')
    : null;
  const commands = buildPublicSdkPublicationTarballValidationPlan({
    repoRoot,
    pluginSdkTarball: exactPluginSdkTarball,
    pluginUiTarball: exactPluginUiTarball,
    sdkTarball: exactSdkTarball,
  });
  await Promise.all([
    ...(exactPluginSdkTarball
      ? [assertExactRegularTarball(exactPluginSdkTarball, 'Plugin SDK')]
      : []),
    ...(exactPluginUiTarball
      ? [assertExactRegularTarball(exactPluginUiTarball, 'Plugin UI')]
      : []),
    ...(exactSdkTarball ? [assertExactRegularTarball(exactSdkTarball, 'SDK')] : []),
  ]);

  const artifactEnv = sanitizePackageArtifactEnv(env);
  for (const command of commands) {
    process.stdout.write(`[pipeline] validate exported public package: ${command.label}\n`);
    execFileSyncImpl(process.execPath, [command.scriptPath, ...command.args], {
      cwd: repoRoot,
      env: artifactEnv,
      stdio: 'inherit',
      timeout: PUBLIC_SDK_PUBLICATION_CONSUMER_TIMEOUT_MS,
    });
  }
}
