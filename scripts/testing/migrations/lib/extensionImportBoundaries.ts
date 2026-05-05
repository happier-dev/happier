import * as path from 'node:path';

import { collectFileInventory } from './collectFileInventory.ts';
import { type InventoryFile } from './migrationTypes.ts';

export interface ExtensionImportBoundaryViolation {
  filePath: string;
  specifier: string;
  kind: 'forbidden-alias' | 'forbidden-apps-import' | 'relative-escape';
  details: string;
}

export interface ValidateExtensionImportBoundariesResult {
  ok: boolean;
  errors: string[];
  violations: ExtensionImportBoundaryViolation[];
}

function normalizeRepoPath(filePath: string): string {
  return filePath.split('\\').join('/');
}

function extractImportSpecifiers(content: string): string[] {
  const matches = content.matchAll(
    /(?:from\s+['"]([^'"]+)['"]|import\s+['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|require\s*\(\s*['"]([^'"]+)['"]\s*\))/g,
  );
  const specifiers = Array.from(matches, (match) => match[1] ?? match[2] ?? match[3] ?? match[4] ?? '').filter(Boolean);
  // Keep deterministic output; avoid repeated specifiers within the same file.
  return Array.from(new Set(specifiers)).sort((left, right) => left.localeCompare(right));
}

function extensionPackageRootFor(filePath: string): string | null {
  // Expected: packages/plugins/<extensionId>/...
  const parts = normalizeRepoPath(filePath).split('/');
  if (parts.length < 3) {
    return null;
  }
  if (parts[0] !== 'packages' || parts[1] !== 'plugins') {
    return null;
  }
  const extensionId = parts[2];
  if (!extensionId) {
    return null;
  }
  return `packages/plugins/${extensionId}`;
}

function resolveRelativeImport(importerFilePath: string, specifier: string): string {
  const importerDir = path.posix.dirname(normalizeRepoPath(importerFilePath));
  return path.posix.normalize(path.posix.join(importerDir, specifier));
}

export function validateExtensionImportBoundaries(options?: {
  rootDir?: string;
  inventory?: readonly InventoryFile[];
}): ValidateExtensionImportBoundariesResult {
  const rootDir = options?.rootDir ?? process.cwd();
  const inventory =
    options?.inventory ??
    collectFileInventory({
      rootDir,
      searchRoots: ['packages'],
      include: /\.[cm]?[jt]sx?$/,
    });

  const extensionSourceFiles = inventory.filter((file) => normalizeRepoPath(file.filePath).startsWith('packages/plugins/'));
  if (extensionSourceFiles.length === 0) {
    return {
      ok: true,
      errors: [],
      violations: [],
    };
  }

  const violations: ExtensionImportBoundaryViolation[] = [];

  for (const file of extensionSourceFiles) {
    const filePath = normalizeRepoPath(file.filePath);
    const packageRoot = extensionPackageRootFor(filePath);
    if (!packageRoot) {
      continue;
    }

    for (const specifier of extractImportSpecifiers(file.content)) {
      if (specifier.startsWith('@/')) {
        violations.push({
          filePath,
          specifier,
          kind: 'forbidden-alias',
          details: 'Extension packages must not import from the CLI @/ alias; use shared workspace packages or injected context.',
        });
        continue;
      }

      if (specifier.startsWith('apps/')) {
        violations.push({
          filePath,
          specifier,
          kind: 'forbidden-apps-import',
          details: 'Extension packages must not import from apps/**; use shared workspace packages or injected context.',
        });
        continue;
      }

      if (specifier.startsWith('.')) {
        const resolved = resolveRelativeImport(filePath, specifier);
        const packageRootPrefix = `${packageRoot}/`;
        const allowed = resolved === packageRoot || resolved.startsWith(packageRootPrefix);
        if (!allowed) {
          violations.push({
            filePath,
            specifier,
            kind: 'relative-escape',
            details: `Relative import resolves outside the extension package root (${packageRoot}): ${resolved}`,
          });
        }
      }
    }
  }

  const sortedViolations = violations.sort((a, b) => {
    const fileCmp = a.filePath.localeCompare(b.filePath);
    if (fileCmp !== 0) {
      return fileCmp;
    }
    const kindCmp = a.kind.localeCompare(b.kind);
    if (kindCmp !== 0) {
      return kindCmp;
    }
    return a.specifier.localeCompare(b.specifier);
  });

  const errors = sortedViolations.map(
    (violation) =>
      `${violation.filePath}: forbidden import ${JSON.stringify(violation.specifier)} (${violation.kind}) - ${violation.details}`,
  );

  return {
    ok: errors.length === 0,
    errors,
    violations: sortedViolations,
  };
}
