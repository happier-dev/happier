#!/usr/bin/env node
// @ts-check

import { appendFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

import { collectInternalWorkspaceDependencyNames } from '../../apps/stack/scripts/utils/proc/workspace_dependencies.mjs';

/**
 * Fail closed for changed paths that the source-CI lane filters do not own.
 * Documentation is the only intentionally lane-less category; any other
 * unmatched path selects the broad source suite so a new executable source
 * location cannot silently receive a successful CI attestation.
 *
 * @param {{ changedPaths: string[]; classifiedPaths: string[]; documentationPaths: string[] }} input
 */
export function findUnmatchedSourcePaths({ changedPaths, classifiedPaths, documentationPaths }) {
  const known = new Set([...classifiedPaths, ...documentationPaths]);
  return [...new Set(changedPaths)].filter((path) => !known.has(path)).sort();
}

/**
 * @typedef {{ directory: string; name: string; dependencies: string[] }} WorkspaceManifest
 */

/**
 * Resolve product impact from the actual workspace dependency graph instead of
 * duplicating package-to-consumer guesses in workflow YAML.
 *
 * @param {{ changedPaths: string[]; manifests: WorkspaceManifest[] }} input
 */
export function resolveWorkspaceSourceImpacts({ changedPaths, manifests }) {
  const normalizedManifests = manifests
    .map((manifest) => ({
      ...manifest,
      directory: manifest.directory.replaceAll('\\', '/').replace(/\/$/, ''),
    }))
    .sort((left, right) => right.directory.length - left.directory.length);
  const manifestByName = new Map(normalizedManifests.map((manifest) => [manifest.name, manifest]));
  const changedWorkspaceNames = new Set();
  const unknownWorkspacePaths = [];
  let sharedPackages = false;

  for (const rawPath of changedPaths) {
    const path = rawPath.replaceAll('\\', '/').replace(/^\.\//, '');
    const owner = normalizedManifests.find((manifest) => path === manifest.directory || path.startsWith(`${manifest.directory}/`));
    if (owner) {
      changedWorkspaceNames.add(owner.name);
      if (owner.directory.startsWith('packages/') || owner.directory === 'apps/bootstrap') sharedPackages = true;
      continue;
    }
    if (path.startsWith('packages/') || path.startsWith('apps/')) unknownWorkspacePaths.push(path);
  }

  /** @param {string} rootName */
  const productDependsOnChange = (rootName) => {
    const pending = [rootName];
    const visited = new Set();
    while (pending.length > 0) {
      const name = pending.pop();
      if (!name || visited.has(name)) continue;
      visited.add(name);
      if (changedWorkspaceNames.has(name)) return true;
      const manifest = manifestByName.get(name);
      if (!manifest) continue;
      for (const dependency of manifest.dependencies) {
        if (manifestByName.has(dependency)) pending.push(dependency);
      }
    }
    return false;
  };

  return {
    ui: productDependsOnChange('@happier-dev/app'),
    server: productDependsOnChange('@happier-dev/server'),
    cli: productDependsOnChange('@happier-dev/cli'),
    stack: productDependsOnChange('@happier-dev/stack'),
    sharedPackages,
    unknownWorkspacePaths: [...new Set(unknownWorkspacePaths)].sort(),
  };
}

/** @param {string} repoRoot */
async function loadWorkspaceManifests(repoRoot) {
  const rootPackage = JSON.parse(await readFile(resolve(repoRoot, 'package.json'), 'utf8'));
  const workspaceDirectories = Array.isArray(rootPackage.workspaces)
    ? rootPackage.workspaces
    : rootPackage.workspaces?.packages;
  if (!Array.isArray(workspaceDirectories) || workspaceDirectories.some((directory) => typeof directory !== 'string')) {
    throw new Error('package.json workspaces.packages must be an array of explicit workspace directories');
  }
  const workspaces = await Promise.all(workspaceDirectories.map(async (directory) => {
    const manifest = JSON.parse(await readFile(resolve(repoRoot, directory, 'package.json'), 'utf8'));
    if (typeof manifest.name !== 'string' || !manifest.name) throw new Error(`${directory}/package.json must define a workspace name`);
    return { directory, manifest };
  }));
  const workspacePackageNames = new Set(workspaces.map(({ manifest }) => manifest.name));
  return workspaces.map(({ directory, manifest }) => ({
    directory,
    name: manifest.name,
    dependencies: collectInternalWorkspaceDependencyNames(manifest, manifest.name, { workspacePackageNames }),
  }));
}

/** @param {string | undefined} raw @param {string} label */
function parsePathList(raw, label) {
  if (!raw) return [];
  const value = JSON.parse(raw);
  if (!Array.isArray(value) || value.some((path) => typeof path !== 'string')) {
    throw new Error(`${label} must be a JSON array of paths`);
  }
  return value;
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const { values } = parseArgs({
    args: argv,
    options: { 'github-output': { type: 'string', default: '' } },
    allowPositionals: false,
  });
  const changedPaths = parsePathList(env.CHANGED_PATHS_JSON, 'CHANGED_PATHS_JSON');
  const documentationPaths = parsePathList(env.DOCUMENTATION_PATHS_JSON, 'DOCUMENTATION_PATHS_JSON');
  const classifiedPaths = Object.entries(env)
    .filter(([key]) => key.startsWith('CLASSIFIED_PATHS_'))
    .flatMap(([key, raw]) => parsePathList(raw, key));
  const unmatchedPaths = findUnmatchedSourcePaths({ changedPaths, classifiedPaths, documentationPaths });
  const workspaceImpacts = resolveWorkspaceSourceImpacts({
    changedPaths,
    manifests: await loadWorkspaceManifests(process.cwd()),
  });
  const failClosedPaths = [...new Set([
    ...unmatchedPaths,
    ...workspaceImpacts.unknownWorkspacePaths,
  ])].sort();
  const output = [
    `all=${failClosedPaths.length > 0}`,
    `ui=${workspaceImpacts.ui}`,
    `server=${workspaceImpacts.server}`,
    `cli=${workspaceImpacts.cli}`,
    `stack=${workspaceImpacts.stack}`,
    `shared_packages=${workspaceImpacts.sharedPackages}`,
    `unmatched_paths=${JSON.stringify(failClosedPaths)}`,
    '',
  ].join('\n');
  const githubOutput = String(values['github-output'] ?? '').trim();
  if (githubOutput) await appendFile(githubOutput, output, 'utf8');
  else process.stdout.write(output);
  return failClosedPaths;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
