import { readFile } from 'node:fs/promises';

import { collectWorkspacePackageJsonPaths } from '../../../apps/stack/scripts/utils/proc/workspace_package_manifests.mjs';
import {
  collectWorkspaceManifests,
  type WorkspaceManifest,
  type WorkspacePackageJsonInput,
} from './workspaceManifests.ts';

const PLUGIN_WORKSPACE_PREFIX = 'packages/plugins/';

export interface PluginWorkspaceTestPackage {
  packageName: string;
  workspaceDirectory: string;
}

export type PluginWorkspaceTestPackageManifest = WorkspacePackageJsonInput;

export interface PluginWorkspaceTestPackageReport {
  packages: readonly PluginWorkspaceTestPackage[];
  issues: readonly string[];
}

export type PluginWorkspaceScriptName = 'test' | 'typecheck';

export interface PluginWorkspaceTestInvocation {
  packageName: string;
  args: readonly string[];
}

function describeInvalidManifest(manifest: WorkspaceManifest): string | null {
  if (manifest.invalidReason === 'unparsable') {
    return `Plugin workspace ${manifest.workspaceDirectory} has invalid package.json metadata.`;
  }
  if (manifest.invalidReason === 'not-an-object') {
    return `Plugin workspace ${manifest.workspaceDirectory} package.json must be an object.`;
  }
  return null;
}

export function collectPluginWorkspaceTestPackageReport(params: Readonly<{
  rootDir: string;
  workspacePackageManifests: readonly PluginWorkspaceTestPackageManifest[];
}>): PluginWorkspaceTestPackageReport {
  const issues: string[] = [];
  const packages: PluginWorkspaceTestPackage[] = [];
  const packageNames = new Set<string>();
  let pluginWorkspaceCount = 0;

  const manifests = collectWorkspaceManifests({
    rootDir: params.rootDir,
    workspacePackageJsons: params.workspacePackageManifests,
  });

  for (const manifest of manifests) {
    if (!manifest.workspaceDirectory.startsWith(PLUGIN_WORKSPACE_PREFIX)) continue;
    pluginWorkspaceCount += 1;

    const invalidMessage = describeInvalidManifest(manifest);
    if (invalidMessage !== null) {
      issues.push(invalidMessage);
      continue;
    }
    if (manifest.packageName === null) {
      issues.push(`Plugin workspace ${manifest.workspaceDirectory} must declare a non-empty package name.`);
      continue;
    }
    if (manifest.scripts.test === undefined) {
      issues.push(`Plugin workspace ${manifest.workspaceDirectory} must define a non-empty test script.`);
      continue;
    }
    if (manifest.scripts.typecheck === undefined) {
      issues.push(`Plugin workspace ${manifest.workspaceDirectory} must define a non-empty typecheck script.`);
      continue;
    }
    if (packageNames.has(manifest.packageName)) {
      issues.push(`Plugin workspace package name ${manifest.packageName} is declared more than once.`);
      continue;
    }
    packageNames.add(manifest.packageName);
    packages.push({
      packageName: manifest.packageName,
      workspaceDirectory: manifest.workspaceDirectory,
    });
  }

  if (pluginWorkspaceCount === 0) {
    issues.push('No plugin workspace packages were found from root workspace metadata.');
  }

  return {
    packages: packages.sort((left, right) => left.workspaceDirectory.localeCompare(right.workspaceDirectory)),
    issues,
  };
}

export async function discoverPluginWorkspaceTestPackageReport(
  rootDir: string = process.cwd(),
): Promise<PluginWorkspaceTestPackageReport> {
  const packageJsonPaths = await collectWorkspacePackageJsonPaths(rootDir);
  const workspacePackageManifests = await Promise.all(
    packageJsonPaths.map(async (packageJsonPath) => ({
      packageJsonPath,
      packageJsonText: await readFile(packageJsonPath, 'utf8'),
    })),
  );
  return collectPluginWorkspaceTestPackageReport({ rootDir, workspacePackageManifests });
}

export function buildPluginWorkspaceTestInvocations(
  packages: readonly PluginWorkspaceTestPackage[],
  scriptName: PluginWorkspaceScriptName = 'test',
): readonly PluginWorkspaceTestInvocation[] {
  return packages.map((pluginPackage) => ({
    packageName: pluginPackage.packageName,
    args: ['workspace', pluginPackage.packageName, scriptName],
  }));
}

export function isPluginWorkspaceTestPath(
  relativePath: string,
  packages: readonly PluginWorkspaceTestPackage[],
): boolean {
  return packages.some((pluginPackage) => (
    relativePath.startsWith(`${pluginPackage.workspaceDirectory}/`)
  ));
}
