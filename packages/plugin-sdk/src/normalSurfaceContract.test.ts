import {
    mkdirSync,
    mkdtempSync,
    readdirSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import ts from 'typescript';

import {
    NORMAL_ENTRYPOINTS,
    NORMAL_SURFACE_ALLOWLIST,
} from './normalSurfaceContract.js';

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
    'redactBugReportSensitiveText',
    'resolveConnectedAccountHostAdapter',
    'trimBugReportTextToMaxBytes',
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

function exportedSymbols(program: ts.Program): Readonly<Record<keyof typeof NORMAL_ENTRYPOINTS, readonly ts.Symbol[]>> {
    const checker = program.getTypeChecker();
    const packageRoot = fileURLToPath(new URL('..', import.meta.url));
    return Object.fromEntries(Object.entries(NORMAL_ENTRYPOINTS).map(([entrypoint, relativePath]) => {
        const sourceFile = program.getSourceFile(`${packageRoot}/${relativePath}`);
        if (!sourceFile) throw new Error(`Missing source file for ${entrypoint}: ${relativePath}`);
        const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
        if (!moduleSymbol) throw new Error(`Missing module symbol for ${entrypoint}`);
        return [entrypoint, checker.getExportsOfModule(moduleSymbol)];
    })) as unknown as Readonly<Record<keyof typeof NORMAL_ENTRYPOINTS, readonly ts.Symbol[]>>;
}

function emittedDeclarations(program: ts.Program): ReadonlyMap<string, string> {
    const declarations = new Map<string, string>();
    const packageRoot = fileURLToPath(new URL('..', import.meta.url));
    const declarationSources = [
        ...Object.values(NORMAL_ENTRYPOINTS),
        'src/activation.ts',
        'src/agentRuntime/context.ts',
        'src/agentRuntime/providerBinding.ts',
        'src/agentRuntime/surfaces.ts',
    ];
    for (const relativePath of declarationSources) {
        const sourceFile = program.getSourceFile(resolve(packageRoot, relativePath));
        if (!sourceFile) throw new Error(`Missing declaration source: ${relativePath}`);
        program.emit(sourceFile, (fileName, text) => {
            if (fileName.endsWith('.d.ts')) declarations.set(fileName, text);
        }, undefined, true);
    }
    return declarations;
}

let sdkDeclarations: ReadonlyMap<string, string> | undefined;

function readEmittedDeclarations(program: ts.Program): ReadonlyMap<string, string> {
    sdkDeclarations ??= emittedDeclarations(program);
    return sdkDeclarations;
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
    './agent-runtime:AgentRuntimeJsonValueSchema',
    './agent-runtime:AgentSessionRuntimeEventSchema',
    './ui/client:createPluginUiHostApiClient',
    './ui/build:PLUGIN_UI_BUILD_CONFIG_BASENAMES',
    './ui/build:createReactNativeRepackSharedModules',
    './ui/build:createReactNativeWebVitePlugins',
    './ui/build:definePluginUiBuildConfig',
    './ui/build:defineReactNativeWebViteBuildPreset',
    './testing:createPluginTestkit',
] as const;

// Approved PLAN A-15 fixes the complete seven-symbol root seed. These two
// structural contracts are retained by that explicit requirement.
const APPROVED_ROOT_SEED_KEYS = [
    '.:Disposable',
    '.:PluginErrorData',
] as const;

function directAuthorConsumers(repoRoot: string): Set<string> {
    const specifierEntrypoints = new Map(Object.keys(NORMAL_ENTRYPOINTS).map((entrypoint) => [
        entrypoint === '.'
            ? '@happier-dev/plugin-sdk'
            : `@happier-dev/plugin-sdk${entrypoint.slice(1)}`,
        entrypoint,
    ]));
    const ignoredDirectory = /^(?:node_modules|dist|dist\..+|package-dist|target|coverage|\.expo|\.next|\.project|\.restore\..+|\.backup\..+|\.tmp(?:\..+)?)$/u;
    const consumerFiles: string[] = [];
    const pendingDirectories = [
        'packages/plugins',
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
                && !/(?:\.test\.|\.spec\.|\.test-support\.|__tests__|\.testkit\.)/u.test(fileName)
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
            if (!entrypoint || !bindings || !ts.isNamedImports(bindings)) continue;
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
    const surface = exportedSymbols(program);
    const direct = directAuthorConsumers(repoRoot);
    const surfaceKeys = Object.entries(surface).flatMap(([entrypoint, symbols]) => (
        symbols.map((symbol) => `${entrypoint}:${symbol.name}`)
    ));
    if (surfaceKeys.every((key) => direct.has(key))) {
        return { direct, closure: new Set(direct) };
    }

    const targetKey = new Map<ts.Symbol, string>();
    const keys: string[] = [];
    for (const [entrypoint, symbols] of Object.entries(surface)) {
        for (const symbol of symbols) {
            const target = symbol.flags & ts.SymbolFlags.Alias
                ? checker.getAliasedSymbol(symbol)
                : symbol;
            const key = `${entrypoint}:${symbol.name}`;
            targetKey.set(target, key);
            keys.push(key);
        }
    }

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
                    const relativePath = relative(packageSourceRoot, fileName);
                    if (
                        relativePath === ''
                        || relativePath.startsWith('..')
                        || isAbsolute(relativePath)
                    ) {
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

describe('normal supported package surface', () => {
    it('counts only referenced imports from genuine plugin author sources', () => {
        const fixtureRoot = mkdtempSync(join(tmpdir(), 'happier-sdk-consumers-'));
        try {
            const hostSourceRoot = join(fixtureRoot, 'apps', 'cli', 'src');
            const sdkSourceRoot = join(fixtureRoot, 'packages', 'plugin-sdk', 'src');
            const sourceRoot = join(fixtureRoot, 'packages', 'plugins', 'plugin-fixture', 'src');
            mkdirSync(hostSourceRoot, { recursive: true });
            mkdirSync(sdkSourceRoot, { recursive: true });
            mkdirSync(sourceRoot, { recursive: true });
            writeFileSync(join(hostSourceRoot, 'host.ts'), `
import type {
    PluginExternalSessionsService as HostExternalSessions,
    PluginProjectsService as HostProjects,
} from '@happier-dev/plugin-sdk/runtime';

export type HostOnlyConsumers = readonly [HostExternalSessions, HostProjects];
`, 'utf8');
            writeFileSync(join(sdkSourceRoot, 'self.ts'), `
import type {
    PluginExternalSessionRef as SdkExternalSessionRef,
} from '@happier-dev/plugin-sdk/runtime';

export type SdkSelfConsumer = SdkExternalSessionRef;
`, 'utf8');
            writeFileSync(join(sourceRoot, 'index.ts'), `
import type {
    PluginLoggerService as UnusedLogger,
    PluginServices as UsedServices,
} from '@happier-dev/plugin-sdk/runtime';
import {
    type PluginEventsService as ShadowedEvents,
    type PluginSettingsService as UsedSettings,
} from '@happier-dev/plugin-sdk/runtime';

export type UsedConsumer = Readonly<{
    services: Pick<UsedServices, 'logger'>;
    settings: UsedSettings;
}>;

export function shadowOnly(ShadowedEvents: string): string {
    return ShadowedEvents;
}
`, 'utf8');
            writeFileSync(join(sourceRoot, 'host-coupled.test-support.ts'), `
import type { JsonValue } from '@happier-dev/plugin-sdk/runtime';

export type TestSupportOnly = JsonValue;
`, 'utf8');

            const direct = directAuthorConsumers(fixtureRoot);
            expect(direct.has('./runtime:PluginServices')).toBe(true);
            expect(direct.has('./runtime:PluginSettingsService')).toBe(true);
            expect(direct.has('./runtime:PluginLoggerService')).toBe(false);
            expect(direct.has('./runtime:PluginEventsService')).toBe(false);
            expect(direct.has('./runtime:PluginExternalSessionsService')).toBe(false);
            expect(direct.has('./runtime:PluginProjectsService')).toBe(false);
            expect(direct.has('./runtime:PluginExternalSessionRef')).toBe(false);
            expect(direct.has('./runtime:JsonValue')).toBe(false);
        } finally {
            rmSync(fixtureRoot, { recursive: true, force: true });
        }
    }, 15_000);

    it('publishes exactly the eight approved normal paths', () => {
        const packageRoot = fileURLToPath(new URL('..', import.meta.url));
        const packageJsonText = ts.sys.readFile(`${packageRoot}/package.json`);
        if (!packageJsonText) throw new Error('Unable to read plugin-sdk/package.json');
        const packageJson = JSON.parse(packageJsonText) as Readonly<{
            exports: Readonly<Record<string, unknown>>;
        }>;
        expect(Object.keys(packageJson.exports).filter((entrypoint) => (
            !entrypoint.startsWith('./experimental/')
            && !entrypoint.startsWith('./internal/')
        )).sort()).toEqual(Object.keys(NORMAL_ENTRYPOINTS).sort());
    });

    it('retains the approved 222-symbol distribution across the eight normal paths', () => {
        const counts = Object.values(NORMAL_SURFACE_ALLOWLIST).map((names) => names.length);

        expect(counts).toEqual([7, 4, 128, 71, 6, 1, 5, 1]);
        expect(counts.reduce((total, count) => total + count, 0)).toBe(223);
        expect(NORMAL_SURFACE_ALLOWLIST['./runtime'])
            .not.toContain('PluginVoiceAgentSessionRealtimeService');
        expect(NORMAL_SURFACE_ALLOWLIST['./runtime']).not.toContain('PluginNotificationBatchResult');
        expect(NORMAL_SURFACE_ALLOWLIST['./runtime']).not.toContain('PluginNotificationDeliveryResult');
        expect(NORMAL_SURFACE_ALLOWLIST['./runtime']).not.toContain('PluginNotificationSendRequest');
    });

    it('matches the exact consolidated candidate allowlist', () => {
        const surface = exportedSymbols(readSdkProgram());
        expect(surface['./runtime'].map((symbol) => symbol.name))
            .not.toContain('PluginVoiceAgentSessionRealtimeService');
        const actual = Object.fromEntries(Object.entries(surface).map(([entrypoint, symbols]) => [
            entrypoint,
            symbols.map((symbol) => symbol.name).sort(),
        ]));
        expect(actual).toEqual(NORMAL_SURFACE_ALLOWLIST);
    }, 45_000);

    it('keeps author documentation aligned with the retained normal-path owner', async () => {
        const readFile = await import('node:fs/promises').then((module) => module.readFile);
        const docs = await readFile(
            new URL('../../../apps/docs/content/docs/architecture/plugins/sdk-boundaries.mdx', import.meta.url),
            'utf8',
        );
        const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
        const entrypointSection = docs.match(
            /## Normal entrypoints\n\nThe normal-path allowlist is exact:\n\n(?<list>(?:- `[^`]+`\n)+)/u,
        )?.groups?.list;
        if (!entrypointSection) throw new Error('SDK boundary docs are missing the normal entrypoint list');
        const documentedEntrypoints = [...entrypointSection.matchAll(/^- `([^`]+)`$/gmu)]
            .map((match) => match[1])
            .sort();
        const expectedEntrypoints = Object.keys(NORMAL_ENTRYPOINTS)
            .map((entrypoint) => (
                entrypoint === '.'
                    ? '@happier-dev/plugin-sdk'
                    : `@happier-dev/plugin-sdk${entrypoint.slice(1)}`
            ))
            .sort();
        expect(documentedEntrypoints).toEqual(expectedEntrypoints);
        const readmeEntrypoints = readme.match(
            /The current G5 candidate has eight normal public paths:\n\n```text\n(?<list>[^`]+)```/u,
        )?.groups?.list.trim().split('\n').sort();
        expect(readmeEntrypoints).toEqual(expectedEntrypoints);

        const documentedRoot = docs.match(
            /The candidate minimal root contains\nonly (?<symbols>[^.]+)\./u,
        )?.groups?.symbols;
        if (!documentedRoot) throw new Error('SDK boundary docs are missing the normal root list');
        expect([...documentedRoot.matchAll(/`([^`]+)`/gu)].map((match) => match[1]).sort())
            .toEqual([...NORMAL_SURFACE_ALLOWLIST['.']].sort());
        const readmeRoot = readme.match(
            /The candidate root convenience\nsurface is limited to\n(?<symbols>[^.]+)\./u,
        )?.groups?.symbols;
        if (!readmeRoot) throw new Error('SDK README is missing the normal root list');
        expect([...readmeRoot.matchAll(/`([^`]+)`/gu)].map((match) => match[1]).sort())
            .toEqual([...NORMAL_SURFACE_ALLOWLIST['.']].sort());
    });

    it('uses only genuine plugin, packed-runtime, and approved-root bindings as declaration roots', () => {
        const program = readSdkProgram();
        const { direct } = readRealAuthorConsumers(program);
        const surfaceKeys = new Set(Object.entries(exportedSymbols(program)).flatMap(([entrypoint, symbols]) => (
            symbols.map((symbol) => `${entrypoint}:${symbol.name}`)
        )));
        expect([...direct].filter((key) => !surfaceKeys.has(key)).sort()).toEqual([]);
    }, 90_000);

    it('keeps every retained binding in a real author-facing declaration closure', () => {
        const program = readSdkProgram();
        const { closure } = readRealAuthorConsumers(program);
        const uncovered = Object.entries(exportedSymbols(program)).flatMap(([entrypoint, symbols]) => (
            symbols
                .map((symbol) => `${entrypoint}:${symbol.name}`)
                .filter((key) => !closure.has(key))
        )).sort();
        expect(uncovered).toEqual([]);
    }, 90_000);

    it('uses explicit normal entrypoint allowlists', async () => {
        for (const [entrypoint, relativePath] of Object.entries(NORMAL_ENTRYPOINTS)) {
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

    it('exports each supported symbol from exactly one normal path', () => {
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

    it('keeps normal and experimental symbols disjoint', () => {
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

    it('does not expose version-suffixed public types on normal paths', () => {
        const program = readSdkProgram();
        const checker = program.getTypeChecker();
        const surface = exportedSymbols(program);
        const versionedTypes = Object.entries(surface).flatMap(([entrypoint, symbols]) => (
            symbols.flatMap((symbol) => {
                const target = symbol.flags & ts.SymbolFlags.Alias
                    ? checker.getAliasedSymbol(symbol)
                    : symbol;
                return /V\d+$/.test(symbol.name) && target.flags & ts.SymbolFlags.Type
                    ? [`${entrypoint}:${symbol.name}`]
                    : [];
            })
        )).sort();
        expect(versionedTypes).toEqual([]);
    });

    it('does not alias normal runtime values from version-suffixed owners', async () => {
        const sourceText = await import('node:fs/promises').then(({ readFile }) => (
            readFile(new URL('./agent-runtime.ts', import.meta.url), 'utf8')
        ));
        expect(sourceText).not.toMatch(/\b[A-Za-z_$][\w$]*V\d+Schema\s+as\s+[A-Za-z_$][\w$]*Schema\b/u);
    });

    it('keeps every emitted normal entrypoint declaration unsuffixed', () => {
        const declarations = readEmittedDeclarations(readSdkProgram());
        const entrypointDeclarations = Object.values(NORMAL_ENTRYPOINTS).map((sourcePath) => (
            `dist/${sourcePath.replace(/^src\//u, '').replace(/\.ts$/u, '.d.ts')}`
        ));
        const leakedNames = [...declarations.entries()].flatMap(([fileName, text]) => {
            const relativeFileName = fileName.split('/packages/plugin-sdk/').at(-1);
            return relativeFileName && entrypointDeclarations.includes(relativeFileName)
                ? [...text.matchAll(/\b[A-Za-z_$][\w$]*V\d+\b/gu)].map((match) => (
                    `${relativeFileName}:${match[0]}`
                ))
                : [];
        });
        expect([...new Set(leakedNames)].sort()).toEqual([]);
    }, 45_000);

    it('keeps every normal public signature semantically unsuffixed and host-private-free', () => {
        const program = readSdkProgram();
        const checker = program.getTypeChecker();
        const packageRoot = fileURLToPath(new URL('..', import.meta.url));
        const packageSourceRoot = resolve(packageRoot, 'src');
        const findings: string[] = [];

        const visitTypeNode = (
            node: ts.Node,
            context: string,
            path: readonly string[] = [],
        ): void => {
            let nextPath = path;
            if (
                (ts.isPropertySignature(node) || ts.isMethodSignature(node) || ts.isParameter(node))
                && node.name
            ) {
                const pathSegment = ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)
                    || ts.isNumericLiteral(node.name)
                    ? node.name.text
                    : ts.SyntaxKind[node.name.kind];
                nextPath = [...path, pathSegment];
            }
            if (ts.isIdentifier(node)) {
                const name = node.text;
                if (/V\d+$/u.test(name) || HOST_PRIVATE_OR_RETIRED_EXPORTS.includes(
                    name as typeof HOST_PRIVATE_OR_RETIRED_EXPORTS[number],
                )) {
                    findings.push(`${context}${nextPath.length > 0 ? `.${nextPath.join('.')}` : ''} -> ${name}`);
                }
            }
            ts.forEachChild(node, (child) => visitTypeNode(child, context, nextPath));
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

                if (/V\d+$/u.test(target.name)) {
                    findings.push(`${context} -> alias target ${target.name}`);
                }
                if (
                    ts.isTypeAliasDeclaration(declaration)
                    && (() => {
                        const sourceRelativePath = relative(
                            packageSourceRoot,
                            declaration.getSourceFile().fileName,
                        );
                        return sourceRelativePath !== ''
                            && !sourceRelativePath.startsWith('..')
                            && !isAbsolute(sourceRelativePath);
                    })()
                ) {
                    visitTypeNode(declaration.type, `${context} -> alias RHS`);
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

    it('keeps the author-facing provider-binding declaration SDK-owned', () => {
        const declarations = readEmittedDeclarations(readSdkProgram());
        const providerBindingDeclaration = [...declarations.entries()].find(([fileName]) => (
            fileName.endsWith('/agentRuntime/providerBinding.d.ts')
        ))?.[1];
        expect(providerBindingDeclaration).toBeDefined();
        expect(providerBindingDeclaration).not.toContain('@happier-dev/protocol');
        expect(providerBindingDeclaration).not.toMatch(
            /\b(?:AgentModelDescriptor|ProviderConnectionId|ProviderCredentialTransport|ProviderWireProtocol)\b/u,
        );
    }, 45_000);

    it('keeps the normal MCP, Voice, and terminal declaration closure unsuffixed', () => {
        const declarations = readEmittedDeclarations(readSdkProgram());
        const declarationNames = [
            '/activation.d.ts',
            '/agentRuntime/surfaces.d.ts',
        ];
        const leakedNames = [...declarations.entries()].flatMap(([fileName, text]) => (
            declarationNames.some((suffix) => fileName.endsWith(suffix))
                ? [...text.matchAll(/\b[A-Za-z][A-Za-z0-9_]*V\d+\b/gu)].map((match) => (
                    `${fileName.split('/packages/plugin-sdk/').at(-1)}:${match[0]}`
                ))
                : []
        ));
        expect([...new Set(leakedNames)].sort()).toEqual([]);
        const contextDeclaration = [...declarations.entries()].find(([fileName]) => (
            fileName.endsWith('/agentRuntime/context.d.ts')
        ))?.[1];
        expect(contextDeclaration).toBeDefined();
        expect(contextDeclaration).not.toMatch(/\b[A-Za-z_$][\w$]*V\d+\b/u);
    }, 15_000);

    it('keeps host-private and retired mechanics out of every normal path', () => {
        const surface = exportedSymbols(readSdkProgram());
        const names = new Set(Object.values(surface).flatMap((symbols) => (
            symbols.map((symbol) => symbol.name)
        )));
        expect(HOST_PRIVATE_OR_RETIRED_EXPORTS.filter((name) => names.has(name))).toEqual([]);
    });
});
