import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stat } from 'node:fs/promises';
import { WORKSPACE_BUILD_MODE_ENV, resolveWorkspaceBuildMode } from '../../../scripts/workspaces/workspaceChildBuildEnv.mjs';

import {
  ensureWorkspacePackagesBuiltForComponent as ensureWorkspacePackagesBuiltForComponentDefault,
  inspectUsableSourceDevSharedDepsLastGreen,
  syncSharedDepsForSourceDev as syncSharedDepsForSourceDevDefault,
} from '../../stack/scripts/utils/proc/pm.mjs';
import { verifyUiPatchedDependencies } from '../tools/postinstall/verifyReactNativeEnrichedMarkdownWebStreamingPatch.mjs';
export { verifyUiPatchedDependencies } from '../tools/postinstall/verifyReactNativeEnrichedMarkdownWebStreamingPatch.mjs';
import {
  generateBundledPluginUiArtifacts as generateBundledPluginUiArtifactsDefault,
  resolveBundledPluginUiArtifactsOutputPath,
} from './generateBundledPluginUiArtifacts.mjs';

const uiDir = dirname(dirname(fileURLToPath(import.meta.url)));

async function publishBundledPluginProjectionWithFailures({ repoRoot, env, pluginFailures, publicationMode = 'live' }) {
  const { runCanonicalBundledPluginArtifactPublisher } = await import('../../cli/scripts/buildSharedDeps.mjs');
  await runCanonicalBundledPluginArtifactPublisher({
    repoRoot,
    env,
    mode: 'write',
    publicationMode,
    pluginFailures,
  });
}

export async function hasUsableUiWorkspaceLastGreen({
  uiPackageDir = uiDir,
} = {}) {
  const repoRoot = resolve(uiPackageDir, '../..');
  // Shared workspace readiness does not include this replica-owned byte graph.
  // A fresh target must materialize it before Metro adopts the workspace.
  try {
    if (!(await stat(resolveBundledPluginUiArtifactsOutputPath(repoRoot))).isFile()) return false;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
  const inspection = await inspectUsableSourceDevSharedDepsLastGreen(
    repoRoot,
    { workspaceNames: ['plugin-sdk'] },
  );
  return inspection?.usable === true;
}

function readRebuiltBundledPluginWorkspaceNames(result) {
  const out = [];
  const seen = new Set();
  for (const rawPackageName of Array.isArray(result?.built) ? result.built : []) {
    if (typeof rawPackageName !== 'string') continue;
    const workspaceName = rawPackageName.trim().replace(/^@happier-dev\//, '');
    if (!workspaceName.startsWith('plugins-') || seen.has(workspaceName)) continue;
    seen.add(workspaceName);
    out.push(workspaceName);
  }
  return out;
}

export async function ensureUiWorkspacePackagesBuilt({
  env = process.env,
  publicationMode = 'live',
  uiPackageDir = uiDir,
  ensureWorkspacePackagesBuiltForComponent = ensureWorkspacePackagesBuiltForComponentDefault,
  syncSharedDepsForSourceDev = syncSharedDepsForSourceDevDefault,
  generateBundledPluginUiArtifacts = generateBundledPluginUiArtifactsDefault,
  publishBundledPluginProjectionWithFailuresImpl = publishBundledPluginProjectionWithFailures,
  verifyPatchedDependencies = verifyUiPatchedDependencies,
} = {}) {
  const repoRoot = resolve(uiPackageDir, '../..');
  if (publicationMode !== 'live' && publicationMode !== 'artifact') {
    throw new Error(`Unknown UI workspace publication mode: ${publicationMode}`);
  }
  env = { ...env, [WORKSPACE_BUILD_MODE_ENV]: resolveWorkspaceBuildMode({
    env,
    buildMode: publicationMode === 'artifact' ? 'strict' : env[WORKSPACE_BUILD_MODE_ENV] ?? 'qa-runtime',
  }) };
  verifyPatchedDependencies({ uiPackageDir });
  const result = await ensureWorkspacePackagesBuiltForComponent(uiPackageDir, {
    quiet: false,
    env,
    publicationMode,
    isolatePluginFailures: publicationMode === 'live',
  });
  const skipped = Array.isArray(result?.skipped) ? result.skipped : [];
  if (skipped.includes('not-monorepo')) {
    throw new Error('[ui] ensure:workspace:built failed (not-monorepo): apps/ui must be run from inside the Happier monorepo checkout.');
  }
  const rebuiltPluginWorkspaceNames = readRebuiltBundledPluginWorkspaceNames(result);
  if (publicationMode === 'artifact' && result.pluginFailures?.length > 0) {
    throw new Error(`UI artifact publication failed for ${result.pluginFailures.map((failure) => failure.packageName).join(', ')}`);
  }
  if (rebuiltPluginWorkspaceNames.length > 0 || result.pluginFailures?.length > 0) {
    // Expo adoption happens after this preflight returns. Feed the canonical
    // publisher only E2's actual rebuilt plugin set so it validates and
    // publishes one matching registry/artifact pair before Expo can resolve
    // those new package bytes.
    if (publicationMode === 'artifact') {
      await publishBundledPluginProjectionWithFailuresImpl({ repoRoot, env, pluginFailures: [], publicationMode });
    } else await syncSharedDepsForSourceDev(repoRoot, {
      env,
      includeRuntimeDependencies: true,
      quiet: false,
      workspaceNames: rebuiltPluginWorkspaceNames,
      ...(result.pluginFailures?.length ? { pluginFailures: result.pluginFailures } : {}),
    });
  }
  const uiArtifacts = await generateBundledPluginUiArtifacts({
    repoRoot,
    mode: 'write',
    publicationMode,
    ...(result.pluginFailures?.length ? { pluginFailures: result.pluginFailures } : {}),
  });
  const inheritedFailures = result.pluginFailures ?? [];
  if (publicationMode === 'artifact' && (uiArtifacts?.pluginFailures?.length ?? 0) > 0) {
    throw new Error(`UI artifact publication failed for ${uiArtifacts.pluginFailures.map((failure) => failure.packageName).join(', ')}`);
  }
  const newlyFailedUiPlugins = (uiArtifacts?.pluginFailures ?? []).filter((failure) => (
    !inheritedFailures.some((inherited) => inherited.packageName === failure.packageName)
  ));
  if (newlyFailedUiPlugins.length > 0) {
    // The artifact reader runs after installed package publication. Reproject
    // every generated consumer, not only the manifest-only aggregate, before
    // the UI bundle can load static plugin imports.
    await publishBundledPluginProjectionWithFailuresImpl({
      repoRoot,
      env,
      pluginFailures: [...inheritedFailures, ...newlyFailedUiPlugins],
    });
  }
  return result;
}

async function run() {
  await ensureUiWorkspacePackagesBuilt({
    publicationMode: process.argv.includes('--artifact') ? 'artifact' : 'live',
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  run().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
