import * as path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';

import { collectFileInventory } from './collectFileInventory.ts';
import { type InventoryFile } from './migrationTypes.ts';

export interface ExtensionImportBoundaryViolation {
  filePath: string;
  specifier: string;
  kind:
    | 'forbidden-alias'
    | 'forbidden-apps-import'
    | 'relative-escape'
    | 'forbidden-protocol-import'
    | 'undeclared-package-dependency';
  details: string;
}

/**
 * These imports predate the public SDK boundary and belong to bounded contexts
 * outside the Agent/model-Provider program. Keep this list exact so new plugin
 * code cannot silently inherit the exception.
 */
const UNRELATED_LEGACY_PROTOCOL_IMPORTS: ReadonlySet<string> = new Set([
  'packages/plugins/elevenlabs/src/agent/voice/provider.ts',
  'packages/plugins/elevenlabs/src/protocol/voice/index.ts',
  'packages/plugins/elevenlabs/src/ui/voice/autoprovision.ts',
  'packages/plugins/elevenlabs/src/ui/voice/client.ts',
  'packages/plugins/elevenlabs/src/ui/voice/runtime/createRuntimeContribution.ts',
  'packages/plugins/elevenlabs/src/ui/voice/runtime/elevenLabsAttemptResources.ts',
  'packages/plugins/elevenlabs/src/ui/voice/runtime/elevenLabsEventMapper.ts',
  'packages/plugins/elevenlabs/src/ui/voice/runtime/elevenLabsProtocolAdapter.ts',
  'packages/plugins/elevenlabs/src/ui/voice/runtime/elevenLabsSdkConnection.ts',
  'packages/plugins/elevenlabs/src/ui/voice/runtime/elevenLabsSessionPreparation.ts',
  'packages/plugins/elevenlabs/src/ui/voice/runtime/elevenLabsSessionTypes.ts',
  'packages/plugins/elevenlabs/src/ui/voice/runtime/realtimeElevenLabsRuntime.ts',
  'packages/plugins/elevenlabs/src/ui/voice/runtime/types.ts',
  'packages/plugins/google/src/protocol/voice/index.ts',
  'packages/plugins/google/src/ui/voice/index.ts',
  'packages/plugins/openai/src/agent/voice/broker.ts',
  'packages/plugins/openai/src/ui/voice/client.ts',
  'packages/plugins/openai/src/ui/voice/connection.ts',
  'packages/plugins/openai/src/ui/voice/createRuntimeContribution.ts',
  'packages/plugins/openai/src/ui/voice/protocolAdapter.ts',
  'packages/plugins/xai/src/agent/voice/broker.ts',
  'packages/plugins/xai/src/ui/voice/client.ts',
  'packages/plugins/xai/src/ui/voice/connection.ts',
  'packages/plugins/xai/src/ui/voice/createRuntimeContribution.ts',
  'packages/plugins/xai/src/ui/voice/protocolAdapter.ts',
] as const);
const NODE_BUILTIN_MODULES: ReadonlySet<string> = new Set(
  builtinModules.flatMap((name) => [name, `node:${name}`]),
);

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

function isProductionPluginSource(filePath: string): boolean {
  return filePath.includes('/src/')
    && !/\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(filePath)
    && !filePath.includes('/__fixtures__/')
    && !filePath.includes('/testkit/');
}

function packageNameForSpecifier(specifier: string): string | null {
  if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('#')) return null;
  if (NODE_BUILTIN_MODULES.has(specifier) || specifier.startsWith('node:') || /^[a-z]+:/u.test(specifier)) return null;
  if (specifier.startsWith('@')) {
    const [scope, name] = specifier.split('/');
    return scope && name ? `${scope}/${name}` : null;
  }
  return specifier.split('/')[0] ?? null;
}

function declaredPackageNames(rootDir: string, packageRoot: string): ReadonlySet<string> {
  const packageJsonPath = path.join(rootDir, packageRoot, 'package.json');
  if (!existsSync(packageJsonPath)) return new Set();
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as Record<string, unknown>;
  const names = new Set<string>();
  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies', 'devDependencies'] as const) {
    const dependencies = packageJson[field];
    if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)) continue;
    for (const name of Object.keys(dependencies)) names.add(name);
  }
  return names;
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

    const productionSource = isProductionPluginSource(filePath);
    const declaredDependencies = productionSource
      ? declaredPackageNames(rootDir, packageRoot)
      : null;

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
        continue;
      }

      if (!productionSource) continue;

      const isProtocolImport = specifier === '@happier-dev/protocol'
        || specifier.startsWith('@happier-dev/protocol/');
      if (isProtocolImport && UNRELATED_LEGACY_PROTOCOL_IMPORTS.has(filePath)) continue;
      if (isProtocolImport) {
        violations.push({
          filePath,
          specifier,
          kind: 'forbidden-protocol-import',
          details: 'Plugin production code must consume public contracts through @happier-dev/plugin-sdk; do not bypass the SDK boundary.',
        });
        continue;
      }

      const packageName = packageNameForSpecifier(specifier);
      if (packageName && !declaredDependencies?.has(packageName)) {
        violations.push({
          filePath,
          specifier,
          kind: 'undeclared-package-dependency',
          details: `Plugin production import resolves through undeclared package ${JSON.stringify(packageName)}.`,
        });
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
