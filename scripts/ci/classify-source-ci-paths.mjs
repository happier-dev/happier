#!/usr/bin/env node
// @ts-check

import { appendFile, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

import { collectInternalWorkspaceDependencyNames } from '../../apps/stack/scripts/utils/proc/workspace_dependencies.mjs';
import { buildReleaseNotesBundle } from '../pipeline/release/release-notes/project-release-notes.mjs';
import { DEFAULT_RELEASE_CI_LANES, verifyCanonicalCiEvidence } from '../pipeline/release/verify-existing-ci.mjs';

// Narrow outputs of bump-version.mjs and npm/set-preview-versions.mjs, not a
// package.json exemption. Dependency, script, native and runtime fields stay source.
const MATERIALIZED_VERSION_FILES = new Set([
  'apps/ui/package.json', 'apps/cli/package.json', 'apps/server/package.json',
  'apps/website/package.json', 'apps/stack/package.json', 'packages/relay-server/package.json',
  'apps/ui/src-tauri/tauri.conf.json',
]);

/** @param {{path: string; before: string; after: string}} input */
export function isReleaseMetadataOnlyChange({ path, before, after }) {
  if (path === 'apps/ui/CHANGELOG.md') return true;
  if (!MATERIALIZED_VERSION_FILES.has(path)) return false;
  try {
    const previous = JSON.parse(before);
    const next = JSON.parse(after);
    if (!previous || !next || Array.isArray(previous) || Array.isArray(next)
      || typeof previous.version !== 'string' || !previous.version.trim()
      || typeof next.version !== 'string' || !next.version.trim()) return false;
    const { version: previousVersion, ...previousSource } = previous;
    const { version: nextVersion, ...nextSource } = next;
    return isDeepStrictEqual(previousSource, nextSource);
  } catch {
    return false;
  }
}

/**
 * The shortcut covers approved notes and materialized version fields only.
 * Exact-head CI still owns projections and versioned production build validation.
 * Missing baseline evidence leaves the ordinary complete push lane selection in force.
 * @param {{repoRoot: string; repository: string; sourceBranch: string; baseSha: string; sourceSha: string}} input
 */
export async function resolveNotesOnlySourceCi(input) {
  const broad = { notesOnly: false, baseSha: '', baseRunId: '' };
  if (!/^[0-9a-f]{40}$/u.test(input.baseSha) || /^0+$/u.test(input.baseSha) || !/^[0-9a-f]{40}$/u.test(input.sourceSha) || input.baseSha === input.sourceSha) return broad;
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: input.repoRoot, encoding: 'utf8' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(result.stderr || 'Cannot resolve notes-only source range');
    return result.stdout;
  };
  const ancestry = spawnSync('git', ['merge-base', '--is-ancestor', input.baseSha, input.sourceSha], { cwd: input.repoRoot, encoding: 'utf8' });
  if (ancestry.status !== 0) {
    process.stderr.write('Notes-only CI unavailable; source baseline is unavailable or not an ancestor. Selecting the full source lanes.\n');
    return broad;
  }
  const paths = git('diff', '--name-only', '-z', input.baseSha, input.sourceSha).split('\0').filter(Boolean);
  if (paths.length === 0) return broad;
  try {
    for (const path of paths) {
      if (path === 'apps/ui/CHANGELOG.md') continue;
      if (!isReleaseMetadataOnlyChange({
        path,
        before: git('show', `${input.baseSha}:${path}`),
        after: git('show', `${input.sourceSha}:${path}`),
      })) return broad;
    }
    if (paths.includes('apps/ui/src-tauri/tauri.conf.json')) {
      const tauri = JSON.parse(git('show', `${input.sourceSha}:apps/ui/src-tauri/tauri.conf.json`));
      const ui = JSON.parse(git('show', `${input.sourceSha}:apps/ui/package.json`));
      if (tauri.version !== ui.version) return broad;
    }
  } catch {
    // Missing/removed manifests cannot establish unchanged executable source.
    return broad;
  }
  const changelog = git('show', `${input.sourceSha}:apps/ui/CHANGELOG.md`);
  const releaseIds = [...changelog.matchAll(/^## Release ([a-z0-9][a-z0-9._-]*) - \d{4}-\d{2}-\d{2}$/gmu)].map((match) => match[1]);
  if (releaseIds.length === 0) throw new Error('Notes-only source has no canonical release-note section');
  const ui = JSON.parse(git('show', `${input.sourceSha}:apps/ui/package.json`));
  for (const releaseId of releaseIds) buildReleaseNotesBundle(changelog, { releaseId, sourceSha: input.sourceSha, componentVersions: { ui: ui.version } });
  try {
    const listing = spawnSync('gh', ['api', `repos/${input.repository}/actions/workflows/tests.yml/runs?head_sha=${input.baseSha}&event=push&status=success&per_page=1`], { encoding: 'utf8' });
    if (listing.error) throw listing.error;
    if (listing.status !== 0) throw new Error(listing.stderr || 'Cannot discover baseline CI');
    const baseline = JSON.parse(listing.stdout).workflow_runs?.[0];
    if (!baseline) throw new Error('No successful canonical push CI for the unchanged source');
    const baseRunId = String(baseline.id);
    await verifyCanonicalCiEvidence({ repository: input.repository, sourceSha: input.baseSha, sourceBranch: input.sourceBranch, runId: baseRunId, requiredLanes: [...DEFAULT_RELEASE_CI_LANES], allowNotesOnly: false });
    return { notesOnly: true, baseSha: input.baseSha, baseRunId };
  } catch (error) {
    process.stderr.write(`Notes-only CI unavailable; selecting the full source lanes: ${error instanceof Error ? error.message : String(error)}\n`);
    return broad;
  }
}

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
    options: { 'github-output': { type: 'string', default: '' }, 'notes-only': { type: 'boolean', default: false } },
    allowPositionals: false,
  });
  if (values['notes-only']) {
    const result = await resolveNotesOnlySourceCi({ repoRoot: process.cwd(), repository: String(env.GITHUB_REPOSITORY ?? ''), sourceBranch: String(env.CI_SOURCE_BRANCH ?? ''), sourceSha: String(env.CI_SOURCE_SHA ?? ''), baseSha: String(env.CI_BASE_SHA ?? '') });
    const output = `notes_only=${result.notesOnly}\nnotes_base_sha=${result.baseSha}\nnotes_base_run_id=${result.baseRunId}\n`;
    if (values['github-output']) await appendFile(String(values['github-output']), output, 'utf8');
    else process.stdout.write(output);
    return result;
  }
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
