import { readFile } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';

import { collectWorkspacePackageJsonPaths } from '../../../apps/stack/scripts/utils/proc/workspace_package_manifests.mjs';

/**
 * Canonical workspace metadata reader for the test-governance validators.
 *
 * The repository's workspace set is owned by the root `package.json` `workspaces.packages`
 * patterns and expanded by `collectWorkspacePackageJsonPaths`. Every governance validator that
 * needs "which workspaces exist / what can they run" reads it through this module so no second
 * hand-maintained workspace list can drift away from the real workspace set.
 */
export interface WorkspacePackageJsonInput {
  packageJsonPath: string;
  packageJsonText: string;
}

export type WorkspaceManifestInvalidReason = 'unparsable' | 'not-an-object';

export interface WorkspaceManifest {
  /** Repo-relative workspace directory, `/`-separated, without a trailing separator. */
  workspaceDirectory: string;
  packageName: string | null;
  scripts: Readonly<Record<string, string>>;
  invalidReason: WorkspaceManifestInvalidReason | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeRelativePath(rootDir: string, candidatePath: string): string {
  return relative(resolve(rootDir), resolve(candidatePath)).split(sep).join('/');
}

function parseWorkspaceManifest(rootDir: string, input: WorkspacePackageJsonInput): WorkspaceManifest | null {
  const relativePackageJsonPath = normalizeRelativePath(rootDir, input.packageJsonPath);
  if (!relativePackageJsonPath.endsWith('/package.json')) {
    return null;
  }

  const workspaceDirectory = relativePackageJsonPath.slice(0, -'/package.json'.length);

  let parsed: unknown;
  try {
    parsed = JSON.parse(input.packageJsonText);
  } catch {
    return { workspaceDirectory, packageName: null, scripts: {}, invalidReason: 'unparsable' };
  }

  if (!isRecord(parsed)) {
    return { workspaceDirectory, packageName: null, scripts: {}, invalidReason: 'not-an-object' };
  }

  const rawScripts = isRecord(parsed.scripts) ? parsed.scripts : {};
  const scripts: Record<string, string> = {};
  for (const [scriptName, scriptBody] of Object.entries(rawScripts)) {
    if (typeof scriptBody === 'string' && scriptBody.trim() !== '') {
      scripts[scriptName] = scriptBody;
    }
  }

  return {
    workspaceDirectory,
    packageName: typeof parsed.name === 'string' && parsed.name.trim() !== '' ? parsed.name : null,
    scripts,
    invalidReason: null,
  };
}

export function collectWorkspaceManifests(params: Readonly<{
  rootDir: string;
  workspacePackageJsons: readonly WorkspacePackageJsonInput[];
}>): readonly WorkspaceManifest[] {
  const manifests: WorkspaceManifest[] = [];
  for (const input of params.workspacePackageJsons) {
    const manifest = parseWorkspaceManifest(params.rootDir, input);
    if (manifest) {
      manifests.push(manifest);
    }
  }
  return manifests.sort((left, right) => left.workspaceDirectory.localeCompare(right.workspaceDirectory));
}

export async function discoverWorkspaceManifests(rootDir: string = process.cwd()): Promise<readonly WorkspaceManifest[]> {
  const packageJsonPaths = await collectWorkspacePackageJsonPaths(rootDir);
  const workspacePackageJsons = await Promise.all(
    packageJsonPaths.map(async (packageJsonPath: string) => ({
      packageJsonPath,
      packageJsonText: await readFile(packageJsonPath, 'utf8'),
    })),
  );
  return collectWorkspaceManifests({ rootDir, workspacePackageJsons });
}

/**
 * Resolve the workspace that owns a repo-relative path, preferring the deepest match so a nested
 * workspace (for example `packages/plugins/<id>`) wins over an ancestor.
 */
export function resolveOwningWorkspaceDirectory(
  relativePath: string,
  workspaceDirectories: readonly string[],
): string | null {
  let owner: string | null = null;
  for (const workspaceDirectory of workspaceDirectories) {
    if (!relativePath.startsWith(`${workspaceDirectory}/`)) continue;
    if (owner === null || workspaceDirectory.length > owner.length) {
      owner = workspaceDirectory;
    }
  }
  return owner;
}
