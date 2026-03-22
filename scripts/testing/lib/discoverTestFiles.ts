import { existsSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

const TEST_FILE_RE = /\.(?:test|spec)\.(?:[cm]?[jt]sx?)$/;
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

function normalizePath(filePath: string): string {
  return filePath.split('\\').join('/');
}

function walkDirectory(rootDir: string, absoluteDir: string, output: string[]): void {
  for (const entry of readdirSync(absoluteDir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name)) {
        walkDirectory(rootDir, join(absoluteDir, entry.name), output);
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