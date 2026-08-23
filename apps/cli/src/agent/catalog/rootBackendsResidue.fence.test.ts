import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const agentCatalogDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(agentCatalogDir, '../../../../..');
const backendsDir = resolve(repoRoot, 'apps/cli/src/backends');
const retiredRuntimeDirName = ['runtime', 'Core'].join('');
const retiredGeminiDirName = 'gemini';
const retiredRuntimeAdapterAliasNames = [
  ['Runtime', 'For', 'Loop'].join(''),
  ['Agent', 'Backend'].join(''),
  ['Agent', 'Factory'].join(''),
] as const;
const retiredRuntimeAdapterAliasFileNames = retiredRuntimeAdapterAliasNames
  .filter((name) => name !== ['Runtime', 'For', 'Loop'].join(''))
  .map((name) => `${name}.ts`);

const sourceScanIgnoredDirectoryNames = new Set([
  '.git',
  '.next',
  '.project',
  '.turbo',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'package-dist',
]);
const sourceScanExtensions = new Set([
  '.cjs',
  '.cts',
  '.js',
  '.json',
  '.md',
  '.mjs',
  '.mts',
  '.ts',
  '.tsx',
]);

function existingDirectories(paths: readonly Readonly<{ label: string; path: string }>[]): readonly string[] {
  return paths.filter((entry) => existsSync(entry.path)).map((entry) => entry.label);
}

function listFilesRelative(root: string): readonly string[] {
  if (!existsSync(root)) return [];

  return readdirSync(root, { withFileTypes: true })
    .flatMap((entry) => {
      const entryPath = resolve(root, entry.name);
      if (entry.isDirectory()) {
        return listFilesRelative(entryPath).map((child) => `${entry.name}/${child}`);
      }
      return entry.isFile() ? [entry.name] : [];
    })
    .sort();
}

function listNonTestFilesRelative(root: string): readonly string[] {
  return listFilesRelative(root).filter((file) => !file.endsWith('.test.ts') && !file.endsWith('.test.tsx'));
}

function listScannedSourceFiles(root: string): readonly string[] {
  if (!existsSync(root)) return [];

  return readdirSync(root, { withFileTypes: true })
    .flatMap((entry) => {
      if (sourceScanIgnoredDirectoryNames.has(entry.name)) return [];

      const entryPath = resolve(root, entry.name);
      if (entry.isDirectory()) {
        return listScannedSourceFiles(entryPath);
      }
      if (!entry.isFile()) return [];

      return [...sourceScanExtensions].some((extension) => entry.name.endsWith(extension))
        ? [entryPath]
        : [];
    })
    .sort();
}

function readStableSourceFile(filePath: string): string | null {
  try {
    return readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

describe('dead host backend residue fences', () => {
  it('keeps the retired root backend directory absent', () => {
    expect(existsSync(backendsDir)).toBe(false);
  });

  it('keeps packet-deleted host runtime residue folders absent', () => {
    expect(existingDirectories([
      { label: 'codex host backend residue', path: resolve(backendsDir, 'codex') },
      { label: 'claude host backend residue', path: resolve(backendsDir, 'claude') },
      { label: 'opencode host backend residue', path: resolve(backendsDir, 'opencode') },
      { label: 'pi host backend residue', path: resolve(backendsDir, 'pi') },
      { label: 'Gemini retired backend folder', path: resolve(backendsDir, retiredGeminiDirName) },
      { label: 'pi host runtime residue', path: resolve(backendsDir, 'pi', retiredRuntimeDirName) },
      { label: 'pi host ACP runtime residue', path: resolve(backendsDir, 'pi', 'acp') },
      { label: 'pi host RPC runtime residue', path: resolve(backendsDir, 'pi', 'rpc') },
      { label: 'Gemini retired runtime folder', path: resolve(backendsDir, retiredGeminiDirName, retiredRuntimeDirName) },
      { label: 'customAcp host compat shim', path: resolve(backendsDir, 'customAcp') },
    ])).toEqual([]);

    const backendRuntimeResidueDirs = existsSync(backendsDir)
      ? readdirSync(backendsDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .filter((entry) => existsSync(resolve(backendsDir, entry.name, retiredRuntimeDirName)))
        .map((entry) => entry.name)
        .sort()
      : [];

    expect(backendRuntimeResidueDirs).toEqual([]);
  });

  it('keeps drained OhMyPi host residue absent', () => {
    expect(existsSync(resolve(backendsDir, 'ohMyPi'))).toBe(false);
  });

  it('keeps built-in host catalog reader shells absent', () => {
    expect(existsSync(resolve(backendsDir, 'builtInHostCatalogEntries.ts'))).toBe(false);
    expect(existsSync(resolve(repoRoot, 'apps/cli/src/agent/catalog/builtInHostCatalogEntries.ts'))).toBe(false);
    expect(existsSync(resolve(repoRoot, 'apps/cli/src/agent/catalog/builtInHostCatalogEntryDefinitions.ts'))).toBe(false);
  });

  it('keeps the retired root backend catalog compatibility facade absent', () => {
    expect(existsSync(resolve(backendsDir, 'catalog.ts'))).toBe(false);
  });

  it('keeps visible Kiro facts out of host, protocol provider, and UI provider folders', () => {
    expect(existingDirectories([
      { label: 'CLI host Kiro backend', path: resolve(backendsDir, 'kiro') },
      { label: 'protocol Kiro agent folder', path: resolve(repoRoot, 'packages/protocol/src/agents', 'kiro') },
      { label: 'UI Kiro provider folder', path: resolve(repoRoot, 'apps/ui/sources/agents/providers', 'kiro') },
    ])).toEqual([]);
  });

  it('keeps the host ACP CLI detect/auth fallback retired in favor of declared Agent CLI metadata', () => {
    expect(existsSync(resolve(repoRoot, 'apps/cli/src/agent/acp/catalog/builtIn/auth.ts'))).toBe(false);
    expect(existsSync(resolve(repoRoot, 'apps/cli/src/agent/acp/catalog/builtIn/detect.ts'))).toBe(false);
    expect(
      existsSync(resolve(repoRoot, 'apps/cli/src/capabilities/cliAuth/createUnknownCliAuthSpec.ts')),
    ).toBe(false);
  });

  it('keeps retired runtime adapter alias files out of the host core', () => {
    const coreDir = resolve(repoRoot, 'apps/cli/src/agent/core');

    expect(
      retiredRuntimeAdapterAliasFileNames
        .filter((fileName) => existsSync(resolve(coreDir, fileName))),
    ).toEqual([]);
  });

  it('keeps retired runtime adapter alias tokens out of app, package, and script source', () => {
    const retiredTokenPattern = new RegExp(String.raw`\b(?:${retiredRuntimeAdapterAliasNames.join('|')})\b`);
    const offenders = [
      ...listScannedSourceFiles(resolve(repoRoot, 'apps')),
      ...listScannedSourceFiles(resolve(repoRoot, 'packages')),
      ...listScannedSourceFiles(resolve(repoRoot, 'scripts')),
    ].flatMap((filePath) => {
      const source = readStableSourceFile(filePath);
      if (source === null) return [];
      if (!source.includes('Agent') && !source.includes('Runtime')) return [];
      return retiredTokenPattern.test(source) ? [relative(repoRoot, filePath)] : [];
    });

    expect(offenders).toEqual([]);
  }, 120_000);
});
