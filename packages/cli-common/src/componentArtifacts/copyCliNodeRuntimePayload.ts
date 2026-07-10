import { cp } from 'node:fs/promises';
import { join } from 'node:path';

import {
  bundleWorkspacePackageWithRuntimeDependencies,
  resolveWorkspaceBundlesFromPackageJson,
  vendorBundledPackageRuntimeDependencies,
} from '../workspaces/index.js';

import { ensureBundledWorkspacePackagesBuilt } from './ensureBundledWorkspacePackagesBuilt.js';
import type { RunCommand } from './commands.js';

type CliNodeRuntimeWorkspaceBundle = Readonly<{
  packageName: string;
  srcDir: string;
  destDir: string;
}>;

function resolveCliNodeRuntimeWorkspaceBundles(repoRoot: string): ReadonlyArray<CliNodeRuntimeWorkspaceBundle> {
  return resolveWorkspaceBundlesFromPackageJson({
    repoRoot,
    hostPackageDir: join(repoRoot, 'apps', 'cli'),
  });
}

async function ensureCliNodeRuntimeWorkspaceBundlesBuilt(
  repoRoot: string,
  workspaceBundles: ReadonlyArray<CliNodeRuntimeWorkspaceBundle>,
  params: Readonly<{
    yarn: Readonly<{ cmd: string; args: string[] }>;
    runCommand: RunCommand;
  }>,
): Promise<void> {
  await ensureBundledWorkspacePackagesBuilt({
    repoRoot,
    bundles: workspaceBundles.map(({ packageName, srcDir }) => ({ packageName, srcDir })),
    yarn: params.yarn,
    runCommand: params.runCommand,
  });
}

async function copyCliNodeRuntimeDist(distDir: string, payloadDir: string): Promise<void> {
  await cp(distDir, join(payloadDir, 'package-dist'), { recursive: true });
}

function stageCliNodeRuntimeWorkspaceBundles(
  payloadDir: string,
  workspaceBundles: ReadonlyArray<CliNodeRuntimeWorkspaceBundle>,
): void {
  for (const { packageName, srcDir } of workspaceBundles) {
    bundleWorkspacePackageWithRuntimeDependencies({
      packageName,
      srcDir,
      destDir: join(payloadDir, 'node_modules', ...packageName.split('/')),
    });
  }
}

function vendorCliNodeRuntimeHostPackageDependencies(repoRoot: string, payloadDir: string): void {
  vendorBundledPackageRuntimeDependencies({
    srcPackageJsonPath: join(repoRoot, 'apps', 'cli', 'package.json'),
    destPackageDir: payloadDir,
  });
}

export async function copyCliNodeRuntimePayload({
  repoRoot,
  payloadDir,
  distDir,
  yarn,
  runCommand,
}: Readonly<{
  repoRoot: string;
  payloadDir: string;
  distDir: string;
  yarn: Readonly<{ cmd: string; args: string[] }>;
  runCommand: RunCommand;
}>): Promise<void> {
  const workspaceBundles = resolveCliNodeRuntimeWorkspaceBundles(repoRoot);

  await ensureCliNodeRuntimeWorkspaceBundlesBuilt(repoRoot, workspaceBundles, { yarn, runCommand });
  await copyCliNodeRuntimeDist(distDir, payloadDir);
  vendorCliNodeRuntimeHostPackageDependencies(repoRoot, payloadDir);
  stageCliNodeRuntimeWorkspaceBundles(payloadDir, workspaceBundles);
}
