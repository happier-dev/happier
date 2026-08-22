import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { type InventoryFile } from './migrationTypes.ts';

const DEFAULT_IGNORED_DIRS = new Set([
  '.git',
  '.expo',
  '.next',
  '.project',
  '.turbo',
  'android',
  'build',
  'coverage',
  'dist',
  'generated',
  'ios',
  'node_modules',
  'out',
  'package-dist',
  'temp',
  'tmp',
]);
const TEMPORARY_ARTIFACT_DIRECTORY_PATTERN = /^\.(?:backup|dist|restore|tmp)(?:[.-].*)?$/;
const REPOSITORY_GENERATED_ARTIFACT_DIRECTORY_PATTERNS = [
  /(?:^|\/)\.runner-snapshots$/,
  /^apps\/cli\/dist\.probe\.manual$/,
  /^apps\/cli\/\.g3-real-child-[^/]*$/,
  /^apps\/ui\/dist-dperf$/,
];

export interface CollectFileInventoryOptions {
  rootDir?: string;
  searchRoots?: readonly string[];
  include: RegExp;
}

function normalizePath(filePath: string): string {
  return filePath.split('\\').join('/');
}

function walk(rootDir: string, absoluteDir: string, include: RegExp, output: InventoryFile[]): void {
  for (const entry of readdirSync(absoluteDir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const absoluteEntryPath = join(absoluteDir, entry.name);
      if (!shouldIgnoreDirectory(rootDir, absoluteEntryPath, entry.name)) {
        walk(rootDir, absoluteEntryPath, include, output);
      }
      continue;
    }

    if (!entry.isFile() || !include.test(entry.name)) {
      continue;
    }

    const absolutePath = join(absoluteDir, entry.name);
    output.push({
      filePath: normalizePath(relative(rootDir, absolutePath)),
      content: readFileSync(absolutePath, 'utf8'),
    });
  }
}

function shouldIgnoreDirectory(
  rootDir: string,
  absoluteDirectoryPath: string,
  directoryName: string,
): boolean {
  if (
    DEFAULT_IGNORED_DIRS.has(directoryName)
    || TEMPORARY_ARTIFACT_DIRECTORY_PATTERN.test(directoryName)
  ) {
    return true;
  }

  const repositoryRelativePath = normalizePath(relative(rootDir, absoluteDirectoryPath));
  return REPOSITORY_GENERATED_ARTIFACT_DIRECTORY_PATTERNS.some((pattern) => (
    pattern.test(repositoryRelativePath)
  ));
}

export function collectFileInventory(options: CollectFileInventoryOptions): InventoryFile[] {
  const rootDir = options.rootDir ?? process.cwd();
  const searchRoots = options.searchRoots ?? ['apps', 'packages', 'scripts'];
  const output: InventoryFile[] = [];

  for (const searchRoot of searchRoots) {
    const absoluteRoot = join(rootDir, searchRoot);
    if (!existsSync(absoluteRoot)) {
      continue;
    }

    walk(rootDir, absoluteRoot, options.include, output);
  }

  return output.sort((left, right) => left.filePath.localeCompare(right.filePath));
}
