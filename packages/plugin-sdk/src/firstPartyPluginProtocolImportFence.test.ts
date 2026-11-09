import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import ts from 'typescript';

import { PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1 } from './ui/build/publicToolchainCompatibility.js';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const pluginSourceRoot = join(workspaceRoot, 'packages', 'plugins');
const channelsSourceRoot = join(pluginSourceRoot, 'channels', 'src');
// The API inventory is generated on demand; read the generator's in-memory
// projection of current package source.
const apiSurfaceSourceModulePath: string = '../scripts/apiSurfaceCli.mjs';
type PublicSdkInventory = Readonly<{
  symbols: readonly Readonly<{
    specifier: string;
    exportName: string;
    kind: string;
  }>[];
}>;
// Materialize only when a public-surface assertion needs it. Production import
// fences do not depend on generated API projection being currently buildable.
let publicSdkInventory: Promise<PublicSdkInventory> | undefined;
async function readPublicSdkInventory(): Promise<PublicSdkInventory> {
  return publicSdkInventory ??= (async () => {
    const publisher = await import(apiSurfaceSourceModulePath) as Readonly<{
      readCurrentApiSurfaceInventory(): Promise<PublicSdkInventory>;
    }>;
    return publisher.readCurrentApiSurfaceInventory();
  })();
}
const publicAgentRuntimeEntryPath = join(
  workspaceRoot,
  'packages',
  'plugin-sdk',
  'src',
  'agents',
  'runtime',
  'index.ts',
);

const CHANNELS_RESOURCE_PUBLIC_TYPE_IMPORTS = [
  {
    sourcePath: join(channelsSourceRoot, 'requiredAccountStorage.ts'),
    moduleSpecifier: '@happier-dev/plugin-sdk/storage',
    symbols: ['PluginAccountStorageScope'],
  },
  {
    sourcePath: join(channelsSourceRoot, 'connectionsResource.ts'),
    moduleSpecifier: '@happier-dev/plugin-sdk/resources',
    symbols: [
      'PluginDynamicResourceInvocationOptionsV1',
      'PluginDynamicResourceRuntime',
    ],
  },
] as const;

const FIRST_PARTY_CONNECTED_ACCOUNT_FACT_IMPORTS = [
  {
    sourcePath: join(
      pluginSourceRoot,
      'claude',
      'src',
      'connectedAccounts',
      'claudeSubscriptionProfile.ts',
    ),
    symbols: ['CLAUDE_SUBSCRIPTION_OAUTH_PROFILE'],
  },
  {
    sourcePath: join(pluginSourceRoot, 'claude', 'src', 'manifest.ts'),
    symbols: ['CLAUDE_SUBSCRIPTION_MATERIALIZATION_CONTRACT_V1'],
  },
  {
    sourcePath: join(
      pluginSourceRoot,
      'claude',
      'src',
      'connectedAccounts',
      'claudeSubscriptionRuntime.ts',
    ),
    symbols: ['CLAUDE_SUBSCRIPTION_MATERIALIZATION_CONTRACT_V1'],
  },
  {
    sourcePath: join(
      pluginSourceRoot,
      'pi',
      'src',
      'agent',
      'runtime',
      'qualifiedConnectedAccounts.ts',
    ),
    symbols: [
      'CLAUDE_SUBSCRIPTION_MATERIALIZATION_CONTRACT_V1',
      'CLAUDE_SUBSCRIPTION_SETUP_TOKEN_ENVIRONMENT_REQUEST_V1',
    ],
  },
  {
    sourcePath: join(
      pluginSourceRoot,
      'opencode',
      'src',
      'agent',
      'auth',
      'services',
      'qualifiedPurposeLaunch.ts',
    ),
    symbols: [
      'CLAUDE_SUBSCRIPTION_MATERIALIZATION_CONTRACT_V1',
      'CLAUDE_SUBSCRIPTION_SETUP_TOKEN_ENVIRONMENT_REQUEST_V1',
    ],
  },
  {
    sourcePath: join(
      pluginSourceRoot,
      'ohmypi',
      'src',
      'agent',
      'runtime',
      'engine.ts',
    ),
    symbols: [
      'CLAUDE_SUBSCRIPTION_MATERIALIZATION_CONTRACT_V1',
      'CLAUDE_SUBSCRIPTION_SETUP_TOKEN_ENVIRONMENT_REQUEST_V1',
    ],
  },
  {
    sourcePath: join(
      pluginSourceRoot,
      'ohmypi',
      'src',
      'agent',
      'auth',
      'services',
      'accountPurposes.ts',
    ),
    symbols: ['CLAUDE_SUBSCRIPTION_MATERIALIZATION_CONTRACT_V1'],
  },
  {
    sourcePath: join(
      pluginSourceRoot,
      'codex',
      'src',
      'connectedAccounts',
      'openAiCodexProfile.ts',
    ),
    symbols: ['OPENAI_CODEX_OAUTH_PROFILE'],
  },
  {
    sourcePath: join(
      pluginSourceRoot,
      'codex',
      'src',
      'agent',
      'auth',
      'services',
      'runtime',
      'auth',
      'failure.ts',
    ),
    symbols: ['classifyProviderLimitEvidence'],
  },
  {
    sourcePath: join(
      pluginSourceRoot,
      'codex',
      'src',
      'agent',
      'runtime',
      'appServer',
      'turns',
      'failure.ts',
    ),
    symbols: ['classifyProviderLimitEvidence'],
  },
  {
    sourcePath: join(
      pluginSourceRoot,
      'pi',
      'src',
      'agent',
      'auth',
      'services',
      'requestAuth',
      'source.ts',
    ),
    symbols: ['PROVIDER_LIMIT_EVIDENCE_CLASSIFIER_PROJECTION_V1'],
  },
  {
    sourcePath: join(
      pluginSourceRoot,
      'pi',
      'src',
      'agent',
      'connectedServices',
      'runtimeAuthAdapter.ts',
    ),
    symbols: ['classifyProviderLimitEvidence'],
  },
  {
    sourcePath: join(
      pluginSourceRoot,
      'pi',
      'src',
      'agent',
      'runtime',
      'rpc',
      'providerFailureDiagnostic.ts',
    ),
    symbols: ['classifyProviderLimitEvidence'],
  },
  {
    sourcePath: join(
      workspaceRoot,
      'apps',
      'cli',
      'src',
      'daemon',
      'connectedServices',
      'quotas',
      'normalization',
      'classifyProviderLimitEvidence.ts',
    ),
    symbols: ['classifyProviderLimitEvidence'],
  },
] as const;

const FIRST_PARTY_CONNECTED_ACCOUNT_CONSUMER_PLUGIN_IDS = [
  'claude',
  'codex',
  'pi',
  'opencode',
  'ohmypi',
] as const;

const TEST_ONLY_PRIVATE_AGENT_PACKAGE_PLUGIN_IDS = [
  'claude',
  'opencode',
  'pi',
] as const;

const AGENT_RUNTIME_EVENT_TEST_IMPORTS = {
  'packages/plugins/opencode/src/agent/runtime/server/sessionRuntime.native.test.ts': [
    'AgentSessionRuntimeEventSchema',
  ],
  'packages/plugins/pi/src/agent/runtime/rpc/operations.test.ts': [
    'AgentSessionRuntimeEventSchema',
  ],
} as const;

const GENERIC_REQUEST_AUTH_PUBLIC_VALUE_IMPORTS = [
  {
    sourcePath: join(
      pluginSourceRoot,
      'pi',
      'src',
      'agent',
      'auth',
      'services',
      'requestAuth',
      'env.ts',
    ),
    symbols: ['CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH_ENV'],
  },
  {
    sourcePath: join(
      pluginSourceRoot,
      'pi',
      'src',
      'agent',
      'auth',
      'services',
      'requestAuth',
      'assets.ts',
    ),
    symbols: [
      'CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH_ENV',
      'buildConnectedAccountRequestAuthClientSource',
    ],
  },
  {
    sourcePath: join(
      pluginSourceRoot,
      'opencode',
      'src',
      'agent',
      'auth',
      'services',
      'requestAuth',
      'env.ts',
    ),
    symbols: ['CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH_ENV'],
  },
  {
    sourcePath: join(
      pluginSourceRoot,
      'opencode',
      'src',
      'agent',
      'auth',
      'services',
      'requestAuth',
      'assets.ts',
    ),
    symbols: [
      'CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH_ENV',
      'buildConnectedAccountRequestAuthClientSource',
    ],
  },
] as const;

const GENERIC_SESSION_AND_PROMPT_PUBLIC_IMPORTS = [
  {
    sourcePath: join(
      pluginSourceRoot,
      'claude',
      'src',
      'agent',
      'workflowRecords',
      'workflowRuntime.ts',
    ),
    symbols: [
      'SessionSystemRecordReadRequestV1',
      'SessionSystemRecordReadResultV1',
      'SessionSystemRecordWriteRequestV1',
    ],
  },
  {
    sourcePath: join(
      pluginSourceRoot,
      'claude',
      'src',
      'agent',
      'runtime',
      'terminal',
      'unified',
      'turnOperations.ts',
    ),
    symbols: ['isNonSteerablePromptPayload', 'parseSpecialCommand'],
  },
] as const;

function isProtocolModulePath(value: string): boolean {
  return value === '@happier-dev/protocol' || value.startsWith('@happier-dev/protocol/');
}

function isProtocolModuleSpecifier(value: ts.Expression | undefined): value is ts.StringLiteral {
  return Boolean(value && ts.isStringLiteral(value) && isProtocolModulePath(value.text));
}

function protocolImportNames(
  source: string,
  path: string,
  rootValuesOnly = false,
): readonly string[] {
  // Pre-process first and build a full AST only for a real dependency edge.
  if (!ts.preProcessFile(source, true, true).importedFiles.some(entry => (
    rootValuesOnly ? entry.fileName === '@happier-dev/protocol' : isProtocolModulePath(entry.fileName)
  ))) return [];
  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  const importedSymbols: string[] = [];
  const matches = (value: ts.Expression | undefined): value is ts.StringLiteral => (
    rootValuesOnly
      ? Boolean(value && ts.isStringLiteral(value) && value.text === '@happier-dev/protocol')
      : isProtocolModuleSpecifier(value)
  );
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) {
      if (!matches(statement.moduleSpecifier)
        || (rootValuesOnly && statement.importClause?.isTypeOnly)) continue;
      const bindings = statement.importClause?.namedBindings;
      if (!bindings || !ts.isNamedImports(bindings) || statement.importClause?.name) {
        importedSymbols.push('<non-named-import>');
        continue;
      }
      if (rootValuesOnly && bindings.elements.length === 0) importedSymbols.push('<empty-import>');
      importedSymbols.push(...bindings.elements
        .filter(element => !rootValuesOnly || !element.isTypeOnly)
        .map(element => element.propertyName?.text ?? element.name.text));
      continue;
    }
    if (ts.isExportDeclaration(statement)) {
      if (!matches(statement.moduleSpecifier) || (rootValuesOnly && statement.isTypeOnly)) continue;
      if (!statement.exportClause || !ts.isNamedExports(statement.exportClause)) {
        importedSymbols.push('<non-named-import>');
        continue;
      }
      if (rootValuesOnly && statement.exportClause.elements.length === 0) importedSymbols.push('<empty-export>');
      importedSymbols.push(...statement.exportClause.elements
        .filter(element => !rootValuesOnly || !element.isTypeOnly)
        .map(element => element.propertyName?.text ?? element.name.text));
    }
    if (rootValuesOnly && ts.isImportEqualsDeclaration(statement)
      && !statement.isTypeOnly && ts.isExternalModuleReference(statement.moduleReference)
      && matches(statement.moduleReference.expression)) importedSymbols.push('<import-equals>');
  }
  if (rootValuesOnly) {
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && matches(node.arguments[0])
        && (node.expression.kind === ts.SyntaxKind.ImportKeyword
          || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
        importedSymbols.push(node.expression.kind === ts.SyntaxKind.ImportKeyword ? '<dynamic-import>' : '<require>');
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return importedSymbols;
}

async function readProtocolImports(path: string): Promise<readonly string[]> {
  return protocolImportNames(await readFile(path, 'utf8'), path);
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

async function readNamedImportsOrExports(
  path: string,
  moduleSpecifier: string,
): Promise<readonly string[]> {
  const source = await readFile(path, 'utf8');
  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const names: string[] = [];
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      if (statement.moduleSpecifier.text !== moduleSpecifier) continue;
      const bindings = statement.importClause?.namedBindings;
      if (!bindings || !ts.isNamedImports(bindings) || statement.importClause?.name) {
        names.push('<non-named-import>');
        continue;
      }
      names.push(...bindings.elements.map((element) => element.propertyName?.text ?? element.name.text));
      continue;
    }
    if (ts.isExportDeclaration(statement)
      && statement.moduleSpecifier
      && ts.isStringLiteral(statement.moduleSpecifier)) {
      if (statement.moduleSpecifier.text !== moduleSpecifier) continue;
      if (!statement.exportClause || !ts.isNamedExports(statement.exportClause)) {
        names.push('<non-named-export>');
        continue;
      }
      names.push(...statement.exportClause.elements.map((element) => element.propertyName?.text ?? element.name.text));
    }
  }
  return names;
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
  const inventory = await readPublicSdkInventory();
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

async function readPublicSdkValueOwners(symbols: readonly string[]): Promise<Readonly<Record<string, string>>> {
  const inventory = await readPublicSdkInventory();
  return Object.fromEntries(symbols.map((symbol) => {
    const owners = inventory.symbols.filter((entry) => (
      entry.exportName === symbol && entry.kind === 'value'
    ));
    if (owners.length !== 1) {
      throw new Error(`Expected one public SDK value owner for ${symbol}, found ${owners.length}`);
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
const EXPECTED_PLUGIN_RUNTIME_HOST_PACKAGE_REACHES: Readonly<Record<string, readonly string[]>> = {};

/** The Happier packages the plugin scaffold actually installs for an author. */
function readAuthorReachableHappierPackages(): ReadonlySet<string> {
  return new Set(
    Object.keys(PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1.dependencies)
      .filter((name) => name.startsWith('@happier-dev/')),
  );
}

async function readHostWorkspacePackageNames(): Promise<readonly string[]> {
  const packagesRoot = join(workspaceRoot, 'packages');
  const names = await Promise.all((await readdir(packagesRoot, { withFileTypes: true })).map(async (entry) => {
    if (!entry.isDirectory() || entry.name === 'plugins' || entry.name === 'node_modules') return null;
    let manifest: Readonly<{ name?: unknown; private?: unknown }>;
    try {
      manifest = JSON.parse(await readFile(join(packagesRoot, entry.name, 'package.json'), 'utf8'));
    } catch {
      return null;
    }
    return manifest.private === true && typeof manifest.name === 'string' ? manifest.name : null;
  }));
  return names.filter((name): name is string => name !== null);
}

async function readPluginRuntimeSourcePaths(directory: string, includeTestSupport = false): Promise<readonly string[]> {
  const paths = await Promise.all((await readdir(directory, { withFileTypes: true })).map(async (entry) => {
    if (entry.name === 'node_modules' || entry.name === 'dist') return [];
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return await readPluginRuntimeSourcePaths(path, includeTestSupport);
    }
    if (!/\.tsx?$/u.test(entry.name)) return [];
    if (/\.(?:test|testkit)\.tsx?$/u.test(entry.name)) return [];
    if (!includeTestSupport && /\.test-support\.tsx?$/u.test(entry.name)) return [];
    return [path];
  }));
  return paths.flat();
}

function isCanonicalBuildTimeClaudePredecessorBridgeImport(
  path: string,
  source: string,
  specifier: string,
): boolean {
  // generateBundledPluginEntries.ts#loadPluginAgentPredecessorMessageMetaWriter
  // projects JSON defaults and the Protocol writer; it never emits this plugin import.
  if (path !== join(pluginSourceRoot, 'claude', 'src', 'ui', 'predecessorMessageMeta.ts')
    || specifier !== '@happier-dev/protocol/agents/claude/predecessor-message-meta') return false;
  if (ts.preProcessFile(source, true, false).importedFiles.filter(
    (entry) => entry.fileName === specifier,
  ).length !== 1) return false;
  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  const declaration = sourceFile.statements.find((statement) => (
    ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)
      && statement.moduleSpecifier.text === specifier
  ));
  if (!declaration || !ts.isImportDeclaration(declaration)) return false;
  const bindings = declaration.importClause?.namedBindings;
  return declaration.importClause?.isTypeOnly === false
    && declaration.importClause.name === undefined
    && bindings !== undefined && ts.isNamedImports(bindings)
    && bindings.elements.length === 1
    && (bindings.elements[0]?.propertyName ?? bindings.elements[0]?.name)?.text
      === 'buildClaudePredecessorMessageMeta';
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
  const hostPackageSet = new Set(hostPackages);
  const reaches: Record<string, Set<string>> = {};
  await Promise.all((await readdir(pluginSourceRoot, { withFileTypes: true })).map(async (entry) => {
    if (!entry.isDirectory() || entry.name === 'node_modules') return;
    const sourceRoot = join(pluginSourceRoot, entry.name, 'src');
    try {
      await readdir(sourceRoot);
    } catch {
      return;
    }
    const sources = await Promise.all((await readPluginRuntimeSourcePaths(sourceRoot)).map(async (path) => ({
      path,
      source: await readFile(path, 'utf8'),
    })));
    for (const { path, source } of sources) {
      if (!source.includes('@happier-dev/')) continue;
      for (const imported of ts.preProcessFile(source, true, false).importedFiles) {
        const owner = imported.fileName.split('/').slice(0, 2).join('/');
        if (!hostPackageSet.has(owner)) continue;
        if (isCanonicalBuildTimeClaudePredecessorBridgeImport(path, source, imported.fileName)) continue;
        (reaches[entry.name] ??= new Set()).add(imported.fileName);
      }
    }
  }));
  return Object.fromEntries(
    Object.keys(reaches).sort().map((plugin) => [plugin, [...reaches[plugin]!].sort()]),
  );
}

let measuredPluginRuntimeHostPackageReaches:
  Promise<Readonly<Record<string, readonly string[]>>> | undefined;

function readMeasuredPluginRuntimeHostPackageReaches(): Promise<Readonly<Record<string, readonly string[]>>> {
  return measuredPluginRuntimeHostPackageReaches ??= measurePluginRuntimeHostPackageReaches(
    readAuthorReachableHappierPackages(),
  );
}

describe('first-party plugin public SDK import fence', () => {
  it('allows type-only Protocol root dependencies while recognizing runtime dependency edges', () => {
    for (const source of [
      "import type { Fact } from '@happier-dev/protocol'; export type { Fact } from '@happier-dev/protocol';",
      "import { type Fact } from '@happier-dev/protocol'; export { type Fact } from '@happier-dev/protocol';",
      "type Fact = import('@happier-dev/protocol').Fact;",
    ]) expect(protocolImportNames(source, 'fixture.ts', true), source).toEqual([]);
    for (const source of [
      "import { fact } from '@happier-dev/protocol';",
      "export { fact } from '@happier-dev/protocol';",
      "import '@happier-dev/protocol';",
      "import('@happier-dev/protocol');",
      "import facts = require('@happier-dev/protocol');",
      "require('@happier-dev/protocol');",
    ]) expect(protocolImportNames(source, 'fixture.ts', true), source).not.toEqual([]);
  });

  it('keeps SDK and plugin production values off the Protocol root entrypoint', async () => {
    const sdkPaths = await readPluginRuntimeSourcePaths(join(workspaceRoot, 'packages', 'plugin-sdk', 'src'), true);
    const pluginPaths = (await Promise.all(
      (await readdir(pluginSourceRoot, { withFileTypes: true }))
        .filter(entry => entry.isDirectory() && entry.name !== 'node_modules')
        .map(async entry => {
          const sourceRoot = join(pluginSourceRoot, entry.name, 'src');
          try {
            return await readPluginRuntimeSourcePaths(sourceRoot, true);
          } catch (error) {
            if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
            throw error;
          }
        }),
    )).flat();
    const violations = (await Promise.all([...sdkPaths, ...pluginPaths].map(async path => {
      const values = protocolImportNames(await readFile(path, 'utf8'), path, true);
      return values.length > 0 ? { path: path.slice(workspaceRoot.length + 1), values } : null;
    }))).filter(value => value !== null).sort((left, right) => left.path.localeCompare(right.path));
    expect(violations).toEqual([]);
  }, 20_000);

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

    for (const { sourcePath, moduleSpecifier, symbols } of CHANNELS_RESOURCE_PUBLIC_TYPE_IMPORTS) {
      expect(await readNamedImports(sourcePath, moduleSpecifier))
        .toEqual(expect.arrayContaining([...symbols]));
    }
    const rootImports = await readNamedImports(
      join(channelsSourceRoot, 'connectionsResource.ts'),
      '@happier-dev/plugin-sdk',
    );
    for (const symbol of Object.keys(expectedOwners)) {
      expect(rootImports).not.toContain(symbol);
    }
  });

  it('keeps canonical Agent facts outside the SDK and generic evidence on its public owner', async () => {
    const genericEvidenceTypes = [
      'ProviderLimitCategory',
      'ProviderLimitEvidenceClassification',
      'ProviderLimitEvidenceConfidence',
      'ProviderLimitEvidenceContext',
      'ProviderLimitEvidenceProvenance',
    ];
    const genericEvidenceValues = [
      'PROVIDER_LIMIT_EVIDENCE_CLASSIFIER_PROJECTION_V1',
      'classifyProviderLimitEvidence',
    ];
    const inventory = await readPublicSdkInventory();
    for (const [kind, names] of [
      ['type', genericEvidenceTypes], ['value', genericEvidenceValues],
    ] as const) {
      for (const name of names) {
        expect(inventory.symbols.filter((entry) => entry.kind === kind && entry.exportName === name)
          .map((entry) => entry.specifier).sort(), name).toEqual([
          './connected-accounts',
        ]);
      }
    }

    // The compatibility projection already records each canonical Agent leaf;
    // derive consumer ownership from it rather than duplicating that export list.
    const projectionPath = join(workspaceRoot, 'packages/plugin-sdk/src/connectedAccounts.ts');
    const projection = ts.createSourceFile(
      projectionPath, await readFile(projectionPath, 'utf8'), ts.ScriptTarget.Latest, true,
    );
    const agentFactOwners = new Map(projection.statements.flatMap((statement) => {
      if (!ts.isExportDeclaration(statement)
        || !statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier)
        || !statement.moduleSpecifier.text.startsWith('@happier-dev/protocol/agents/')
        || !statement.exportClause || !ts.isNamedExports(statement.exportClause)) return [];
      const owner = statement.moduleSpecifier.text;
      return statement.exportClause.elements.map((element) => [element.name.text, owner] as const);
    }));
    for (const { sourcePath, symbols } of FIRST_PARTY_CONNECTED_ACCOUNT_FACT_IMPORTS) {
      for (const symbol of symbols) {
        const isGenericEvidence = genericEvidenceValues.includes(symbol);
        const owner = isGenericEvidence
          ? '@happier-dev/plugin-sdk/connected-accounts'
          : agentFactOwners.get(symbol);
        expect(owner, symbol).toBeDefined();
        if (!isGenericEvidence) expect(owner, symbol).toMatch(/^@happier-dev\/protocol\/agents\/[^/]+\//u);
        expect(await readNamedImportsOrExports(sourcePath, owner!)).toContain(symbol);
        if (!isGenericEvidence) {
          expect(await readNamedImportsOrExports(
            sourcePath, '@happier-dev/plugin-sdk/connected-accounts',
          )).not.toContain(symbol);
        }
      }
      expect(await readNamedImportsOrExports(
        sourcePath, '@happier-dev/plugin-sdk/first-party/connected-accounts',
      )).toEqual([]);
      expect(await readNamedImports(
        sourcePath,
        '@happier-dev/protocol/connect/claude-subscription-materialization',
      )).toEqual([]);
    }

    for (const pluginId of FIRST_PARTY_CONNECTED_ACCOUNT_CONSUMER_PLUGIN_IDS) {
      const manifest = JSON.parse(await readFile(
        join(pluginSourceRoot, pluginId, 'package.json'),
        'utf8',
      )) as Readonly<{
        dependencies?: Readonly<Record<string, string>>;
      }>;
      expect(manifest.dependencies?.['@happier-dev/plugin-sdk']).toBe('0.0.0');
    }
  });

  it('routes generic request-auth, Session-record, and prompt helpers through narrow public SDK domains', async () => {
    for (const { sourcePath, symbols } of GENERIC_REQUEST_AUTH_PUBLIC_VALUE_IMPORTS) {
      expect(await readNamedImports(
        sourcePath,
        '@happier-dev/plugin-sdk/connected-accounts',
      )).toEqual(expect.arrayContaining([...symbols]));
      expect(await readNamedImports(sourcePath, '@happier-dev/agents/request-auth')).toEqual([]);
    }

    for (const { sourcePath, symbols } of GENERIC_SESSION_AND_PROMPT_PUBLIC_IMPORTS) {
      expect(await readNamedImports(sourcePath, '@happier-dev/plugin-sdk/sessions'))
        .toEqual(expect.arrayContaining([...symbols]));
      expect(await readNamedImports(sourcePath, '@happier-dev/agents')).toEqual([]);
    }
  });

  it('keeps every first-party plugin runtime source inside the public author toolchain', async () => {
    const authorPackages = readAuthorReachableHappierPackages();
    expect([...authorPackages].sort()).toEqual([
      '@happier-dev/plugin-sdk',
      '@happier-dev/plugin-ui',
    ]);

    const measured = Object.fromEntries(
      Object.entries(await readMeasuredPluginRuntimeHostPackageReaches())
        .map(([plugin, specifiers]) => [
          plugin,
          specifiers.filter((specifier) => !isProtocolModulePath(specifier)),
        ] as const)
        .filter(([, specifiers]) => specifiers.length > 0),
    );
    expect(measured).toEqual(EXPECTED_PLUGIN_RUNTIME_HOST_PACKAGE_REACHES);
    // This is the one full first-party-plugin source inventory. Under shared
    // compiler/build contention it exceeded Vitest's 5s default (7.545s
    // observed), so retain a bounded allowance without weakening the fence.
  }, 20_000);

  it('keeps the private Agent package test-only in plugins whose shipped source does not import it', async () => {
    for (const pluginId of TEST_ONLY_PRIVATE_AGENT_PACKAGE_PLUGIN_IDS) {
      const packageJson = JSON.parse(await readFile(
        join(pluginSourceRoot, pluginId, 'package.json'),
        'utf8',
      )) as Readonly<{
        dependencies?: Readonly<Record<string, string>>;
        devDependencies?: Readonly<Record<string, string>>;
      }>;
      expect(packageJson.dependencies?.['@happier-dev/agents']).toBeUndefined();
      expect(packageJson.devDependencies?.['@happier-dev/agents']).toBe('0.0.0');
    }

    const claudeTsconfig = JSON.parse(await readFile(
      join(pluginSourceRoot, 'claude', 'tsconfig.json'),
      'utf8',
    )) as Readonly<{ exclude?: readonly string[] }>;
    expect(claudeTsconfig.exclude).toContain('src/**/*.testkit.ts');
  });

  it('keeps first-party Agent and Provider facts on exported Protocol subpaths', async () => {
    const protocolManifest = JSON.parse(await readFile(
      join(workspaceRoot, 'packages', 'protocol', 'package.json'),
      'utf8',
    )) as Readonly<{ exports: Readonly<Record<string, unknown>> }>;
    const reaches = await readMeasuredPluginRuntimeHostPackageReaches();
    for (const specifier of new Set(Object.values(reaches).flat())) {
      if (!isProtocolModulePath(specifier)) continue;
      const subpath = specifier === '@happier-dev/protocol'
        ? '.'
        : `.${specifier.slice('@happier-dev/protocol'.length)}`;
      expect(Object.hasOwn(protocolManifest.exports, subpath), specifier).toBe(true);
    }
  });
});
