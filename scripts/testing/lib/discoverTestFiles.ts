import { existsSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

const TEST_FILE_RE = /\.(?:test|spec|scenario)\.(?:[cm]?[jt]sx?)$/;
const IGNORED_DIRS = new Set([
  '.git',
  '.next',
  '.turbo',
  'android',
  'build',
  'coverage',
  'dist',
  'ios',
  'node_modules',
  'out',
]);

/**
 * Build tooling snapshots sources into a sibling `.tmp.<something>` directory while it
 * works — `apps/cli/scripts/build.mjs` creates `.tmp.hstack-cli-build-source.<random>`
 * and excludes that same prefix from its own walk. A build racing this walk would
 * otherwise duplicate every test it copied, inflating each lane count and producing
 * issues against a path that no longer exists by the time anyone reads them.
 *
 * `scripts/workspaces/buildTypeScriptPackageDist.mjs` stages every TypeScript workspace's emitted
 * output the same way under `.dist.build.<buildId>` before renaming it onto `dist/`. Those copies
 * are compiled `dist` output, not source, so the lane question does not apply to them at all — and
 * an interrupted build leaves one behind, which then reports dozens of phantom unwired files.
 */
function isTransientStagingDirectory(name: string): boolean {
  return name.startsWith('.tmp.') || name.startsWith('.dist.build.');
}

/**
 * Repo-relative directories holding generated payloads rather than first-party test sources.
 *
 * `apps/ui/src-tauri` is a Rust crate whose JavaScript sidecar payload is vendored in by the
 * desktop build (`/systemTasks/`, `/ssh/`, `/integrations/` are all git-ignored there). The
 * vendored copies are compiled `dist` output under a different name, so the `dist` skip above
 * misses them and every developer who has built the desktop app would otherwise see them reported
 * as unwired source tests.
 *
 * `apps/cli/.runner-snapshots` is the pinned-runner cache: each entry is a whole packed CLI `dist`
 * tree keyed by its content hash, so one local pack run adds another copy of every test the
 * package publishes.
 */
const IGNORED_RELATIVE_DIRS = new Set([
  'apps/cli/.runner-snapshots',
  'apps/ui/src-tauri',
]);

function normalizePath(filePath: string): string {
  return filePath.split('\\').join('/');
}

function walkDirectory(rootDir: string, absoluteDir: string, output: string[]): void {
  for (const entry of readdirSync(absoluteDir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const childPath = join(absoluteDir, entry.name);
      if (
        !IGNORED_DIRS.has(entry.name)
        && !isTransientStagingDirectory(entry.name)
        && !IGNORED_RELATIVE_DIRS.has(normalizePath(relative(rootDir, childPath)))
      ) {
        walkDirectory(rootDir, childPath, output);
      }
      continue;
    }

    if (!entry.isFile() || !TEST_FILE_RE.test(entry.name)) {
      continue;
    }

    output.push(normalizePath(relative(rootDir, join(absoluteDir, entry.name))));
  }
}

export interface DiscoverTestFilesOptions {
  rootDir?: string;
  searchRoots?: readonly string[];
}

export function discoverTestFiles(options: DiscoverTestFilesOptions = {}): string[] {
  const rootDir = options.rootDir ?? process.cwd();
  const searchRoots = options.searchRoots ?? ['apps', 'packages'];
  const output: string[] = [];

  for (const searchRoot of searchRoots) {
    const absoluteRoot = join(rootDir, searchRoot);
    if (!existsSync(absoluteRoot)) {
      continue;
    }

    walkDirectory(rootDir, absoluteRoot, output);
  }

  return output.sort((a, b) => a.localeCompare(b));
}
