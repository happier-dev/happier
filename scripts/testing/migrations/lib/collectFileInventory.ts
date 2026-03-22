import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { type InventoryFile } from './migrationTypes.ts';

const DEFAULT_IGNORED_DIRS = new Set([
  '.git',
  '.next',
  '.project',
  '.turbo',
  'android',
  'build',
  'coverage',
  'dist',
  'ios',
  'node_modules',
  'out',
]);

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
      if (!DEFAULT_IGNORED_DIRS.has(entry.name)) {
        walk(rootDir, join(absoluteDir, entry.name), include, output);
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
