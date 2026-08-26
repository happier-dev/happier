#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  ensureWorkspacePackagesBuiltByName,
  ensureWorkspacePackagesBuiltForComponent,
} from './ensureWorkspacePackagesBuilt.mjs';

const defaultRepoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));

export async function runWorkspacePackageBuild({
  repoRoot = defaultRepoRoot,
  packageNames = [],
  componentDirs = [],
  ensureWorkspacePackagesBuiltByNameImpl = ensureWorkspacePackagesBuiltByName,
  ensureWorkspacePackagesBuiltForComponentImpl = ensureWorkspacePackagesBuiltForComponent,
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
  return {
    ok: results.every((result) => result.ok !== false),
    built: [...new Set(results.flatMap((result) => result.built ?? []))],
    skipped: [...new Set(results.flatMap((result) => result.skipped ?? []))],
  };
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
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
