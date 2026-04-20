import { existsSync, lstatSync, mkdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

import { resolveHappyHomeDirFromEnvironment } from '@happier-dev/cli-common/providers';

import { normalizeMaterializationKeyForPath } from '@/daemon/connectedServices/materialize/normalizeMaterializationKeyForPath';

function isResolvedPathInsideRoot(rootPath: string, candidatePath: string): boolean {
  const relativePath = relative(rootPath, candidatePath);
  if (!relativePath || relativePath === '.') return true;
  return relativePath !== '..' && !relativePath.startsWith(`..${sep}`);
}

function resolveHappierHomeDir(happierHomeDir?: (() => string) | undefined): string {
  return typeof happierHomeDir === 'function' ? happierHomeDir() : resolveHappyHomeDirFromEnvironment(process.env);
}

export function resolvePromptAssetManagedSymlinkRoot(happierHomeDir?: (() => string) | undefined): string {
  return join(resolveHappierHomeDir(happierHomeDir), 'prompt-assets', 'symlink-installs');
}

export function resolvePromptAssetManagedBundleInstallDir(args: Readonly<{
  assetTypeId: string;
  scope: 'user' | 'project';
  directory?: string | null | undefined;
  targetName: string;
  happierHomeDir?: () => string;
}>): string {
  const key = normalizeMaterializationKeyForPath(JSON.stringify({
    assetTypeId: args.assetTypeId,
    scope: args.scope,
    directory: args.directory ?? null,
    targetName: args.targetName,
  }));
  return join(resolvePromptAssetManagedSymlinkRoot(args.happierHomeDir), args.assetTypeId, key);
}

export function resolveAllowedManagedBundleSymlinkTarget(args: Readonly<{
  linkPath: string;
  happierHomeDir?: () => string;
}>): string | null {
  if (!existsSync(args.linkPath)) return null;
  if (!lstatSync(args.linkPath).isSymbolicLink()) return null;
  const managedRoot = resolvePromptAssetManagedSymlinkRoot(args.happierHomeDir);
  const resolvedManagedRoot = existsSync(managedRoot) ? realpathSync(managedRoot) : managedRoot;
  const resolvedTarget = realpathSync(args.linkPath);
  if (!isResolvedPathInsideRoot(resolvedManagedRoot, resolvedTarget)) return null;
  return resolvedTarget;
}

export function replaceDirectoryWithManagedSymlink(args: Readonly<{
  linkPath: string;
  managedDirectory: string;
}>): void {
  rmSync(args.linkPath, { recursive: true, force: true });
  mkdirSync(dirname(args.linkPath), { recursive: true });
  symlinkSync(args.managedDirectory, args.linkPath, process.platform === 'win32' ? 'junction' : 'dir');
}

export function deleteManagedBundleSymlinkInstall(args: Readonly<{
  linkPath: string;
  happierHomeDir?: () => string;
}>): void {
  const managedTarget = resolveAllowedManagedBundleSymlinkTarget(args);
  rmSync(args.linkPath, { recursive: true, force: true });
  if (managedTarget) {
    rmSync(managedTarget, { recursive: true, force: true });
  }
}
