import {
    mkdirSync,
    mkdtempSync,
    readdirSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import ts from 'typescript';

/* @sdk-negative-type-case:src-normalSurfaceContract-test-ts-34:LS0gdGhlIGNhbm9uaWNhbCB2YWxpZGF0b3IgaXMgY2hlY2tlZCBKYXZhU2NyaXB0IHdpdGhvdXQgZW1pdHRlZCBkZWNsYXJhdGlvbnMu:aW1wb3J0IHsgcmVhZFZhbGlkYXRlZEFwaVN1cmZhY2VJbnZlbnRvcnlJZlByZXNlbnQgfSBmcm9tICcuLi9zY3JpcHRzL2FwaVN1cmZhY2UubWpzJzs */
const apiSurfaceValidatorModulePath: string = '../scripts/apiSurface.mjs';
const readValidatedApiSurfaceInventoryIfPresent = (
    await import(apiSurfaceValidatorModulePath) as Readonly<{
        readValidatedApiSurfaceInventoryIfPresent(
            url: URL,
        ): Promise<Readonly<{ status: 'available'; inventory: never } | { status: 'missing' }>>;
    }>
).readValidatedApiSurfaceInventoryIfPresent; /* @sdk-negative-type-case-end */

import {
    AGENT_RUNTIME_TERMINAL_AUTHOR_CONTRACT,
    projectAuthorSurfaceContract,
    requireApiSurfaceInventory,
} from './normalSurfaceContract.js';

type AuthorExportIdentity = Readonly<{
    exportName: string;
    sourceIdentity: string;
    nestedPropertyNames?: readonly string[];
}>;

const PRIVACY_AMENDMENT_GATED_EXPORTS = [
] as const;

const PRIVACY_AMENDMENT_GATED_SESSION_HANDLE_MEMBERS = [
    'readAgentState',
    'readMetadata',
    'readStateField',
    'writeStateField',
] as const;

const NON_PROVIDER_NORMAL_EXPERIMENTAL_OVERLAPS = [
    'HookHandler',
    'FileSystemService',
    'SubagentObservation',
    'SubagentSummary',
    'SubagentsService',
    'WorkStateItem',
    'WorkStatePublisher',
    'WorkStateService',
    'WorkStateTruncation',
] as const;

type ApiSurfaceInventory = Readonly<{
    entrypoints: readonly Readonly<{
        specifier: string;
        sourceModule: string;
        visibility: 'author' | 'host';
        conditions: Readonly<Record<string, string>>;
    }>[];
    symbols: readonly Readonly<{
        specifier: string;
        exportName: string;
        kind: 'type' | 'value';
    }>[];
}>;

const apiSurfaceInventoryRead: Readonly<
    | { status: 'available'; inventory: ApiSurfaceInventory }
    | { status: 'missing' }
> = await readValidatedApiSurfaceInventoryIfPresent(
    new URL('../api-surface.json', import.meta.url),
);
const apiSurfaceInventory: ApiSurfaceInventory | undefined =
    apiSurfaceInventoryRead.status === 'available'
        ? apiSurfaceInventoryRead.inventory
        : undefined;
/**
 * The nonwriting source lane deliberately defers generated-inventory currentness
 * to the ordered publisher. Every ordinary/package run still fails loudly when
 * the inventory is absent or stale (plan UI-D23 / EU-13).
 */
const inventoryIt = process.env.HAPPIER_PLUGIN_SDK_SOURCE_ONLY === '1' ? it.skip : it;

function versionedAuthorExports(
    identities: readonly AuthorExportIdentity[],
): readonly string[] {
    return identities
        .map(({ exportName }) => exportName)
        .filter((exportName) => /V\d+$/u.test(exportName));
}

function readApiSurfaceInventory(): ApiSurfaceInventory {
    return requireApiSurfaceInventory(apiSurfaceInventoryRead);
}

function readAuthorSurfaceContract() {
    return projectAuthorSurfaceContract(readApiSurfaceInventory());
}

const HOST_PRIVATE_OR_RETIRED_EXPORTS = [
    'AcpSessionRuntimeV1',
    'ClassifiedRuntimeErrorV1',
    'ConnectedAccountHostAdapter',
    'ConnectedAccountHostAdapterSchema',
    'ErrorRuntimeServiceV1',
    'MAX_AGENT_WORK_STATE_ITEMS_PER_SOURCE',
    'MAX_AGENT_WORK_STATE_SOURCES_PER_CONTRIBUTION',
    'MAX_AGENT_WORK_STATE_SUMMARY_CODE_UNITS',
    'MAX_AGENT_WORK_STATE_TITLE_CODE_UNITS',
    'MAX_MANAGED_SERVER_HANDLES_PER_GENERATION',
    'MAX_PLUGIN_FETCH_HEADER_BYTES',
    'MAX_PLUGIN_FETCH_REDIRECTS',
    'MAX_PLUGIN_FETCH_REQUEST_BODY_BYTES',
    'MAX_PLUGIN_FETCH_RESPONSE_BODY_BYTES',
    'MAX_PLUGIN_SESSION_SEND_IDEMPOTENCY_RECORDS',
    'MAX_PLUGIN_SUBAGENT_IDEMPOTENCY_RECORDS',
    'PLUGIN_NOTIFICATION_IDEMPOTENCY_RETENTION_MS',
    'PLUGIN_SESSION_SEND_IDEMPOTENCY_RETENTION_MS',
    'PLUGIN_SUBAGENT_IDEMPOTENCY_RETENTION_MS',
    'PluginSubagentWrite',
    'HostedWebViteBuildPresetInput',
    'ReactNativeRepackBuildPresetInput',
    'RuntimeCoreV1',
    'RuntimeErrorKindV1',
    'defineHostedWebViteBuildPreset',
    'definePluginManifest',
    'defineReactNativeRepackBuildPreset',
    'resolveConnectedAccountHostAdapter',
] as const;

function createSdkProgram(): ts.Program {
    const configPath = fileURLToPath(new URL('../tsconfig.json', import.meta.url));
    const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, {
        ...ts.sys,
        onUnRecoverableConfigFileDiagnostic(diagnostic) {
            throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
        },
    });
    if (!parsed) throw new Error(`Unable to parse ${configPath}`);
    return ts.createProgram({
        rootNames: parsed.fileNames,
        options: parsed.options,
        projectReferences: parsed.projectReferences,
    });
}

let sdkProgram: ts.Program | undefined;

function readSdkProgram(): ts.Program {
    sdkProgram ??= createSdkProgram();
    return sdkProgram;
}

function exportedSymbolsForEntrypoints(
    program: ts.Program,
    entrypoints: Readonly<Record<string, string>>,
): Readonly<Record<string, readonly ts.Symbol[]>> {
    const checker = program.getTypeChecker();
    const packageRoot = fileURLToPath(new URL('..', import.meta.url));
    return Object.fromEntries(Object.entries(entrypoints).map(([entrypoint, relativePath]) => {
        const sourceFile = program.getSourceFile(`${packageRoot}/${relativePath}`);
        if (!sourceFile) throw new Error(`Missing source file for ${entrypoint}: ${relativePath}`);
        const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
        if (!moduleSymbol) throw new Error(`Missing module symbol for ${entrypoint}`);
        return [entrypoint, checker.getExportsOfModule(moduleSymbol)];
    }));
}

function exportedSymbols(program: ts.Program): Readonly<Record<string, readonly ts.Symbol[]>> {
    return exportedSymbolsForEntrypoints(
        program,
        readAuthorSurfaceContract().entrypoints,
    );
}

function emittedDeclarationsForSources(
    program: ts.Program,
    declarationSources: readonly string[],
): ReadonlyMap<string, string> {
    const declarations = new Map<string, string>();
    const packageRoot = fileURLToPath(new URL('..', import.meta.url));
    for (const relativePath of declarationSources) {
        const sourceFile = program.getSourceFile(resolve(packageRoot, relativePath));
        if (!sourceFile) throw new Error(`Missing declaration source: ${relativePath}`);
        program.emit(sourceFile, (fileName, text) => {
            if (fileName.endsWith('.d.ts')) declarations.set(fileName, text);
        }, undefined, true);
    }
    return declarations;
}

function experimentalExportOwners(program: ts.Program): ReadonlyMap<string, readonly string[]> {
    const checker = program.getTypeChecker();
    const packageRoot = fileURLToPath(new URL('..', import.meta.url));
    const packageJsonText = ts.sys.readFile(`${packageRoot}/package.json`);
    if (!packageJsonText) throw new Error('Unable to read plugin-sdk/package.json');
    const packageJson = JSON.parse(packageJsonText) as Readonly<{
        exports: Readonly<Record<string, Readonly<{ types?: string }>>>;
    }>;
    const owners = new Map<string, string[]>();
    for (const [entrypoint, target] of Object.entries(packageJson.exports)) {
        if (!entrypoint.startsWith('./experimental/') || !target.types) continue;
        const relativePath = target.types
            .replace(/^\.\/dist\//u, '')
            .replace(/\.d\.ts$/u, '.ts');
        const sourceFile = program.getSourceFile(`${packageRoot}/src/${relativePath}`);
        if (!sourceFile) throw new Error(`Missing source file for ${entrypoint}: ${relativePath}`);
        const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
        if (!moduleSymbol) throw new Error(`Missing module symbol for ${entrypoint}`);
        for (const symbol of checker.getExportsOfModule(moduleSymbol)) {
            const existing = owners.get(symbol.name) ?? [];
            existing.push(entrypoint);
            owners.set(symbol.name, existing);
        }
    }
    return owners;
}

const PACKED_RUNTIME_CONSUMER_KEYS = [
    '.:PluginError',
    './agents/runtime:AgentRuntimeJsonValueSchema',
    './agents/runtime:AgentSessionRuntimeEventSchema',
    './ui/client:createPluginUiHostApiClient',
    './ui/build:BUILD_CONFIG_BASENAMES',
    './ui/build:createReactNativeRepackSharedModules',
    './ui/build:createReactNativeWebVitePlugins',
    './ui/build:defineBuildConfig',
    './ui/build:defineReactNativeWebViteBuildPreset',
    './testing:createPluginTestkit',
] as const;

// Approved PLAN A-15 fixes the complete seven-symbol root seed. These two
// structural contracts are retained by that explicit requirement.
const APPROVED_ROOT_SEED_KEYS = [
    '.:Disposable',
    '.:PluginErrorData',
] as const;

function directAuthorConsumers(
    repoRoot: string,
    authorEntrypoints: Readonly<Record<string, string>>,
): Set<string> {
    const specifierEntrypoints = new Map(Object.keys(authorEntrypoints).map((entrypoint) => [
        entrypoint === '.'
            ? '@happier-dev/plugin-sdk'
            : `@happier-dev/plugin-sdk${entrypoint.slice(1)}`,
        entrypoint,
    ]));
    const ignoredDirectory = /^(?:node_modules|dist|dist\..+|package-dist|target|coverage|\.expo|\.next|\.project|\.restore\..+|\.backup\..+|\.tmp(?:\..+)?)$/u;
    const testAuthorSource = /(?:\.test\.|\.spec\.|\.test-support\.|__tests__|\.testkit\.)/u;
    const consumerFiles: string[] = [];
    const pendingDirectories = [
        'packages/plugins',
        'packages/plugin-ui/src',
        'packages/plugin-sdk/examples',
    ].map((directory) => resolve(repoRoot, directory));
    while (pendingDirectories.length > 0) {
        const directory = pendingDirectories.pop();
        if (!directory) break;
        if (!ts.sys.directoryExists(directory)) continue;
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
            const fileName = resolve(directory, entry.name);
            if (entry.isDirectory()) {
                if (!ignoredDirectory.test(entry.name)) pendingDirectories.push(fileName);
                continue;
            }
            if (
                entry.isFile()
                && /\.(?:ts|tsx)$/u.test(entry.name)
                && !relative(repoRoot, fileName).replaceAll('\\', '/').startsWith('packages/tests/')
            ) {
                consumerFiles.push(fileName);
            }
        }
    }
    const direct = new Set<string>([
        ...PACKED_RUNTIME_CONSUMER_KEYS,
        ...APPROVED_ROOT_SEED_KEYS,
    ]);
    const normalSpecifierLiterals = [...specifierEntrypoints.keys()].flatMap((specifier) => [
        `'${specifier}'`,
        `"${specifier}"`,
    ]);
    const sdkConsumerFiles = consumerFiles.filter((fileName) => {
        const sourceText = ts.sys.readFile(fileName);
        return sourceText !== undefined
            && normalSpecifierLiterals.some((literal) => sourceText.includes(literal));
    });
    // Bind only the selected source files. Resolution and libraries are unnecessary:
    // the checker is used solely to distinguish references to an exact local import
    // binding from same-named declarations in nested scopes.
    const consumerProgram = ts.createProgram({
        rootNames: sdkConsumerFiles,
        options: {
            allowJs: false,
            checkJs: false,
            jsx: ts.JsxEmit.Preserve,
            module: ts.ModuleKind.ESNext,
            noLib: true,
            noResolve: true,
            skipLibCheck: true,
            target: ts.ScriptTarget.Latest,
        },
    });
    const checker = consumerProgram.getTypeChecker();
    for (const fileName of sdkConsumerFiles) {
        const sourceFile = consumerProgram.getSourceFile(fileName);
        if (!sourceFile) throw new Error(`Missing consumer source file: ${fileName}`);
        const importedKeys = new Map<string, Readonly<{
            key: string;
            symbol: ts.Symbol;
        }>>();
        for (const statement of sourceFile.statements) {
            if (
                !ts.isImportDeclaration(statement)
                || !ts.isStringLiteral(statement.moduleSpecifier)
            ) {
                continue;
            }
            const entrypoint = specifierEntrypoints.get(statement.moduleSpecifier.text);
            const bindings = statement.importClause?.namedBindings;
            if (
                !entrypoint
                || (testAuthorSource.test(fileName) && entrypoint !== './testing')
                || !bindings
                || !ts.isNamedImports(bindings)
            ) {
                continue;
            }
            for (const element of bindings.elements) {
                const localBinding = checker.getSymbolAtLocation(element.name);
                if (!localBinding) continue;
                importedKeys.set(
                    element.name.text,
                    {
                        key: `${entrypoint}:${(element.propertyName ?? element.name).text}`,
                        symbol: localBinding,
                    },
                );
            }
        }
        const visit = (node: ts.Node): void => {
            if (ts.isImportDeclaration(node)) return;
            if (ts.isIdentifier(node)) {
                const imported = importedKeys.get(node.text);
                if (
                    imported
                    && checker.getSymbolAtLocation(node) === imported.symbol
                ) {
                    direct.add(imported.key);
                }
            }
            ts.forEachChild(node, visit);
        };
        ts.forEachChild(sourceFile, visit);
    }
    return direct;
}

function realAuthorConsumers(program: ts.Program): Readonly<{
    direct: ReadonlySet<string>;
    closure: ReadonlySet<string>;
}> {
    const checker = program.getTypeChecker();
    const packageRoot = fileURLToPath(new URL('..', import.meta.url));
    const packageSourceRoot = resolve(packageRoot, 'src');
    const repoRoot = resolve(packageRoot, '../..');
    const workspaceDeclarationRoot = resolve(repoRoot, 'packages');
    const surface = exportedSymbols(program);
    const direct = directAuthorConsumers(repoRoot, readAuthorSurfaceContract().entrypoints);
    const surfaceKeys = Object.entries(surface).flatMap(([entrypoint, symbols]) => (
        symbols.map((symbol) => `${entrypoint}:${symbol.name}`)
    ));
    if (surfaceKeys.every((key) => direct.has(key))) {
        return { direct, closure: new Set(direct) };
    }

    const targetKey = new Map<ts.Symbol, string>();
    const keys: string[] = [];
    const publicTargets: { target: ts.Symbol; key: string }[] = [];
    const registerDirectAliasChain = (input: ts.Symbol, key: string): void => {
        let symbol = input;
        const seenAliases = new Set<ts.Symbol>();
        while (!seenAliases.has(symbol)) {
            seenAliases.add(symbol);
            const existingKey = targetKey.get(symbol);
            if (existingKey !== undefined && existingKey !== key) return;
            targetKey.set(symbol, key);
            const declaration = symbol.declarations?.find(ts.isTypeAliasDeclaration);
            if (!declaration || !ts.isTypeReferenceNode(declaration.type)) return;
            const referenced = checker.getSymbolAtLocation(declaration.type.typeName);
            if (!referenced) return;
            symbol = referenced.flags & ts.SymbolFlags.Alias
                ? checker.getAliasedSymbol(referenced)
                : referenced;
        }
    };
    for (const [entrypoint, symbols] of Object.entries(surface)) {
        for (const symbol of symbols) {
            const target = symbol.flags & ts.SymbolFlags.Alias
                ? checker.getAliasedSymbol(symbol)
                : symbol;
            const key = `${entrypoint}:${symbol.name}`;
            targetKey.set(target, key);
            publicTargets.push({ target, key });
            keys.push(key);
        }
    }
    for (const { target, key } of publicTargets) registerDirectAliasChain(target, key);

    const dependencies = new Map(keys.map((key) => [key, new Set<string>()]));
    for (const symbols of Object.values(surface)) {
        for (const symbol of symbols) {
            const target = symbol.flags & ts.SymbolFlags.Alias
                ? checker.getAliasedSymbol(symbol)
                : symbol;
            const ownerKey = targetKey.get(target);
            if (!ownerKey) throw new Error(`Missing normal-surface owner for ${symbol.name}`);
            const definiteOwnerKey = ownerKey;
            const seen = new Set<ts.Symbol>([target]);

            function visitSymbol(input: ts.Symbol): void {
                const resolved = input.flags & ts.SymbolFlags.Alias
                    ? checker.getAliasedSymbol(input)
                    : input;
                const publicKey = targetKey.get(resolved);
                if (publicKey && publicKey !== definiteOwnerKey) {
                    dependencies.get(definiteOwnerKey)?.add(publicKey);
                    return;
                }
                if (seen.has(resolved)) return;
                seen.add(resolved);
                for (const declaration of resolved.declarations ?? []) {
                    const fileName = declaration.getSourceFile().fileName;
                    const sourceRelativePath = relative(packageSourceRoot, fileName);
                    const workspaceDeclarationRelativePath = relative(
                        workspaceDeclarationRoot,
                        fileName,
                    );
                    const isPackageSource = sourceRelativePath !== ''
                        && !sourceRelativePath.startsWith('..')
                        && !isAbsolute(sourceRelativePath);
                    const isWorkspaceDeclaration = workspaceDeclarationRelativePath !== ''
                        && !workspaceDeclarationRelativePath.startsWith('..')
                        && !isAbsolute(workspaceDeclarationRelativePath)
                        && fileName.endsWith('.d.ts')
                        && targetKey.has(resolved);
                    if (!isPackageSource && !isWorkspaceDeclaration) {
                        continue;
                    }
                    visitNode(declaration);
                }
            }

            function visitNode(node: ts.Node): void {
                if (ts.isIdentifier(node)) {
                    const referenced = checker.getSymbolAtLocation(node);
                    if (referenced) visitSymbol(referenced);
                }
                ts.forEachChild(node, visitNode);
            }

            for (const declaration of target.declarations ?? []) visitNode(declaration);
        }
    }

    const closure = new Set(direct);
    let expanded = true;
    while (expanded) {
        expanded = false;
        for (const key of [...closure]) {
            for (const dependency of dependencies.get(key) ?? []) {
                if (closure.has(dependency)) continue;
                closure.add(dependency);
                expanded = true;
            }
        }
    }
    return { direct, closure };
}

let authorConsumers:
    ReturnType<typeof realAuthorConsumers> | undefined;

function readRealAuthorConsumers(program: ts.Program):
    ReturnType<typeof realAuthorConsumers> {
    authorConsumers ??= realAuthorConsumers(program);
    return authorConsumers;
}

function missingRequiredDeclarationDependencies(
    closure: ReadonlySet<string>,
    required: readonly string[],
): readonly string[] {
    return required.filter((key) => !closure.has(key));
}

describe('normal supported package surface', () => {
    it('blocks publication until the package-owned inventory has been generated', () => {
        expect(
            apiSurfaceInventory,
            'Publication remains blocked: packages/plugin-sdk/api-surface.json has not been generated from source',
        ).toBeDefined();
    });

    it('fails a missing inventory with the file path and a runnable regeneration command', async () => {
        expect(requireApiSurfaceInventory({
            status: 'available',
            inventory: { entrypoints: [], symbols: [] },
        })).toEqual({ entrypoints: [], symbols: [] });

        // A clean clone has no inventory at all, so the loud failure is the only
        // thing a developer sees. It has to name the missing file and a command
        // that produces it, or the developer is left guessing.
        expect(() => requireApiSurfaceInventory({ status: 'missing' }))
            .toThrowError(/packages\/plugin-sdk\/api-surface\.json/u);

        // The named command must be a script this package actually declares.
        // A retired producer left behind in this message reads as runnable and
        // is not (UI-D28: `api-surface:seed` was removed with its mode).
        let message = '';
        try {
            requireApiSurfaceInventory({ status: 'missing' });
        } catch (error) {
            message = error instanceof Error ? error.message : String(error);
        }
        const named = [...message.matchAll(
            /`yarn workspace @happier-dev\/plugin-sdk ([a-z0-9:-]+)[^`]*`/gu,
        )].map((match) => match[1]);
        expect(named.length).toBeGreaterThan(0);
        const packageScripts = JSON.parse(await readFile(
            fileURLToPath(new URL('../package.json', import.meta.url)),
            'utf8',
        )) as Readonly<{ scripts?: Readonly<Record<string, string>> }>;
        for (const script of named) {
            expect(Object.keys(packageScripts.scripts ?? {})).toContain(script);
        }
        expect(named).toContain('api-surface');
    });

    it('derives author paths and symbols from the tracked inventory', () => {
        const inventory = {
            entrypoints: [
                {
                    specifier: '.',
                    sourceModule: 'src/fixture.ts',
                    visibility: 'author',
                    conditions: { types: './dist/fixture.d.ts', default: './dist/fixture.js' },
                },
                ...[
                    './agents/runtime',
                    './exec',
                    './secrets',
                    './storage',
                ].map((specifier) => ({
                    specifier,
                    sourceModule: `src${specifier.slice(1)}/index.ts`,
                    visibility: 'author' as const,
                    conditions: {
                        types: `./dist${specifier.slice(1)}/index.d.ts`,
                        default: `./dist${specifier.slice(1)}/index.js`,
                    },
                })),
                {
                    specifier: './host/registration',
                    sourceModule: 'src/host/registration.ts',
                    visibility: 'host',
                    conditions: {
                        types: './dist/host/registration.d.ts',
                        default: './dist/host/registration.js',
                    },
                },
            ],
            symbols: [
                { specifier: '.', exportName: 'InventoryOnlyName', kind: 'type' },
                { specifier: './agents/runtime', exportName: 'AgentRuntime', kind: 'type' },
                { specifier: './exec', exportName: 'ExecService', kind: 'type' },
                { specifier: './secrets', exportName: 'SecretsService', kind: 'type' },
                { specifier: './storage', exportName: 'StorageService', kind: 'type' },
                { specifier: './host/registration', exportName: 'HostOnlyName', kind: 'type' },
            ],
        } satisfies ApiSurfaceInventory;

        expect(projectAuthorSurfaceContract(inventory)).toEqual({
            entrypoints: {
                '.': 'src/fixture.ts',
                './agents/runtime': 'src/agents/runtime/index.ts',
                './exec': 'src/exec/index.ts',
                './secrets': 'src/secrets/index.ts',
                './storage': 'src/storage/index.ts',
            },
            exports: {
                '.': ['InventoryOnlyName'],
                './agents/runtime': ['AgentRuntime'],
                './exec': ['ExecService'],
                './secrets': ['SecretsService'],
                './storage': ['StorageService'],
            },
        });
    });

    it('uses the approved unprefixed shared service and UI identities in source', () => {
        const surface = exportedSymbolsForEntrypoints(readSdkProgram(), {
            runtime: 'src/runtime/index.ts',
            ui: 'src/ui/index.ts',
        });
        const runtime = new Set(surface.runtime.map((symbol) => symbol.name));
        const ui = new Set(surface.ui.map((symbol) => symbol.name));
        const finalRuntimeNames = [
            'DaemonDatabase',
            'DaemonDatabaseExecutionResult',
            'DaemonDatabaseIncumbentQueryFixture',
            'DaemonDatabaseMigration',
            'DaemonDatabaseMigrationDeclaration',
            'DaemonDatabaseMigrationReadTransaction',
            'DaemonDatabaseMigrationTransaction',
            'DaemonDatabaseOperationOptions',
            'DaemonDatabaseReadTransaction',
            'DaemonDatabaseRow',
            'DaemonDatabaseService',
            'DaemonDatabaseStorageScope',
            'DaemonDatabaseTransaction',
            'DaemonDatabaseValue',
            'ExecService',
            'SecretsService',
            'StorageConsistency',
            'StorageScopeService',
            'StorageService',
            'StorageTransaction',
        ];
        const finalUiNames = [
            'OpenSurfaceOptions',
            'PluginSurfaceTarget',
            'PluginUiJsonValueV1',
            'PluginUiThemeV1',
            'SurfaceHostMethod',
            'RenderContext',
            'RenderSurface',
            'ResourceContent',
            'SurfaceContext',
        ];
        const predecessorNames = [
            'PluginExecService',
            'PluginSecretsService',
            'PluginStorageConsistency',
            'PluginStorageScopeService',
            'PluginStorageService',
            'PluginStorageTransaction',
            'PluginUiHostMethod',
            'PluginUiRenderContext',
            'PluginUiRenderSurface',
            'PluginUiResource',
            'PluginUiSurfaceContext',
        ];

        expect(finalRuntimeNames.filter((name) => !runtime.has(name))).toEqual([]);
        expect(finalUiNames.filter((name) => !ui.has(name))).toEqual([]);
        expect(predecessorNames.filter((name) => runtime.has(name) || ui.has(name))).toEqual([]);
    }, 45_000);

    it('withholds the producerless resource-subscription contract from the UI surface', () => {
        // EU-4b staging. `watchResource` and the `invalidated` event it carries
        // have no host producer at this basis, so neither may be reachable as a
        // public author contract: an author must not be able to call a
        // subscription the host can never establish, nor name the event type it
        // would deliver. The declarations survive for EU-4b — this proves only
        // that they are not externalized.
        const program = readSdkProgram();
        const checker = program.getTypeChecker();
        const uiSymbols = exportedSymbolsForEntrypoints(program, { ui: 'src/ui/index.ts' }).ui;
        const uiNames = new Set(uiSymbols.map((symbol) => symbol.name));

        const hostApiSymbol = uiSymbols.find((symbol) => symbol.name === 'PluginUiHostApi');
        if (!hostApiSymbol) throw new Error('PluginUiHostApi is not exported from src/ui/index.ts');
        const declared = checker.getDeclaredTypeOfSymbol(
            hostApiSymbol.flags & ts.SymbolFlags.Alias
                ? checker.getAliasedSymbol(hostApiSymbol)
                : hostApiSymbol,
        );
        const members = declared.getProperties().map((property) => property.name);
        // EU-4b graduated `watchResource`: the dynamic resource kind's producer,
        // the daemon delivery owner and the app transport are all real, so the
        // member and its event type are published rather than staged.
        expect(members).toContain('watchResource');
        expect(uiNames.has('ResourceSubscriptionEvent')).toBe(true);

        // Negative controls, so a wrong implementation that simply emptied the
        // host API — or published everything indiscriminately — fails here too.
        expect(members).toContain('readResource');
        expect(members).toContain('watchContext');
        expect(uiNames.has('ResourceContent')).toBe(true);
        // `disposeHostResource` is a transport operation, never a host API
        // member; the retired resource-specific spelling has no alias.
        expect(members).not.toContain('disposeHostResource');
        expect(members).not.toContain('unsubscribeResource');
        expect(uiNames.has('PluginUiHostApiWithResourceSubscriptionsV1')).toBe(false);
    }, 45_000);

    inventoryIt('projects the approved unprefixed shared service and UI identities', () => {
        const authorExports = readAuthorSurfaceContract().exports;
        const exec = new Set<string>(authorExports['./exec']);
        const protocolClients = new Set<string>(authorExports['./exec/protocol-clients']);
        const fs = new Set<string>(authorExports['./fs']);
        const agents = new Set<string>(authorExports['./agents']);
        const secrets = new Set<string>(authorExports['./secrets']);
        const storage = new Set<string>(authorExports['./storage']);
        const ui = new Set<string>(authorExports['./ui']);

        expect(exec.has('ExecService')).toBe(true);
        expect(protocolClients.has('ProtocolClientsService')).toBe(true);
        expect(fs.has('FileSystemService')).toBe(true);
        expect(protocolClients.has('PluginProtocolClientsService')).toBe(false);
        expect(fs.has('PluginFileSystemService')).toBe(false);
        expect(secrets.has('SecretsService')).toBe(true);
        expect([
            'StorageConsistency',
            'StorageScopeService',
            'StorageService',
            'StorageTransaction',
        ].filter((name) => !storage.has(name))).toEqual([]);
        expect([
            'SurfaceHostMethod',
            'RenderContext',
            'RenderSurface',
            'ResourceContent',
            'SurfaceContext',
        ].filter((name) => !ui.has(name))).toEqual([]);
    });

    it('keeps host-only manifest inventory machinery off the normal author surface', () => {
        const manifestExports = new Set(exportedSymbolsForEntrypoints(readSdkProgram(), {
            manifest: 'src/manifest.ts',
        }).manifest.map((symbol) => symbol.name));
        for (const hostOnlyName of [
            'PLUGIN_CONTRIBUTION_CATALOG_V2',
            'resolvePluginManifestSetReferencesV2',
        ]) {
            expect(manifestExports.has(hostOnlyName), hostOnlyName).toBe(false);
        }
    }, 45_000);

    inventoryIt('keeps host-only manifest inventory machinery out of the projected author surface', () => {
        const manifestInventory = new Set<string>(
            readAuthorSurfaceContract().exports['./manifest'],
        );

        for (const hostOnlyName of [
            'PLUGIN_CONTRIBUTION_CATALOG_V2',
            'resolvePluginManifestSetReferencesV2',
        ]) {
            expect(manifestInventory.has(hostOnlyName), hostOnlyName).toBe(false);
        }
    });

    it('owns PluginSettingsContribution only on the settings entrypoint', () => {
        const surface = exportedSymbolsForEntrypoints(readSdkProgram(), {
            manifest: 'src/manifest.ts',
            settings: 'src/settings/index.ts',
        });
        const sourceOwners = Object.entries(surface)
            .filter(([, symbols]) => symbols.some((symbol) => (
                symbol.name === 'PluginSettingsContribution'
            )))
            .map(([entrypoint]) => entrypoint);
        expect(sourceOwners).toEqual(['settings']);
    }, 45_000);

    inventoryIt('projects PluginSettingsContribution only on the settings entrypoint', () => {
        const inventoryOwners = Object.entries(readAuthorSurfaceContract().exports)
            .filter(([, names]) => names.includes('PluginSettingsContribution'))
            .map(([entrypoint]) => entrypoint);

        expect(inventoryOwners).toEqual(['./settings']);
    });

    it('keeps Connected Account materialization owned by /connected-accounts rather than /voice', () => {
        const surface = exportedSymbolsForEntrypoints(readSdkProgram(), {
            connectedAccounts: 'src/connectedAccounts.ts',
            voice: 'src/voice/index.ts',
        });
        const connectedAccounts = new Set(
            surface.connectedAccounts.map((symbol) => symbol.name),
        );
        const voice = new Set(surface.voice.map((symbol) => symbol.name));
        const connectedAccountMaterializationTypes = [
            'ConnectedAccountMaterialization',
            'ConnectedAccountMaterializationRequest',
        ];

        expect(connectedAccountMaterializationTypes.filter((name) => !connectedAccounts.has(name)))
            .toEqual([]);
        expect(connectedAccountMaterializationTypes.filter((name) => voice.has(name)))
            .toEqual([]);
    }, 45_000);

    it('makes the Agent feature-decision service nameable from the final Agent barrel', () => {
        const surface = exportedSymbolsForEntrypoints(readSdkProgram(), {
            context: 'src/agentRuntime/context.ts',
            index: 'src/agentRuntime/index.ts',
            barrel: 'src/agent-runtime.ts',
        });
        const exportedNames = (key: keyof typeof surface): Set<string> => new Set(
            surface[key].map((symbol) => symbol.name),
        );

        expect({
            context: exportedNames('context').has('AgentFeatureDecisionService'),
            index: exportedNames('index').has('AgentFeatureDecisionService'),
            barrel: exportedNames('barrel').has('AgentFeatureDecisionService'),
        }).toEqual({
            context: true,
            index: true,
            barrel: true,
        });
    }, 45_000);

    inventoryIt('projects the Agent feature-decision service through the Agent runtime surface', () => {
        expect(readAuthorSurfaceContract().exports['./agents/runtime'])
            .toContain('AgentFeatureDecisionService');
    });

    it('keeps the complete Agent terminal author contract explicit before publication', () => {
        const sourceSurface = exportedSymbolsForEntrypoints(readSdkProgram(), {
            context: 'src/agentRuntime/context.ts',
            surfaces: 'src/agentRuntime/surfaces.ts',
            index: 'src/agentRuntime/index.ts',
        });
        const contextAndSurfaces = new Set([
            ...sourceSurface.context,
            ...sourceSurface.surfaces,
        ].map((symbol) => symbol.name));
        const index = new Set(sourceSurface.index.map((symbol) => symbol.name));
        expect(AGENT_RUNTIME_TERMINAL_AUTHOR_CONTRACT.filter((name) => !contextAndSurfaces.has(name)))
            .toEqual([]);
        expect(AGENT_RUNTIME_TERMINAL_AUTHOR_CONTRACT.filter((name) => !index.has(name)))
            .toEqual([]);
    }, 45_000);

    inventoryIt('projects the complete Agent terminal author contract', () => {
        const inventory = new Set(
            readAuthorSurfaceContract().exports['./agents/runtime'],
        );

        expect(AGENT_RUNTIME_TERMINAL_AUTHOR_CONTRACT.filter((name) => !inventory.has(name)))
            .toEqual([]);
    });

    it('identifies versioning only from exported identities', () => {
        expect(versionedAuthorExports([
            {
                exportName: 'AgentSessionRunnerFactoryLocatorV1',
                sourceIdentity: 'AgentSessionRunnerFactoryLocatorV1',
            },
            {
                exportName: 'PromptAssetCapabilities',
                sourceIdentity: 'PromptAssetCapabilitiesV1',
            },
            {
                exportName: 'PluginActionInputById',
                sourceIdentity: 'PluginActionInputById',
                nestedPropertyNames: ['runtimeDescriptorV1'],
            },
            {
                exportName: 'AccidentalAuthorContractV1',
                sourceIdentity: 'AccidentalAuthorContractV1',
            },
        ])).toEqual([
            'AgentSessionRunnerFactoryLocatorV1',
            'AccidentalAuthorContractV1',
        ]);
    });

    it('counts only referenced imports from genuine plugin author sources', () => {
        const fixtureRoot = mkdtempSync(join(tmpdir(), 'happier-sdk-consumers-'));
        try {
            const hostSourceRoot = join(fixtureRoot, 'apps', 'cli', 'src');
            const sdkSourceRoot = join(fixtureRoot, 'packages', 'plugin-sdk', 'src');
            const pluginUiSourceRoot = join(fixtureRoot, 'packages', 'plugin-ui', 'src');
            const sourceRoot = join(fixtureRoot, 'packages', 'plugins', 'plugin-fixture', 'src');
            mkdirSync(hostSourceRoot, { recursive: true });
            mkdirSync(sdkSourceRoot, { recursive: true });
            mkdirSync(pluginUiSourceRoot, { recursive: true });
            mkdirSync(sourceRoot, { recursive: true });
            writeFileSync(join(hostSourceRoot, 'host.ts'), `
import type {
    ExternalSessionsService as HostExternalSessions,
    SessionsService as HostSessions,
} from '@happier-dev/plugin-sdk/sessions';

export type HostOnlyConsumers = readonly [HostExternalSessions, HostSessions];
`, 'utf8');
            writeFileSync(join(sdkSourceRoot, 'self.ts'), `
import type {
    ExternalSessionRef as SdkExternalSessionRef,
} from '@happier-dev/plugin-sdk/sessions/external';

export type SdkSelfConsumer = SdkExternalSessionRef;
`, 'utf8');
            writeFileSync(join(sourceRoot, 'index.ts'), `
import type {
    LoggerService as UnusedLogger,
    PluginServices as UsedServices,
} from '@happier-dev/plugin-sdk';
import {
    type EventsService as ShadowedEvents,
} from '@happier-dev/plugin-sdk/events';
import type { ExecService as UsedExec } from '@happier-dev/plugin-sdk/exec';
import type { SecretsService as UsedSecrets } from '@happier-dev/plugin-sdk/secrets';
import type { SettingsService as UsedSettings } from '@happier-dev/plugin-sdk/settings';
import type { StorageService as UsedStorage } from '@happier-dev/plugin-sdk/storage';

export type UsedConsumer = Readonly<{
    services: Pick<UsedServices, 'logger'>;
    exec: UsedExec;
    secrets: UsedSecrets;
    settings: UsedSettings;
    storage: UsedStorage;
}>;

export function shadowOnly(ShadowedEvents: string): string {
    return ShadowedEvents;
}
`, 'utf8');
            writeFileSync(join(sourceRoot, 'host-coupled.test-support.ts'), `
import type { JsonValue } from '@happier-dev/plugin-sdk';

export type TestSupportOnly = JsonValue;
`, 'utf8');
            writeFileSync(join(sourceRoot, 'runtime.test.ts'), `
import {
    createAgentSessionRuntimeHarness as UsedHarness,
    type AgentSessionRuntimeHarness as UsedHarnessType,
} from '@happier-dev/plugin-sdk/testing';
import type { ManagedServiceErrorCode as RuntimeOnlyTestImport } from '@happier-dev/plugin-sdk/managed-services';

export const createHarness = (): UsedHarnessType => UsedHarness();
export type RuntimeTestOnly = RuntimeOnlyTestImport;
`, 'utf8');
            writeFileSync(join(pluginUiSourceRoot, 'compatibility.ts'), `
import type { PluginUiChannel as UsedChannel } from '@happier-dev/plugin-sdk/ui';

export type PublicUiChannel = UsedChannel;
`, 'utf8');

            const direct = directAuthorConsumers(fixtureRoot, {
                '.': 'src/index.ts',
                './events': 'src/events/index.ts',
                './exec': 'src/exec/index.ts',
                './managed-services': 'src/managed-services/index.ts',
                './secrets': 'src/secrets/index.ts',
                './settings': 'src/settings/index.ts',
                './storage': 'src/storage/index.ts',
                './testing': 'src/testing/index.ts',
                './ui': 'src/ui/index.ts',
            });
            expect(direct.has('.:PluginServices')).toBe(true);
            expect(direct.has('./exec:ExecService')).toBe(true);
            expect(direct.has('./secrets:SecretsService')).toBe(true);
            expect(direct.has('./settings:SettingsService')).toBe(true);
            expect(direct.has('./storage:StorageService')).toBe(true);
            expect(direct.has('.:LoggerService')).toBe(false);
            expect(direct.has('./events:EventsService')).toBe(false);
            expect(direct.has('.:JsonValue')).toBe(false);
            expect(direct.has('./managed-services:ManagedServiceErrorCode')).toBe(false);
            expect(direct.has('./testing:createAgentSessionRuntimeHarness')).toBe(true);
            expect(direct.has('./testing:AgentSessionRuntimeHarness')).toBe(true);
            expect(direct.has('./ui:PluginUiChannel')).toBe(true);
        } finally {
            rmSync(fixtureRoot, { recursive: true, force: true });
        }
    }, 15_000);

    inventoryIt('matches the package-owned API surface inventory', async () => {
        const inventory = await readApiSurfaceInventory();
        const packageRoot = fileURLToPath(new URL('..', import.meta.url));
        const packageJsonText = ts.sys.readFile(`${packageRoot}/package.json`);
        if (!packageJsonText) throw new Error('Unable to read plugin-sdk/package.json');
        const packageJson = JSON.parse(packageJsonText) as Readonly<{
            exports: Readonly<Record<string, Readonly<Record<string, string>>>>;
        }>;
        const expectedPackageExports = Object.fromEntries(inventory.entrypoints.map((entrypoint) => [
            entrypoint.specifier,
            entrypoint.conditions,
        ]));
        expect(packageJson.exports).toEqual(expectedPackageExports);

        const authorEntrypoints = Object.fromEntries(inventory.entrypoints
            .filter((entrypoint) => entrypoint.visibility === 'author')
            .map((entrypoint) => [entrypoint.specifier, entrypoint.sourceModule]));
        const actualAuthorSurface = Object.fromEntries(Object.entries(exportedSymbolsForEntrypoints(
            readSdkProgram(),
            authorEntrypoints,
        )).map(([entrypoint, symbols]) => [
            entrypoint,
            symbols.map((symbol) => symbol.name).sort(),
        ]));
        const expectedAuthorSurface = Object.fromEntries(Object.keys(authorEntrypoints).map((entrypoint) => [
            entrypoint,
            inventory.symbols
                .filter((symbol) => symbol.specifier === entrypoint)
                .map((symbol) => symbol.exportName)
                .sort(),
        ]));
        expect(actualAuthorSurface).toEqual(expectedAuthorSurface);
    });

    inventoryIt('uses only genuine plugin, packed-runtime, and approved-root bindings as declaration roots', () => {
        const program = readSdkProgram();
        const { direct } = readRealAuthorConsumers(program);
        const surfaceKeys = new Set(Object.entries(exportedSymbols(program)).flatMap(([entrypoint, symbols]) => (
            symbols.map((symbol) => `${entrypoint}:${symbol.name}`)
        )));
        expect([...direct].filter((key) => !surfaceKeys.has(key)).sort()).toEqual([]);
    }, 90_000);

    inventoryIt('follows canonical workspace owners through the emitted author declaration graph', () => {
        const { closure } = readRealAuthorConsumers(readSdkProgram());
        const required = [
            './manifest:PluginContributes',
            './events:HostEventPayloadById',
            './events:HostEventScopeById',
        ] as const;

        expect(missingRequiredDeclarationDependencies(closure, required)).toEqual([]);
        expect(missingRequiredDeclarationDependencies(closure, [
            ...required,
            './events:MissingCanonicalDeclarationOwner',
        ])).toEqual(['./events:MissingCanonicalDeclarationOwner']);
    }, 90_000);

    inventoryIt('keeps every inventory-owned author barrel explicit', async () => {
        for (const [entrypoint, relativePath] of Object.entries(
            readAuthorSurfaceContract().entrypoints,
        )) {
            const sourceText = await import('node:fs/promises').then(({ readFile }) => (
                readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8')
            ));
            const sourceFile = ts.createSourceFile(relativePath, sourceText, ts.ScriptTarget.Latest, true);
            const wildcard = sourceFile.statements.find((statement) => (
                ts.isExportDeclaration(statement) && statement.exportClause === undefined
            ));
            expect(wildcard, `${entrypoint} contains a wildcard export`).toBeUndefined();
        }
    });

    inventoryIt('exports each supported symbol from exactly one normal path', () => {
        const surface = exportedSymbols(readSdkProgram());
        const owners = new Map<string, string[]>();
        for (const [entrypoint, symbols] of Object.entries(surface)) {
            for (const symbol of symbols) {
                const existing = owners.get(symbol.name) ?? [];
                existing.push(entrypoint);
                owners.set(symbol.name, existing);
            }
        }
        const duplicates = [...owners.entries()]
            .filter(([, entrypoints]) => entrypoints.length > 1)
            .map(([name, entrypoints]) => ({ name, entrypoints }))
            .sort((left, right) => left.name.localeCompare(right.name));
        expect(duplicates).toEqual([]);
    });

    inventoryIt('keeps normal and experimental symbols disjoint', () => {
        const program = readSdkProgram();
        const normal = new Set(Object.values(exportedSymbols(program)).flatMap((symbols) => (
            symbols.map((symbol) => symbol.name)
        )));
        const overlaps = [...experimentalExportOwners(program).entries()]
            .filter(([name]) => normal.has(name))
            .map(([name, entrypoints]) => ({ name, entrypoints }))
            .sort((left, right) => left.name.localeCompare(right.name));
        expect(overlaps).toEqual([]);
    }, 15_000);

    inventoryIt('contracts non-Provider normal/experimental overlaps after consumer migration', () => {
        const program = readSdkProgram();
        const experimentalOwners = experimentalExportOwners(program);
        const overlaps = NON_PROVIDER_NORMAL_EXPERIMENTAL_OVERLAPS.flatMap((name) => {
            const entrypoints = experimentalOwners.get(name);
            return entrypoints ? [{ name, entrypoints }] : [];
        });
        const packageRoot = fileURLToPath(new URL('..', import.meta.url));
        const packageJsonText = ts.sys.readFile(`${packageRoot}/package.json`);
        if (!packageJsonText) throw new Error('Unable to read plugin-sdk/package.json');
        const packageJson = JSON.parse(packageJsonText) as Readonly<{
            exports: Readonly<Record<string, unknown>>;
        }>;

        expect({
            overlaps,
            unusedSubagentBarrel: Object.hasOwn(
                packageJson.exports,
                './experimental/sessions/subagents',
            ),
        }).toEqual({
            overlaps: [],
            unusedSubagentBarrel: false,
        });
    }, 15_000);

    inventoryIt('matches versioned author identities to the package inventory', () => {
        const program = readSdkProgram();
        const checker = program.getTypeChecker();
        const surface = exportedSymbols(program);
        const actual = Object.entries(surface).flatMap(([entrypoint, symbols]) => (
            versionedAuthorExports(symbols.flatMap((symbol) => {
                const target = symbol.flags & ts.SymbolFlags.Alias
                    ? checker.getAliasedSymbol(symbol)
                    : symbol;
                return target.flags & ts.SymbolFlags.Type
                    ? [{ exportName: symbol.name, sourceIdentity: target.name }]
                    : [];
            })).map((name) => `${entrypoint}:${name}`)
        )).sort();
        const inventory = readApiSurfaceInventory();
        const authorSpecifiers = new Set(inventory.entrypoints
            .filter(({ visibility }) => visibility === 'author')
            .map(({ specifier }) => specifier));
        const expected = inventory.symbols
            .filter(({ specifier, exportName, kind }) => (
                kind === 'type'
                && authorSpecifiers.has(specifier)
                && /V\d+$/u.test(exportName)
            ))
            .map(({ specifier, exportName }) => `${specifier}:${exportName}`)
            .sort();

        expect(actual).toEqual(expected);
    });

    inventoryIt('keeps every normal public signature host-private-free', () => {
        const program = readSdkProgram();
        const checker = program.getTypeChecker();
        const findings: string[] = [];

        const visitTypeNode = (
            node: ts.Node,
            context: string,
        ): void => {
            if (ts.isIdentifier(node)) {
                const name = node.text;
                if (HOST_PRIVATE_OR_RETIRED_EXPORTS.includes(
                    name as typeof HOST_PRIVATE_OR_RETIRED_EXPORTS[number],
                )) {
                    findings.push(`${context} -> ${name}`);
                }
            }
            ts.forEachChild(node, (child) => visitTypeNode(child, context));
        };

        for (const [entrypoint, symbols] of Object.entries(exportedSymbols(program))) {
            for (const exportedSymbol of symbols) {
                if (exportedSymbol.name.endsWith('Schema')) continue;
                const target = exportedSymbol.flags & ts.SymbolFlags.Alias
                    ? checker.getAliasedSymbol(exportedSymbol)
                    : exportedSymbol;
                const declaration = target.valueDeclaration ?? target.declarations?.[0];
                if (!declaration) continue;
                const context = `${entrypoint}:${exportedSymbol.name}`;

                if (HOST_PRIVATE_OR_RETIRED_EXPORTS.includes(
                    target.name as typeof HOST_PRIVATE_OR_RETIRED_EXPORTS[number],
                )) {
                    findings.push(`${context} -> alias target ${target.name}`);
                }

                const type = target.flags & ts.SymbolFlags.Type
                    ? checker.getDeclaredTypeOfSymbol(target)
                    : checker.getTypeOfSymbolAtLocation(target, declaration);
                const projected = checker.typeToTypeNode(
                    type,
                    declaration,
                    ts.NodeBuilderFlags.NoTruncation | ts.NodeBuilderFlags.UseFullyQualifiedType,
                );
                if (projected) visitTypeNode(projected, context);
            }
        }

        expect([...new Set(findings)].sort()).toEqual([]);
    }, 45_000);

    it('keeps privacy-amendment-gated Session contracts out of the author surface', async () => {
        const runtimeEntrypoint = 'src/runtime/index.ts';
        const [runtimeSourceText, sessionsSourceText] = await Promise.all([
            readFile(new URL(`../${runtimeEntrypoint}`, import.meta.url), 'utf8'),
            readFile(new URL('./services/sessions.ts', import.meta.url), 'utf8'),
        ]);
        const runtimeSource = ts.createSourceFile(
            runtimeEntrypoint,
            runtimeSourceText,
            ts.ScriptTarget.Latest,
            true,
        );
        const wildcard = runtimeSource.statements.find((statement) => (
            ts.isExportDeclaration(statement) && statement.exportClause === undefined
        ));
        expect(wildcard, './runtime contains a wildcard export').toBeUndefined();
        const names = new Set(runtimeSource.statements.flatMap((statement) => (
            ts.isExportDeclaration(statement) && statement.exportClause
                && ts.isNamedExports(statement.exportClause)
                ? statement.exportClause.elements.map((element) => element.name.text)
                : []
        )));

        const sessionsSource = ts.createSourceFile(
            'src/services/sessions.ts',
            sessionsSourceText,
            ts.ScriptTarget.Latest,
            true,
        );
        const sessionHandleDeclarations = sessionsSource.statements.filter(
            (statement): statement is ts.InterfaceDeclaration => (
                ts.isInterfaceDeclaration(statement) && statement.name.text === 'SessionHandle'
            ),
        );
        if (sessionHandleDeclarations.length !== 1) {
            throw new Error('SessionHandle must have exactly one canonical interface declaration');
        }
        const [sessionHandleDeclaration] = sessionHandleDeclarations;
        if ((sessionHandleDeclaration.heritageClauses?.length ?? 0) > 0) {
            throw new Error('SessionHandle privacy census requires a direct interface declaration');
        }
        const sessionHandleMembers = new Set(sessionHandleDeclaration.members.flatMap((member) => {
            const { name } = member;
            if (!name) return [];
            if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return [name.text];
            return ts.isComputedPropertyName(name) && ts.isStringLiteral(name.expression)
                ? [name.expression.text]
                : [];
        }));

        expect({
            exports: PRIVACY_AMENDMENT_GATED_EXPORTS.filter((name) => names.has(name)),
            sessionHandleMembers: PRIVACY_AMENDMENT_GATED_SESSION_HANDLE_MEMBERS.filter((name) => (
                sessionHandleMembers.has(name)
            )),
        }).toEqual({
            exports: [],
            sessionHandleMembers: [],
        });
    });

    it('keeps raw Provider owner identities out of the author-facing binding declaration', () => {
        const declarations = emittedDeclarationsForSources(readSdkProgram(), [
            'src/agentRuntime/providerBinding.ts',
        ]);
        const providerBindingDeclaration = [...declarations.entries()].find(([fileName]) => (
            fileName.endsWith('/agentRuntime/providerBinding.d.ts')
        ))?.[1];
        expect(providerBindingDeclaration).toBeDefined();
        expect(providerBindingDeclaration).not.toMatch(
            /\b(?:AgentModelDescriptor|ProviderConnectionId|ProviderCredentialTransport)\b/u,
        );
        expect(providerBindingDeclaration).toContain(
            "import type { ProviderWireProtocol } from '@happier-dev/protocol';",
        );
    }, 45_000);

    inventoryIt('keeps host-private and retired mechanics out of every normal path', () => {
        const surface = exportedSymbols(readSdkProgram());
        const names = new Set(Object.values(surface).flatMap((symbols) => (
            symbols.map((symbol) => symbol.name)
        )));
        expect(HOST_PRIVATE_OR_RETIRED_EXPORTS.filter((name) => names.has(name))).toEqual([]);
    });
});
