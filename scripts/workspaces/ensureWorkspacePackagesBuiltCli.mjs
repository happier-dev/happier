#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { ensureWorkspacePackagesBuiltByName } from './ensureWorkspacePackagesBuilt.mjs';

const defaultRepoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));

export async function runWorkspacePackageBuild({
  repoRoot = defaultRepoRoot,
  packageNames = [],
  ensureWorkspacePackagesBuiltByNameImpl = ensureWorkspacePackagesBuiltByName,
} = {}) {
  const normalizedPackageNames = [...new Set(
    packageNames.map((name) => String(name ?? '').trim()).filter(Boolean),
  )];
  if (normalizedPackageNames.length === 0) {
    throw new Error('Workspace package build requires at least one workspace package name.');
  }
  return await ensureWorkspacePackagesBuiltByNameImpl(repoRoot, normalizedPackageNames, {
    publicationMode: 'live',
  });
}

export async function main(argv = process.argv.slice(2)) {
  const result = await runWorkspacePackageBuild({ packageNames: argv });
  const built = result.built.length > 0 ? result.built.join(', ') : 'none (already current)';
  process.stdout.write(`[workspace-build] built: ${built}\n`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
