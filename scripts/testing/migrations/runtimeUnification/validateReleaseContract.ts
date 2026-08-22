import { fileURLToPath } from 'node:url';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  runAllValidators,
  type RuntimeUnificationRunnerResult,
} from './runAllValidators.ts';
import {
  collectV2ZeroInventory,
  collectV2ZeroSourceFiles,
} from '../lib/v2ZeroInventory.ts';

export interface RuntimeUnificationReleaseContractSurfaceResult {
  ok: boolean;
  errors: readonly string[];
  scannedFiles: readonly string[];
}

export interface RuntimeUnificationReleaseContractResult {
  ok: boolean;
  validatorResult: RuntimeUnificationRunnerResult;
  surfaceResult: RuntimeUnificationReleaseContractSurfaceResult;
}

export async function validateReleaseContract(options?: Readonly<{
  rootDir?: string;
}>): Promise<RuntimeUnificationReleaseContractResult> {
  const rootDir = options?.rootDir ?? process.cwd();
  const validatorResult = await runAllValidators({ rootDir });
  const surfaceResult = validateReleaseContractSurface({ rootDir });
  return {
    ok: validatorResult.ok && surfaceResult.ok,
    validatorResult,
    surfaceResult,
  };
}

export function validateReleaseContractSurface(options?: Readonly<{
  rootDir?: string;
}>): RuntimeUnificationReleaseContractSurfaceResult {
  const rootDir = options?.rootDir ?? process.cwd();
  const scannedFiles: string[] = [];
  const errors: string[] = [];

  errors.push(...validateHostProviderCatalogOwnership(rootDir, scannedFiles));
  errors.push(...validateGeneratedProjectionBindings(rootDir, scannedFiles));
  errors.push(...validatePluginRootRuntimeContributionExports(rootDir, scannedFiles));
  errors.push(...validateNoForbiddenLegacyBackendDependencies(rootDir, scannedFiles));
  errors.push(...validateVoiceV3FV2MediaContraction(rootDir, scannedFiles));

  return {
    ok: errors.length === 0,
    errors,
    scannedFiles: [...new Set(scannedFiles)].sort((left, right) => left.localeCompare(right)),
  };
}

function validateVoiceV3FV2MediaContraction(rootDir: string, scannedFiles: string[]): string[] {
  const category = collectV2ZeroInventory(collectV2ZeroSourceFiles(rootDir))
    .categories
    .find((candidate) => candidate.id === 'voice-v3-f-v2-media-residue');
  if (!category) {
    return [];
  }

  scannedFiles.push(...category.files);
  return [
    `voice-v3-f-v2-media-residue: Claim 42 cannot close while retired Voice V2 media consumers remain (${category.files.join(', ')}).`,
  ];
}

function validateNoForbiddenLegacyBackendDependencies(rootDir: string, scannedFiles: string[]): string[] {
  const errors: string[] = [];
  const files = collectRuntimeSourceFiles(rootDir, [
    'apps/cli/src/plugins',
    'apps/cli/src/agent',
    'packages/plugins',
  ]);
  for (const file of files) {
    scannedFiles.push(file.filePath);
    for (const specifier of readModuleSpecifiers(file.content)) {
      if (isForbiddenLegacyBackendSpecifier(specifier)) {
        errors.push(`${file.filePath}: forbidden-legacy-backend-dependency: runtime release-contract code must not import legacy host backend modules (${specifier}).`);
      }
    }
  }
  return errors;
}

interface RuntimeSourceFile {
  filePath: string;
  content: string;
}

function collectRuntimeSourceFiles(rootDir: string, scanRoots: readonly string[]): RuntimeSourceFile[] {
  const files: RuntimeSourceFile[] = [];
  for (const scanRoot of scanRoots) {
    const absolutePath = resolve(rootDir, scanRoot);
    if (!existsSync(absolutePath)) continue;
    const stats = statSync(absolutePath);
    if (stats.isFile()) {
      const filePath = normalizeRepoPath(scanRoot);
      if (shouldScanSourceFile(filePath)) {
        files.push({ filePath, content: readFileSync(absolutePath, 'utf8') });
      }
      continue;
    }
    collectRuntimeSourceFilesFromDirectory(rootDir, absolutePath, files);
  }
  return [...new Map(files.map((file) => [file.filePath, file])).values()]
    .sort((left, right) => left.filePath.localeCompare(right.filePath));
}

function collectRuntimeSourceFilesFromDirectory(rootDir: string, directory: string, files: RuntimeSourceFile[]): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      if (!IGNORED_DIRECTORY_NAMES.has(entry.name)) {
        collectRuntimeSourceFilesFromDirectory(rootDir, absolutePath, files);
      }
      continue;
    }
    if (!entry.isFile()) continue;
    const filePath = normalizeRepoPath(absolutePath.slice(resolve(rootDir).length));
    if (!shouldScanSourceFile(filePath)) continue;
    files.push({ filePath, content: readFileSync(absolutePath, 'utf8') });
  }
}

const SOURCE_FILE_PATTERN = /\.[cm]?[jt]sx?$/;
const TEST_FILE_PATTERN = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const IGNORED_DIRECTORY_NAMES = new Set([
  '.expo',
  '.next',
  'build',
  'coverage',
  'dist',
  'generated',
  'node_modules',
  'out',
  'package-dist',
]);

function shouldScanSourceFile(filePath: string): boolean {
  const normalized = normalizeRepoPath(filePath);
  return SOURCE_FILE_PATTERN.test(normalized) && !TEST_FILE_PATTERN.test(normalized);
}

const MODULE_SPECIFIER_PATTERNS = Object.freeze([
  /\bimport\s+(?:type\s+)?(?:[^'"]+\s+from\s+)?['"]([^'"]+)['"]/g,
  /\bexport\s+(?:type\s+)?[^'"]+\s+from\s+['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
]);

function readModuleSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  for (const pattern of MODULE_SPECIFIER_PATTERNS) {
    pattern.lastIndex = 0;
    let match = pattern.exec(source);
    while (match) {
      if (match[1]) {
        specifiers.push(match[1]);
      }
      match = pattern.exec(source);
    }
  }
  return specifiers;
}

function isForbiddenLegacyBackendSpecifier(specifier: string): boolean {
  const normalized = normalizeRepoPath(specifier);
  return normalized === '@/backends'
    || normalized.startsWith('@/backends/')
    || normalized.includes('apps/cli/src/backends/')
    || normalized.startsWith('../backends/')
    || normalized.startsWith('../../backends/')
    || normalized.startsWith('../../../backends/')
    || normalized.startsWith('../../../../backends/')
    || normalized.startsWith('../../../../../backends/');
}

function validateHostProviderCatalogOwnership(rootDir: string, scannedFiles: string[]): string[] {
  const errors: string[] = [];
  const backendsDir = resolve(rootDir, 'apps/cli/src/backends');
  if (existsSync(backendsDir)) {
    errors.push('host-provider-catalog-ownership: apps/cli/src/backends must not exist after F.1/F.3 closure.');
  }

  const hostCatalogPath = 'apps/cli/src/agent/catalog/builtInHostCatalogEntryDefinitions.ts';
  const hostCatalogSource = readOptionalRepoFile(rootDir, hostCatalogPath);
  if (hostCatalogSource === null) {
    return errors;
  }
  scannedFiles.push(hostCatalogPath);
  if (!/BUILT_IN_HOST_CATALOG_ENTRY_DEFINITIONS[\s\S]*Object\.freeze\s*\(\s*\[\s*\]\s*\)/.test(hostCatalogSource)) {
    errors.push(`${hostCatalogPath}: host-provider-catalog-ownership: built-in host catalog definitions must stay empty; provider runtime ownership belongs to plugin projection/runtimeCore.`);
  }
  return errors;
}

function validateGeneratedProjectionBindings(rootDir: string, scannedFiles: string[]): string[] {
  const errors: string[] = [];
  const generatedProjectionPaths = [
    'apps/cli/src/plugins/projection/registry/sources/generatedBundledPlugins.ts',
    'apps/ui/sources/agents/registry/generatedBundledPluginEntries.ts',
    'packages/agents/src/generated/bundledAgentDefinitions.ts',
  ];
  for (const filePath of generatedProjectionPaths) {
    const source = readOptionalRepoFile(rootDir, filePath);
    if (source === null) continue;
    scannedFiles.push(filePath);
    if (/\bbindings\s*:/.test(source)) {
      errors.push(`${filePath}: stale-bundled-plugin-bindings: generated bundled plugin projections must not expose extension-era bindings fields.`);
    }
  }
  return errors;
}

function validatePluginRootRuntimeContributionExports(rootDir: string, scannedFiles: string[]): string[] {
  const errors: string[] = [];
  const pluginsDir = resolve(rootDir, 'packages/plugins');
  if (!existsSync(pluginsDir)) {
    return errors;
  }
  for (const entry of readdirSync(pluginsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const indexPath = `packages/plugins/${entry.name}/src/index.ts`;
    const source = readOptionalRepoFile(rootDir, indexPath);
    if (source === null) continue;
    scannedFiles.push(indexPath);
    if (/export\s+\*\s+from\s+['"]\.\/agent\/contributions\/runtime\.js['"]/.test(source)) {
      errors.push(`${indexPath}: root-entrypoint-runtime-contribution: runtime contribution exports must use the explicit ./agent/contributions/runtime package subpath, not the package root.`);
    }
  }
  return errors;
}

function readOptionalRepoFile(rootDir: string, filePath: string): string | null {
  const absolutePath = resolve(rootDir, filePath);
  if (!existsSync(absolutePath)) return null;
  return readFileSync(absolutePath, 'utf8');
}

function normalizeRepoPath(path: string): string {
  return path.split(/[\\/]+/).filter(Boolean).join('/');
}

function isDirectRun(): boolean {
  return process.argv[1] ? fileURLToPath(import.meta.url) === resolve(process.argv[1]) : false;
}

async function main(): Promise<void> {
  const result = await validateReleaseContract();
  console.log(`runtime-unification release contract: validator_ok=${result.validatorResult.ok} surface_ok=${result.surfaceResult.ok} failed=${result.validatorResult.failedValidators} surface_errors=${result.surfaceResult.errors.length}`);
  for (const validatorResult of result.validatorResult.results) {
    console.log(`${validatorResult.ok ? 'PASS' : 'FAIL'} ${validatorResult.validatorId}`);
    for (const error of validatorResult.errors) {
      console.log(`  - ${error}`);
    }
  }
  for (const error of result.surfaceResult.errors) {
    console.log(`  - ${error}`);
  }
  if (!result.ok) {
    process.exitCode = 1;
  }
}

if (isDirectRun()) {
  void main();
}
