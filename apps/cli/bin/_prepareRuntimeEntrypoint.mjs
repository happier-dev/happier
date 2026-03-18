import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { resolveRuntimeEntrypoint } from './_resolveRuntimeEntrypoint.mjs';

const DEFAULT_PACKAGES = ['agents', 'cli-common', 'connection-supervisor', 'protocol', 'release-runtime'];
const DEFAULT_HOST_APPS = ['cli'];

function isDisabled(env) {
  const candidates = [env?.HAPPIER_SYNC_BUNDLED_WORKSPACES, env?.HAPPIER_CLI_SYNC_BUNDLED_WORKSPACES];

  for (const raw of candidates) {
    const value = String(raw ?? '').trim().toLowerCase();
    if (!value) continue;
    if (value === '0' || value === 'false' || value === 'no') return true;
  }

  return false;
}

function resolveBundledWorkspaceSyncModulePath(projectRoot) {
  const root = String(projectRoot ?? '').trim();
  if (!root) return null;

  const candidate = resolve(root, '..', '..', 'scripts', 'workspaces', 'syncBundledWorkspacePackages.mjs');
  return existsSync(candidate) ? candidate : null;
}

export async function maybeRefreshLocalBundledWorkspacePackages(projectRoot, opts = {}) {
  if (isDisabled(opts.env ?? process.env)) return;

  const syncModulePath = resolveBundledWorkspaceSyncModulePath(projectRoot);
  if (!syncModulePath) return;

  const repoRoot = resolve(projectRoot, '..', '..');
  const { syncBundledWorkspacePackages } = await import(pathToFileURL(syncModulePath).href);

  syncBundledWorkspacePackages({
    repoRoot,
    packages: Array.isArray(opts.packages) && opts.packages.length > 0 ? opts.packages : DEFAULT_PACKAGES,
    hostApps: Array.isArray(opts.hostApps) && opts.hostApps.length > 0 ? opts.hostApps : DEFAULT_HOST_APPS,
  });
}

export async function prepareRuntimeEntrypoint(projectRoot, relativePath, opts = {}) {
  await maybeRefreshLocalBundledWorkspacePackages(projectRoot, opts);
  return resolveRuntimeEntrypoint(projectRoot, relativePath);
}
