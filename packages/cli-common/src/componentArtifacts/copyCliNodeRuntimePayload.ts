import { cp } from 'node:fs/promises';
import { join } from 'node:path';

import {
  bundleWorkspacePackageWithRuntimeDependencies,
  resolveWorkspaceBundlesFromPackageJson,
  vendorBundledPackageRuntimeDependencies,
} from '../workspaces/index.js';

type CliNodeRuntimeWorkspaceBundle = Readonly<{
  packageName: string;
  srcDir: string;
  destDir: string;
  dereferenceRootDir: string;
}>;

function resolveCliNodeRuntimeWorkspaceBundles(repoRoot: string): ReadonlyArray<CliNodeRuntimeWorkspaceBundle> {
  return resolveWorkspaceBundlesFromPackageJson({
    repoRoot,
    hostPackageDir: join(repoRoot, 'apps', 'cli'),
  });
}

async function copyCliNodeRuntimeDist(distDir: string, payloadDir: string): Promise<void> {
  await cp(distDir, join(payloadDir, 'package-dist'), { recursive: true });
}

function stageCliNodeRuntimeWorkspaceBundles(
  payloadDir: string,
  workspaceBundles: ReadonlyArray<CliNodeRuntimeWorkspaceBundle>,
): void {
  for (const { packageName, srcDir, dereferenceRootDir } of workspaceBundles) {
    bundleWorkspacePackageWithRuntimeDependencies({
      packageName,
      srcDir,
      destDir: join(payloadDir, 'node_modules', ...packageName.split('/')),
      dereferenceRootDir,
    });
  }
}

function vendorCliNodeRuntimeHostPackageDependencies(repoRoot: string, payloadDir: string): void {
  vendorBundledPackageRuntimeDependencies({
    srcPackageJsonPath: join(repoRoot, 'apps', 'cli', 'package.json'),
    destPackageDir: payloadDir,
    dereferenceRootDir: repoRoot,
  });
}

export async function copyCliNodeRuntimePayload({
  repoRoot,
  payloadDir,
  distDir,
}: Readonly<{
  repoRoot: string;
  payloadDir: string;
  distDir: string;
}>): Promise<void> {
  const workspaceBundles = resolveCliNodeRuntimeWorkspaceBundles(repoRoot);

  await copyCliNodeRuntimeDist(distDir, payloadDir);
  vendorCliNodeRuntimeHostPackageDependencies(repoRoot, payloadDir);
  stageCliNodeRuntimeWorkspaceBundles(payloadDir, workspaceBundles);
}
