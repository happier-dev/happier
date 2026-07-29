import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const includedRoots = [
  '.github/feature-policy',
  '.dockerignore',
  'package.json',
  'yarn.lock',
  'apps/cli/package.json',
  'apps/server',
  'apps/stack/scripts/utils',
  'apps/ui/package.json',
  'packages/agents',
  'packages/cli-common',
  'packages/plugin-sdk',
  'packages/plugins/review-coderabbit',
  'packages/plugins/review-deepsec',
  'packages/protocol',
  'packages/release-runtime',
  'packages/tests/src/testkit/stress/targets/startFullComposeStressTarget.ts',
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

const ignoredGeneratedDirectoryPrefixes = [
  '.dist.build.',
  '.dist.hstack-stage-',
  '.restore.',
  '.tmp.',
] as const;

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
  const relativePath = relative(repoRootDir, absolutePath).replaceAll('\\', '/');

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
    const directoryName = absolutePath.replaceAll('\\', '/').split('/').at(-1);
    if (
      directoryName
      && (
        ignoredDirectoryNames.has(directoryName)
        || ignoredGeneratedDirectoryPrefixes.some((prefix) => directoryName.startsWith(prefix))
      )
    ) {
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

  hash.update(relative(repoRootDir, absolutePath).replaceAll('\\', '/'));
  hash.update('\0');
  hash.update(readFileSync(absolutePath));
  hash.update('\0');
}

export function computeComposeServerImageFingerprint(repoRootDir: string): string {
  const resolvedRepoRootDir = resolve(repoRootDir);
  const hash = createHash('sha1');
  hash.update('happier-stress-compose-image-fingerprint:v5');
  hash.update('\0');

  for (const root of includedRoots) {
    appendPathToHash(hash, resolvedRepoRootDir, join(resolvedRepoRootDir, root));
  }

  return hash.digest('hex');
}
