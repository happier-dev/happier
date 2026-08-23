import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import ts from 'typescript';

import { PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1 } from './ui/build/publicToolchainCompatibility.js';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const pluginSourceRoot = join(workspaceRoot, 'packages', 'plugins');
const channelsConnectionsResourceSource = join(
  pluginSourceRoot,
  'channels',
  'src',
  'connectionsResource.ts',
);
const apiSurfaceInventoryPath = join(workspaceRoot, 'packages', 'plugin-sdk', 'api-surface.json');
const publicAgentRuntimeEntryPath = join(
  workspaceRoot,
  'packages',
  'plugin-sdk',
  'src',
  'agents',
  'runtime',
  'index.ts',
);

const CHANNELS_RESOURCE_PUBLIC_TYPE_IMPORTS = {
  '@happier-dev/plugin-sdk/storage': ['PluginAccountStorageScope'],
  '@happier-dev/plugin-sdk/resources': [
    'PluginDynamicResourceInvocationOptionsV1',
    'PluginDynamicResourceRuntime',
  ],
} as const;

const AGENT_RUNTIME_EVENT_TEST_IMPORTS = {
  'packages/plugins/antigravity/src/agent/cliPrint/runtime.test.ts': [
    'AgentSessionRuntimeEventSchema',
  ],
  'packages/plugins/antigravity/src/agent/localharness/runtime/sessionRuntime.test.ts': [
    'AgentSessionRuntimeEventSchema',
  ],
} as const;

function isProtocolModulePath(value: string): boolean {
  return value === '@happier-dev/protocol' || value.startsWith('@happier-dev/protocol/');
}

function isProtocolModuleSpecifier(value: ts.Expression | undefined): value is ts.StringLiteral {
  return Boolean(value && ts.isStringLiteral(value) && isProtocolModulePath(value.text));
}

async function readProtocolImports(path: string): Promise<readonly string[]> {
  const source = await readFile(path, 'utf8');
  // Pre-process first and build a full AST only when a real module specifier
  // reaches Protocol, so naming the package in a comment neither counts as a
  // reach nor costs an AST.
  if (!ts.preProcessFile(source, true, true).importedFiles.some((entry) => (
    isProtocolModulePath(entry.fileName)
  ))) return [];
  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  const importedSymbols: string[] = [];
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) {
      if (!isProtocolModuleSpecifier(statement.moduleSpecifier)) continue;
      const bindings = statement.importClause?.namedBindings;
      if (!bindings || !ts.isNamedImports(bindings) || statement.importClause?.name) {
        importedSymbols.push('<non-named-import>');
        continue;
      }
      importedSymbols.push(...bindings.elements.map((element) => (
        element.propertyName?.text ?? element.name.text
      )));
      continue;
    }
    if (ts.isExportDeclaration(statement)) {
      if (!isProtocolModuleSpecifier(statement.moduleSpecifier)) continue;
      if (!statement.exportClause || !ts.isNamedExports(statement.exportClause)) {
        importedSymbols.push('<non-named-import>');
        continue;
      }
      importedSymbols.push(...statement.exportClause.elements.map((element) => (
        element.propertyName?.text ?? element.name.text
      )));
    }
  }
  return importedSymbols;
}

async function readNamedImports(path: string, moduleSpecifier: string): Promise<readonly string[]> {
  const source = await readFile(path, 'utf8');
  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const importedSymbols: string[] = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (statement.moduleSpecifier.text !== moduleSpecifier) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings) || statement.importClause?.name) {
      importedSymbols.push('<non-named-import>');
      continue;
    }
    importedSymbols.push(...bindings.elements.map((element) => (
      element.propertyName?.text ?? element.name.text
    )));
  }
  return importedSymbols;
}

async function readNamedExports(path: string): Promise<readonly string[]> {
  const source = await readFile(path, 'utf8');
  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const exportedSymbols: string[] = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isExportDeclaration(statement) || !statement.exportClause) continue;
    if (ts.isNamedExports(statement.exportClause)) {
      exportedSymbols.push(...statement.exportClause.elements.map((element) => element.name.text));
      continue;
    }
    if (ts.isNamespaceExport(statement.exportClause)) {
      exportedSymbols.push(statement.exportClause.name.text);
    }
  }
  return exportedSymbols;
}

async function readPublicSdkOwners(symbols: readonly string[]): Promise<Readonly<Record<string, string>>> {
  const inventory = JSON.parse(await readFile(apiSurfaceInventoryPath, 'utf8')) as Readonly<{
    symbols: readonly Readonly<{
      specifier: string;
      exportName: string;
      kind: string;
    }>[];
  }>;
  return Object.fromEntries(symbols.map((symbol) => {
    const owners = inventory.symbols.filter((entry) => (
      entry.exportName === symbol && entry.kind === 'type'
    ));
    if (owners.length !== 1) {
      throw new Error(`Expected one public SDK owner for ${symbol}, found ${owners.length}`);
    }
    return [symbol, owners[0]!.specifier];
  }));
}

/**
 * The host workspace packages a first-party plugin runtime source still reaches,
 * keyed by plugin directory.
 *
 * The public plugin toolchain binds an external author to
 * `@happier-dev/plugin-sdk` (and `@happier-dev/plugin-ui` for a React Native UI
 * plugin) and to no other Happier package, so every specifier listed here is a
 * capability a bundled plugin has and an external one cannot reach. Shrinking
 * this map is the work; a new reach is a C1 regression and fails the fence
 * below instead of landing silently.
 */
const EXPECTED_PLUGIN_RUNTIME_HOST_PACKAGE_REACHES: Readonly<Record<string, readonly string[]>> = {
  // Claude Agent policy the Claude plugin owns end to end, plus the one
  // host-recognised dialog-choice discriminant. `apps/cli`'s permission handler
  // and `apps/ui`'s AskUserQuestion renderer read that exact string, so Protocol
  // is its only shared owner; an external plugin declares its own request source
  // rather than emitting another plugin's identity.
  claude: [
    '@happier-dev/agents',
    '@happier-dev/agents/providers/claude-model-options',
    '@happier-dev/protocol/agents/claude',
  ],
  opencode: ['@happier-dev/agents/request-auth'],
  pi: ['@happier-dev/agents/request-auth'],
};

/** The Happier packages the plugin scaffold actually installs for an author. */
function readAuthorReachableHappierPackages(): ReadonlySet<string> {
  return new Set(
    Object.keys(PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1.dependencies)
      .filter((name) => name.startsWith('@happier-dev/')),
  );
}

async function readHostWorkspacePackageNames(): Promise<readonly string[]> {
  const packagesRoot = join(workspaceRoot, 'packages');
  const names: string[] = [];
  for (const entry of await readdir(packagesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'plugins' || entry.name === 'node_modules') continue;
    let manifest: Readonly<{ name?: unknown; private?: unknown }>;
    try {
      manifest = JSON.parse(await readFile(join(packagesRoot, entry.name, 'package.json'), 'utf8'));
    } catch {
      continue;
    }
    if (manifest.private !== true || typeof manifest.name !== 'string') continue;
    names.push(manifest.name);
  }
  return names;
}

async function* walkPluginRuntimeSources(directory: string): AsyncGenerator<string> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      yield* walkPluginRuntimeSources(path);
      continue;
    }
    if (!/\.tsx?$/u.test(entry.name)) continue;
    if (/\.(?:test|test-support|testkit)\.tsx?$/u.test(entry.name)) continue;
    yield path;
  }
}

/**
 * Every host workspace package specifier reached from a first-party plugin's
 * shipped sources. Module specifiers come from the TypeScript pre-processor, so
 * a package name mentioned inside a comment is not counted as a reach.
 */
async function measurePluginRuntimeHostPackageReaches(
  authorPackages: ReadonlySet<string>,
): Promise<Readonly<Record<string, readonly string[]>>> {
  const hostPackages = (await readHostWorkspacePackageNames())
    .filter((name) => !authorPackages.has(name));
  const reaches: Record<string, Set<string>> = {};
  for (const entry of await readdir(pluginSourceRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'node_modules') continue;
    const sourceRoot = join(pluginSourceRoot, entry.name, 'src');
    try {
      await readdir(sourceRoot);
    } catch {
      continue;
    }
    for await (const path of walkPluginRuntimeSources(sourceRoot)) {
      const source = await readFile(path, 'utf8');
      for (const imported of ts.preProcessFile(source, true, true).importedFiles) {
        const owner = hostPackages.find((name) => (
          imported.fileName === name || imported.fileName.startsWith(`${name}/`)
        ));
        if (!owner) continue;
        (reaches[entry.name] ??= new Set()).add(imported.fileName);
      }
    }
  }
  return Object.fromEntries(
    Object.keys(reaches).sort().map((plugin) => [plugin, [...reaches[plugin]!].sort()]),
  );
}

describe('first-party plugin public SDK import fence', () => {
  it('keeps first-party Agent runtime event tests on the canonical public SDK entrypoint', async () => {
    for (const [relativePath, expectedImports] of Object.entries(AGENT_RUNTIME_EVENT_TEST_IMPORTS)) {
      const sourcePath = join(workspaceRoot, relativePath);
      expect(await readProtocolImports(sourcePath)).not.toContain('AgentSessionRuntimeEventV1Schema');
      expect(await readNamedImports(sourcePath, '@happier-dev/plugin-sdk/agents/runtime'))
        .toEqual(expect.arrayContaining([...expectedImports]));
    }
  });

  it('keeps the public Agent runtime vocabulary Agent-oriented while retaining qualified Provider bindings', async () => {
    const exports = await readNamedExports(publicAgentRuntimeEntryPath);
    const retiredExecutableAliases = new Set([
      'AcpSessionRuntimeV1',
      'AgentRuntimeV1',
      'AgentSessionRuntimeEventV1',
      'AgentSessionRuntimeEventV1Schema',
      'ExecutionRunBackend',
      'ExecutionRunBackendV1',
      'RuntimeControlContribution',
      'RuntimeCoreV1',
      'RuntimeEventV1',
      'RuntimeEventV1Schema',
    ]);
    const vocabularyViolations = exports.filter((name) => (
      retiredExecutableAliases.has(name)
      || name === 'Provider'
      || name === 'ProviderRuntime'
      || name === 'ProviderSessionRuntime'
    ));

    expect(vocabularyViolations).toEqual([]);
  });

  it('keeps the Channels Account-backed Resource consumer on inventory-owned SDK author paths', async () => {
    const expectedOwners = {
      PluginAccountStorageScope: '@happier-dev/plugin-sdk/storage',
      PluginDynamicResourceInvocationOptionsV1: '@happier-dev/plugin-sdk/resources',
      PluginDynamicResourceRuntime: '@happier-dev/plugin-sdk/resources',
    };
    expect(await readPublicSdkOwners(Object.keys(expectedOwners))).toEqual({
      PluginAccountStorageScope: './storage',
      PluginDynamicResourceInvocationOptionsV1: './resources',
      PluginDynamicResourceRuntime: './resources',
    });

    for (const [moduleSpecifier, expectedSymbols] of Object.entries(
      CHANNELS_RESOURCE_PUBLIC_TYPE_IMPORTS,
    )) {
      expect(await readNamedImports(channelsConnectionsResourceSource, moduleSpecifier))
        .toEqual(expect.arrayContaining([...expectedSymbols]));
    }
    const rootImports = await readNamedImports(
      channelsConnectionsResourceSource,
      '@happier-dev/plugin-sdk',
    );
    for (const symbol of Object.keys(expectedOwners)) {
      expect(rootImports).not.toContain(symbol);
    }
  });

  it('keeps every first-party plugin runtime source inside the public author toolchain', async () => {
    const authorPackages = readAuthorReachableHappierPackages();
    expect([...authorPackages].sort()).toEqual([
      '@happier-dev/plugin-sdk',
      '@happier-dev/plugin-ui',
    ]);

    const measured = await measurePluginRuntimeHostPackageReaches(authorPackages);
    expect(measured).toEqual(EXPECTED_PLUGIN_RUNTIME_HOST_PACKAGE_REACHES);
  });

  it('keeps Protocol out of first-party plugin runtime sources apart from the host-recognised Claude dialog source', async () => {
    const reaches = await measurePluginRuntimeHostPackageReaches(
      readAuthorReachableHappierPackages(),
    );
    const protocolReaches = Object.fromEntries(
      Object.entries(reaches)
        .map(([plugin, specifiers]) => [
          plugin,
          specifiers.filter((specifier) => isProtocolModulePath(specifier)),
        ] as const)
        .filter(([, specifiers]) => specifiers.length > 0),
    );
    expect(Object.keys(protocolReaches)).toEqual(['claude']);

    const symbols = await readProtocolImports(join(
      pluginSourceRoot,
      'claude/src/agent/runtime/terminal/unified/resumeChoice/startup.ts',
    ));
    expect(symbols).toEqual(['CLAUDE_UNIFIED_TERMINAL_DIALOG_CHOICE_REQUEST_SOURCE']);
  });
});
