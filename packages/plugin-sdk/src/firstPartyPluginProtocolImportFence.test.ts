import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import ts from 'typescript';

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
  // Scan every production source first, then build a full AST only for the
  // few files whose real module specifier reaches Protocol. This preserves the
  // exhaustive fence without making its runtime depend on every plugin file's
  // AST construction.
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
});
