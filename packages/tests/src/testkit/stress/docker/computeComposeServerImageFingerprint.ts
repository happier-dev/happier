import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const includedRoots = [
  '.dockerignore',
  'package.json',
  'yarn.lock',
  'apps/server',
  'packages/agents',
  'packages/cli-common',
  'packages/protocol',
  'packages/release-runtime',
  'scripts/pipeline/expo/eas-postinstall.mjs',
  'scripts/workspaces',
] as const;

const ignoredDirectoryNames = new Set([
  '.git',
  '.next',
  '.project',
  '.expo',
  'coverage',
  'dist',
  'node_modules',
  'playwright-report',
  'test-results',
  'web-build',
]);

const ignoredRelativePathPrefixes = [
  'apps/cli/tools/archives',
  'apps/cli/tools/unpacked',
  'apps/server/generated',
  'apps/stack/output',
  'apps/ui/android',
  'apps/ui/ios',
  'apps/ui/src-tauri',
  'apps/ui/src-tauri/target',
] as const;

function isIgnoredAbsolutePath(repoRootDir: string, absolutePath: string): boolean {
  const relativePath = relative(repoRootDir, absolutePath);

  if (relativePath.startsWith('..')) {
    return false;
  }

  return ignoredRelativePathPrefixes.some((prefix) => (
    relativePath === prefix
    || relativePath.startsWith(`${prefix}/`)
  ));
}

function appendPathToHash(hash: ReturnType<typeof createHash>, repoRootDir: string, absolutePath: string): void {
  if (!existsSync(absolutePath)) return;
  if (isIgnoredAbsolutePath(repoRootDir, absolutePath)) return;

  const stat = lstatSync(absolutePath);
  if (stat.isSymbolicLink()) {
    return;
  }

  if (stat.isDirectory()) {
    const directoryName = absolutePath.split('/').at(-1);
    if (directoryName && ignoredDirectoryNames.has(directoryName)) {
      return;
    }

    const entries = readdirSync(absolutePath).sort((left, right) => left.localeCompare(right));
    for (const entry of entries) {
      appendPathToHash(hash, repoRootDir, join(absolutePath, entry));
    }
    return;
  }

  if (!stat.isFile()) {
    return;
  }

  hash.update(relative(repoRootDir, absolutePath));
  hash.update('\0');
  hash.update(readFileSync(absolutePath));
  hash.update('\0');
}

export function computeComposeServerImageFingerprint(repoRootDir: string): string {
  const resolvedRepoRootDir = resolve(repoRootDir);
  const hash = createHash('sha1');
  hash.update('happier-stress-compose-image-fingerprint:v1');
  hash.update('\0');

  for (const root of includedRoots) {
    appendPathToHash(hash, resolvedRepoRootDir, join(resolvedRepoRootDir, root));
  }

  return hash.digest('hex');
}
