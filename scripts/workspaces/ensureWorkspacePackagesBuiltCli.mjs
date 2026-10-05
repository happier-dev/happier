#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  ensureWorkspacePackagesBuiltByName,
  ensureWorkspacePackagesBuiltForComponent,
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

  const results = [];
  if (normalizedPackageNames.length > 0) {
    results.push(await ensureWorkspacePackagesBuiltByNameImpl(repoRoot, normalizedPackageNames, {
      publicationMode: 'live',
    }));
  }
  for (const componentDir of normalizedComponentDirs) {
    results.push(await ensureWorkspacePackagesBuiltForComponentImpl(
      resolve(repoRoot, componentDir),
      { publicationMode: 'live' },
    ));
  }
  const result = {
    ok: results.every((result) => result.ok !== false),
    built: [...new Set(results.flatMap((result) => result.built ?? []))],
    skipped: [...new Set(results.flatMap((result) => result.skipped ?? []))],
  };
  const refreshed = [...new Set(results.flatMap((result) => result.refreshed ?? []))];
  if (refreshed.length > 0) result.refreshed = refreshed;
  if (result.ok) {
    const published = await publishBundledPluginArtifactsAfterWorkspaceBuildImpl({
      repoRoot,
      workspaceNames: [...new Set([...result.built, ...refreshed])],
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
        workspaceNames: [...new Set([...result.built, ...refreshed])],
        env,
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
  const result = await runWorkspacePackageBuild(parseWorkspaceBuildArgs(argv));
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
