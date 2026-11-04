#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  ensureWorkspacePackagesBuiltByName,
  ensureWorkspacePackagesBuiltForComponent,
  syncWorkspaceComponentBundledDependencies,
} from './ensureWorkspacePackagesBuilt.mjs';

const defaultRepoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));

async function publishBundledPluginArtifactsAfterWorkspaceBuildDefault(options) {
  const { publishBundledPluginArtifactsAfterWorkspaceBuild } = await import(
    '../../apps/cli/scripts/buildSharedDeps.mjs'
  );
  return await publishBundledPluginArtifactsAfterWorkspaceBuild(options);
}

async function rebuildWorkspacesInvalidatedByBundledPluginPublicationDefault(options) {
  const { rebuildWorkspacesInvalidatedByBundledPluginPublication } = await import(
    '../../apps/cli/scripts/buildSharedDeps.mjs'
  );
  return await rebuildWorkspacesInvalidatedByBundledPluginPublication(options);
}

export async function runWorkspacePackageBuild({
  repoRoot = defaultRepoRoot,
  env = process.env,
  packageNames = [],
  componentDirs = [],
  ensureWorkspacePackagesBuiltByNameImpl = ensureWorkspacePackagesBuiltByName,
  ensureWorkspacePackagesBuiltForComponentImpl = ensureWorkspacePackagesBuiltForComponent,
  publishBundledPluginArtifactsAfterWorkspaceBuildImpl = publishBundledPluginArtifactsAfterWorkspaceBuildDefault,
  rebuildWorkspacesInvalidatedByBundledPluginPublicationImpl = rebuildWorkspacesInvalidatedByBundledPluginPublicationDefault,
  onPackageBuildResult,
  prepareConfiguredTargets = false,
  runDevTargetCommandImpl,
} = {}) {
  const normalizedPackageNames = [...new Set(
    packageNames.map((name) => String(name ?? '').trim()).filter(Boolean),
  )];
  const normalizedComponentDirs = [...new Set(
    componentDirs.map((dir) => String(dir ?? '').trim()).filter(Boolean),
  )];
  if (normalizedPackageNames.length === 0 && normalizedComponentDirs.length === 0) {
    throw new Error('Workspace package build requires at least one workspace package name or component.');
  }
  if (prepareConfiguredTargets) {
    const { prepareWorkspacePackageBuildTargets } = await import('./prepareWorkspacePackageBuildTargets.mjs');
    const targets = await prepareWorkspacePackageBuildTargets({ repoRoot, env,
      packageNames: normalizedPackageNames, componentDirs: normalizedComponentDirs, runDevTargetCommandImpl });
    if (targets) return targets;
  }

  const results = [];
  const preparedPackageNames = new Set();
  const reportPackageResult = async (result) => {
    preparedPackageNames.add(result.packageName);
    await onPackageBuildResult?.(result);
  };
  const preparedComponents = [];
  if (normalizedPackageNames.length > 0) {
    results.push(await ensureWorkspacePackagesBuiltByNameImpl(repoRoot, normalizedPackageNames, {
      publicationMode: 'live',
      env,
      onPackageBuildResult: reportPackageResult,
    }));
  }
  for (const componentDir of normalizedComponentDirs) {
    const resolvedComponentDir = resolve(repoRoot, componentDir);
    const prepared = await ensureWorkspacePackagesBuiltForComponentImpl(
      resolvedComponentDir,
      { publicationMode: 'live', env, onPackageBuildResult: reportPackageResult, deferBundledWorkspaceSync: true },
    );
    results.push(prepared);
    preparedComponents.push({ componentDir: resolvedComponentDir, pluginFailures: prepared.pluginFailures });
  }
  const result = {
    ok: results.every((result) => result.ok !== false),
    built: [...new Set(results.flatMap((result) => result.built ?? []))],
    skipped: [...new Set(results.flatMap((result) => result.skipped ?? []))],
  };
  const refreshed = [...new Set(results.flatMap((result) => result.refreshed ?? []))];
  if (refreshed.length > 0) result.refreshed = refreshed;
  if (result.ok) {
    const workspaceNames = [...new Set([...preparedPackageNames, ...result.built, ...refreshed])];
    const published = await publishBundledPluginArtifactsAfterWorkspaceBuildImpl({
      repoRoot,
      // Successful admission includes current dist trees whose separately-owned
      // plugin artifacts are absent. Compilation alone is not publication readiness.
      workspaceNames,
      pluginFailures: results.flatMap((prepared) => prepared.pluginFailures ?? []),
      env,
      // This adapter owns preparation of the current checkout. A remote replica
      // must publish projections for its target-local ignored dist bytes instead
      // of checking the primary checkout's projection.
      bundledPluginArtifactPublication: {
        mode: 'write',
        ...(String(env?.HAPPIER_DEV_TARGET_EXECUTION ?? '').trim() === '1'
          ? { targetOwnedOnly: true }
          : {}),
      },
    });
    if (published) {
      // Publication can update generated CLI/UI source after their compiler
      // pass. Reuse the canonical invalidation owner before reporting success.
      await rebuildWorkspacesInvalidatedByBundledPluginPublicationImpl({
        repoRoot,
        workspaceNames,
        env,
      });
    }
    // Generated-source repair and plugin publication must settle before strict
    // copies can consume the package's complete declared runtime inventory.
    for (const prepared of preparedComponents) {
      await syncWorkspaceComponentBundledDependencies(prepared.componentDir, {
        env, publicationMode: 'live', pluginFailures: prepared.pluginFailures,
      });
    }
  }
  return result;
}

export function parseWorkspaceBuildArgs(argv) {
  const packageNames = [];
  const componentDirs = [];
  for (const argument of argv) {
    if (argument.startsWith('--for-component=')) {
      const componentDir = argument.slice('--for-component='.length).trim();
      if (!componentDir) throw new Error('--for-component requires a repository-relative path.');
      componentDirs.push(componentDir);
    } else if (argument.startsWith('-')) {
      throw new Error(`Unknown workspace build option: ${argument}`);
    } else {
      packageNames.push(argument);
    }
  }
  return { packageNames, componentDirs };
}

export async function main(argv = process.argv.slice(2)) {
  const workerRequest = argv.length === 1 && argv[0].startsWith('--worker-request=')
    ? JSON.parse(argv[0].slice('--worker-request='.length)) : null;
  const result = await runWorkspacePackageBuild({
    ...(workerRequest ?? parseWorkspaceBuildArgs(argv)),
    ...(workerRequest ? { repoRoot: resolve(process.cwd()) } : {}),
    prepareConfiguredTargets: !workerRequest,
    onPackageBuildResult({ packageName, reason, elapsedMs, queueWaitMs }) {
      process.stdout.write(`[workspace-build] ${packageName}: ${reason}; work=${elapsedMs.toFixed(1)}ms queue=${queueWaitMs.toFixed(1)}ms\n`);
    },
  });
  if (result.preparedTargets) {
    process.stdout.write(`[workspace-build] prepared targets: ${result.preparedTargets.join(', ')}\n`);
    return;
  }
  const built = result.built.length > 0 ? result.built.join(', ') : 'none (already current)';
  process.stdout.write(`[workspace-build] built: ${built}\n`);
  if (result.refreshed?.length > 0) process.stdout.write(`[workspace-build] refreshed: ${result.refreshed.join(', ')}\n`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
