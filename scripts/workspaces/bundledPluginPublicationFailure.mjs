import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { assertHostCanExcludeBundledPlugin, BUNDLED_PLUGIN_PUBLICATION_FAILURES_RELATIVE_PATH, parseBundledPluginPublicationFailures } from '../../packages/cli-common/bundledPluginPublicationPolicy.mjs';
import { BuildInputDriftError, WorkspacePackageBuildError } from './buildInputConvergence.mjs';

export { assertHostCanExcludeBundledPlugin } from '../../packages/cli-common/bundledPluginPublicationPolicy.mjs';

const MAX_DIAGNOSTIC_BYTES = 2_048;

export function resolveBundledPluginPublicationFailuresPath(repoRoot) {
  return resolve(repoRoot, 'apps', 'cli', BUNDLED_PLUGIN_PUBLICATION_FAILURES_RELATIVE_PATH);
}

export function readBundledPluginPublicationFailures(repoRoot) {
  let raw;
  try {
    raw = readFileSync(resolveBundledPluginPublicationFailuresPath(repoRoot), 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  return parseBundledPluginPublicationFailures(raw);
}

export function resolveBundledPluginPublicationFailures(repoRoot, failures, evaluatedPackageNames) {
  const evaluated = evaluatedPackageNames === undefined ? null : new Set(evaluatedPackageNames);
  const byPackage = new Map((evaluated === null ? [] : readBundledPluginPublicationFailures(repoRoot)
    .filter((failure) => !evaluated.has(failure.packageName)))
    .map((failure) => [failure.packageName, failure]));
  for (const failure of failures) byPackage.set(failure.packageName, failure);
  return [...byPackage.values()].sort((a, b) => a.packageName.localeCompare(b.packageName));
}

export function writeBundledPluginPublicationFailures(repoRoot, failures, evaluatedPackageNames) {
  const path = resolveBundledPluginPublicationFailuresPath(repoRoot);
  const sorted = resolveBundledPluginPublicationFailures(repoRoot, failures, evaluatedPackageNames);
  const output = `${JSON.stringify(sorted)}\n`;
  try {
    if (readFileSync(path, 'utf8') === output) return;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp.${process.pid}.${randomUUID()}`;
  writeFileSync(temporaryPath, output, 'utf8');
  renameSync(temporaryPath, path);
}

function boundedMessage(value) {
  const source = String(value ?? '').trim() || 'Bundled plugin publication failed';
  let result = '';
  let bytes = 0;
  for (const character of source) {
    const nextBytes = Buffer.byteLength(character, 'utf8');
    if (bytes + nextBytes > MAX_DIAGNOSTIC_BYTES) break;
    result += character;
    bytes += nextBytes;
  }
  return result;
}

function readPluginId(repoRoot, packageName) {
  const packageId = packageName.replace(/^@happier-dev\/plugins-/, '');
  try {
    const manifest = JSON.parse(readFileSync(resolve(
      repoRoot, 'packages', 'plugins', packageId, '.happier-plugin', 'plugin.json',
    ), 'utf8'));
    if (typeof manifest?.id === 'string' && manifest.id.trim()) return manifest.id.trim();
  } catch {
    // A failed manifest producer can leave no serialized manifest. The package
    // identity still needs a stable catalog row for its build diagnostic.
  }
  return `happier.${packageId}`;
}

export function createBundledPluginPublicationFailure({
  repoRoot,
  packageName,
  pluginId = readPluginId(repoRoot, packageName),
  code = 'plugin_package_build_failed',
  error,
}) {
  // Moving inputs are a phase failure, not optional-plugin unavailability.
  if (error instanceof BuildInputDriftError) throw error;
  try {
    assertHostCanExcludeBundledPlugin(repoRoot, packageName, error);
  } catch (requiredPluginError) {
    // Keep the host policy's diagnostic while preserving the command's
    // terminal classification for the enclosing generator request.
    if (error instanceof WorkspacePackageBuildError) throw new WorkspacePackageBuildError(requiredPluginError);
    throw requiredPluginError;
  }
  return Object.freeze({
    packageName,
    pluginId,
    diagnostic: Object.freeze({
      code,
      message: boundedMessage(error instanceof Error ? error.message : error),
    }),
  });
}
