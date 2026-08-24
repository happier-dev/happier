import {
    cpSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs';
import { readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

import * as ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import {
    compilePluginJsonSchema,
    isValidPluginJsonSchemaValue,
    isDynamicPluginResourceContributionV2,
    PluginContributionLocalIdSchema,
    normalizePluginDeclarativeDocumentV1,
    PLUGIN_DECLARATIVE_DOCUMENT_CONTENT_TYPE_V1,
} from '@happier-dev/protocol';
import type {
    JsonValue,
    DefinedPlugin,
    PluginAccountCollectionMigrationRuntimeProjection,
    PluginApi,
    PluginClientApi,
    PluginInvocationContext,
} from '@happier-dev/plugin-sdk';
import type {
    PluginClientActionContext,
    PluginClientActionHandler,
} from '@happier-dev/plugin-sdk/actions';
import type {
    PluginAccountCollection,
    PluginAccountCollectionDefinition,
    PluginAccountCollectionForDefinition,
} from '@happier-dev/plugin-sdk/collections';
import type {
    AccountKvService,
    PluginAccountStorageScope,
} from '@happier-dev/plugin-sdk/storage';
import type {
    SessionHandle,
    SessionSystemRecord,
} from '@happier-dev/plugin-sdk/sessions';
import type { PluginUiHostApi } from '@happier-dev/plugin-sdk/ui';
import { PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1 } from '@happier-dev/plugin-sdk/ui/build';
import {
    parsePluginManifest,
    type PluginManifest,
    type ParsedPluginManifest,
} from '../manifest.js';
import type {
    VoiceAccountOperationService,
} from '../voice/index.js';
import type { VoiceProvidersRegistrationApi } from '../voice/projections.js';
import type { SpeechProviderRuntime } from '../voice/speech.js';
import {
    createPluginTestkit,
    createPluginUiTestkit,
    type PluginUiSemanticSurfaceAdapter,
} from '../testing/index.js';
import { createSurfaceContextFixture } from '../ui/surfaceContext.fixture.js';

type RegisteredVoiceProviderRuntime = Parameters<VoiceProvidersRegistrationApi['register']>[1];

// This is the source-authoring harness: the public example entry must resolve
// against the current source SDK rather than an independently built package
// artifact. Packed-entry proof remains publisher-owned.
vi.mock('@happier-dev/plugin-sdk', async () => await import('../index.js'));

const packageRoot = fileURLToPath(new URL('../..', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../../..', import.meta.url));
const examplesRoot = join(packageRoot, 'examples');
const packageJsonPath = join(packageRoot, 'package.json');
const pluginUiPackageRoot = join(packageRoot, '..', 'plugin-ui');
const pluginUiPackageJsonPath = join(pluginUiPackageRoot, 'package.json');
const pluginUiDocsRoot = join(repoRoot, 'apps', 'docs', 'content', 'docs', 'plugins', 'ui');
const pluginGuidesDocsRoot = join(repoRoot, 'apps', 'docs', 'content', 'docs', 'plugins', 'guides');
const pluginExamplesDocsRoot = join(repoRoot, 'apps', 'docs', 'content', 'docs', 'plugins', 'examples');
const pluginDocsRoot = join(repoRoot, 'apps', 'docs', 'content', 'docs', 'plugins');
const sdkReadmePath = join(packageRoot, 'README.md');
const minimalManifestDocumentationPath = join(pluginDocsRoot, 'manifest', 'index.mdx');

type PublicAuthoringSourceActivationEntry = Readonly<{
    manifest: PluginManifest;
    activate: DefinedPlugin['activate'];
    collectionMigrations: PluginAccountCollectionMigrationRuntimeProjection;
}>;

async function loadPublicAuthoringSourceActivationEntry(): Promise<PublicAuthoringSourceActivationEntry> {
    // Exercise the source package entry wiring against the current source SDK.
    // The Vitest root mock above prevents this source test from accidentally
    // resolving a stale installed package; canonical staging separately proves
    // the emitted `dist/daemon.js` entry and generated manifest.
    const entry = await import(pathToFileURL(
        join(examplesRoot, 'public-authoring', 'index.ts'),
    ).href) as Partial<PublicAuthoringSourceActivationEntry>;
    if (!entry.manifest
        || typeof entry.activate !== 'function'
        || entry.collectionMigrations === undefined) {
        throw new TypeError('public_authoring_source_entry_missing_activation');
    }
    return entry as PublicAuthoringSourceActivationEntry;
}

// Do not statically import the copyable example into the SDK test TypeScript
// program: that would mix its public package declarations with this package's
// source declarations. The runtime entry remains real source wiring under the
// source-SDK mock above; emitted/package proof remains staging-owned.
const publicAuthoringCodeDefinedPlugin = await loadPublicAuthoringSourceActivationEntry();

const requiredExamples = [
    'descriptor-only',
    'hosted-web',
    'react-native-installed',
    'react-native-dev-hot-reload',
    'multi-mode-fallback',
] as const;

// These are author products, not a second compatibility matrix. The only
// values they assert come from the public SDK packet above; the tuple records
// each product's source shape so an omitted package cannot quietly escape the
// external-author contract.
const copyableExamples = [
    { name: 'background-indexer', sourceEntry: 'src/index.ts', ui: 'none', coldManifest: false },
    { name: 'descriptor-only', sourceEntry: 'src/index.ts', ui: 'none', coldManifest: true },
    { name: 'hosted-web', sourceEntry: 'src/index.ts', ui: 'hostedWeb', coldManifest: true },
    { name: 'react-native-installed', sourceEntry: 'src/index.ts', ui: 'reactNative', coldManifest: true },
    { name: 'projects-tasks', sourceEntry: 'src/index.ts', ui: 'reactNative', coldManifest: true },
    { name: 'react-native-dev-hot-reload', sourceEntry: 'src/index.ts', ui: 'reactNative', coldManifest: true },
    { name: 'multi-mode-fallback', sourceEntry: 'src/index.ts', ui: 'both', coldManifest: true },
    { name: 'production-hosted-reference', sourceEntry: 'index.ts', ui: 'hostedWeb', coldManifest: true },
    { name: 'code-defined', sourceEntry: 'index.ts', ui: 'none', coldManifest: false },
    { name: 'tracked-action', sourceEntry: 'index.ts', ui: 'none', coldManifest: false },
    { name: 'public-authoring', sourceEntry: 'index.ts', ui: 'both', coldManifest: false },
    { name: 'advanced-package-root', sourceEntry: 'index.ts', ui: 'none', coldManifest: false },
] as const;

type ReviewSessionStatusValue = Readonly<{
    id: string;
    summary: string;
}>;

function createNoopSemanticAdapter<TSurface>(): PluginUiSemanticSurfaceAdapter<TSurface> {
    return {
        async mount() {
            return {
                async snapshot() {
                    return { revision: 1, nodes: [] };
                },
                async update() {},
                async invoke() {},
                async dispose() {},
            };
        },
    };
}

function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return Object.freeze({ promise, resolve, reject });
}

function createHostedReviewPanelRoot() {
    const element = () => {
        const attributes = new Map<string, string>();
        return {
            textContent: '',
            hidden: false,
            onclick: null as null | (() => void),
            setAttribute(name: string, value: string) {
                attributes.set(name, value);
            },
            getAttribute(name: string) {
                return attributes.get(name) ?? null;
            },
            replaceChildren(...children: unknown[]) {
                this.textContent = children.map((child) => String(child)).join('');
            },
        };
    };
    const heading = element();
    const status = element();
    const guide = element();
    const result = element();
    const action = element();
    const root = {
        dataset: {} as Record<string, string>,
        querySelector(selector: string) {
            switch (selector) {
                case 'h1': return heading;
                case '[data-role="status"]': return status;
                case '[data-role="guide"]': return guide;
                case '[data-role="result"]': return result;
                case '[data-role="summarize"]': return action;
                default: return null;
            }
        },
    } as unknown as HTMLElement;
    return Object.freeze({ root, heading, status, guide, result, action });
}

/**
 * This is the narrow persisted-Account boundary fixture for the authored
 * Resource. It deliberately leaves every unused Collection/KV operation loud,
 * so the consumer cannot accidentally prove itself through a second storage
 * route or a local cache.
 */
function createReviewSessionStatusAccountStorage(summary: string | null) {
    let changeListener: (() => void) | undefined;
    let watchDisposed = false;
    let collectionRequests = 0;
    const get = vi.fn(async (rowId: string) => (
        summary === null
            ? null
            : Object.freeze({
                rowId,
                revision: 1,
                value: Object.freeze({ id: rowId, summary }),
            })
    ));
    const watch = vi.fn((request: Readonly<{ kind: 'collection' }>, listener: () => void) => {
        expect(request).toEqual({ kind: 'collection' });
        changeListener = () => listener();
        return {
            dispose() {
                watchDisposed = true;
            },
        };
    });
    const collection: PluginAccountCollection<ReviewSessionStatusValue> = {
        get,
        async identityTag() { throw new Error('review_session_status_fixture_identity_tag_not_expected'); },
        async put() { throw new Error('review_session_status_fixture_put_not_expected'); },
        async delete() { throw new Error('review_session_status_fixture_delete_not_expected'); },
        async query() { throw new Error('review_session_status_fixture_query_not_expected'); },
        async batch() { throw new Error('review_session_status_fixture_batch_not_expected'); },
        async limits() { throw new Error('review_session_status_fixture_limits_not_expected'); },
        async measureBatch() { throw new Error('review_session_status_fixture_measure_batch_not_expected'); },
        watch,
    };
    const kv: AccountKvService = {
        async get<T extends JsonValue>() { return null; },
        async set() { throw new Error('review_session_status_fixture_kv_set_not_expected'); },
        async delete() { throw new Error('review_session_status_fixture_kv_delete_not_expected'); },
        async list() { return { items: [] }; },
        async transaction<T>() { throw new Error('review_session_status_fixture_kv_transaction_not_expected') as never as T; },
    };
    const accountStorage: PluginAccountStorageScope = {
        kv,
        collection<TDefinition extends PluginAccountCollectionDefinition>(definition: TDefinition) {
            collectionRequests += 1;
            expect(definition.id).toBe('review-session-statuses');
            // The host boundary resolves the manifest-declared definition to its
            // matching Account Collection. The generic cast is confined to this
            // fixture because TypeScript cannot infer that runtime equality.
            return collection as unknown as PluginAccountCollectionForDefinition<TDefinition>;
        },
    };

    return Object.freeze({
        accountStorage,
        get,
        watch,
        collectionRequests: () => collectionRequests,
        emitChange() { changeListener?.(); },
        isWatchDisposed: () => watchDisposed,
    });
}

/**
 * A host-bound public Session capability fixture. The Companion owns no record
 * store: this boundary only models the public handle it is given by the host.
 */
function createReviewContextCompanionSessionBoundary() {
    const address = Object.freeze({
        owner: 'plugin' as const,
        namespace: 'agent-context-companion',
        kind: 'review-cursor',
        localId: 'current',
    });
    let record: SessionSystemRecord | null = null;
    let revision = 0;
    let conflictOnNextUpsert = false;

    const createRecord = (content: SessionSystemRecord['content']) => Object.freeze({
        id: 'agent-context-companion-record',
        address,
        content,
        revision: `revision-${++revision}`,
        createdAt: '2026-08-12T00:00:00.000Z',
        updatedAt: '2026-08-12T00:00:00.000Z',
    }) satisfies SessionSystemRecord;
    const readSystemRecord = vi.fn(async (
        request: Parameters<SessionHandle['readSystemRecord']>[0],
        options?: Parameters<SessionHandle['readSystemRecord']>[1],
    ): ReturnType<SessionHandle['readSystemRecord']> => {
        options?.signal?.throwIfAborted();
        expect(request).toEqual({ address });
        return record;
    });
    const upsertSystemRecord = vi.fn(async (
        request: Parameters<SessionHandle['upsertSystemRecord']>[0],
        options?: Parameters<SessionHandle['upsertSystemRecord']>[1],
    ): ReturnType<SessionHandle['upsertSystemRecord']> => {
        options?.signal?.throwIfAborted();
        expect(request.address).toEqual(address);
        if (conflictOnNextUpsert) {
            conflictOnNextUpsert = false;
            record = createRecord({
                version: 1,
                cursor: 'another-authorized-client',
                annotation: 'The other client won the revision race.',
            });
            const error = new Error('plugin_session_record_revision_conflict');
            Object.assign(error, { code: 'plugin_session_record_revision_conflict' });
            throw error;
        }
        if (request.expectedRevision !== (record?.revision ?? null)) {
            const error = new Error('plugin_session_record_revision_conflict');
            Object.assign(error, { code: 'plugin_session_record_revision_conflict' });
            throw error;
        }
        record = createRecord(request.content);
        return record;
    });
    const deleteSystemRecord = vi.fn(async (
        request: Parameters<SessionHandle['deleteSystemRecord']>[0],
        options?: Parameters<SessionHandle['deleteSystemRecord']>[1],
    ): ReturnType<SessionHandle['deleteSystemRecord']> => {
        options?.signal?.throwIfAborted();
        expect(request.address).toEqual(address);
        if (request.expectedRevision !== record?.revision) {
            const error = new Error('plugin_session_record_revision_conflict');
            Object.assign(error, { code: 'plugin_session_record_revision_conflict' });
            throw error;
        }
        record = null;
    });
    const handle = Object.freeze({
        readSystemRecord,
        upsertSystemRecord,
        deleteSystemRecord,
    }) satisfies Pick<SessionHandle,
        'readSystemRecord' | 'upsertSystemRecord' | 'deleteSystemRecord'>;
    const get = vi.fn(async (
        id: string,
        options?: Parameters<NonNullable<PluginInvocationContext['services']['sessions']['get']>>[1],
    ) => {
        options?.signal?.throwIfAborted();
        expect(id).toBe('session-1');
        return handle;
    });

    return Object.freeze({
        address,
        get,
        readSystemRecord,
        upsertSystemRecord,
        deleteSystemRecord,
        record: () => record,
        conflictOnNextUpsert: () => { conflictOnNextUpsert = true; },
    });
}

function createReviewContextCompanionInvocationContext(
    boundary: ReturnType<typeof createReviewContextCompanionSessionBoundary>,
    signal: AbortSignal,
): PluginInvocationContext {
    // Boundary fixture: the public handler reads only the Session service below.
    return Object.freeze({
        signal,
        services: Object.freeze({
            sessions: Object.freeze({ get: boundary.get }),
        }),
    }) as unknown as PluginInvocationContext;
}

async function listTypeScriptFiles(dir: string): Promise<readonly string[]> {
    const entries = await readdir(dir, { withFileTypes: true });
    const files = await Promise.all(entries.map(async (entry) => {
        const entryPath = join(dir, entry.name);
        if (entry.isDirectory()) {
            return listTypeScriptFiles(entryPath);
        }
        return entry.isFile() && /\.tsx?$/u.test(entry.name) ? [entryPath] : [];
    }));
    return files.flat().sort();
}

function readExampleManifest(exampleName: string): ParsedPluginManifest {
    const manifest = exampleName === 'public-authoring'
        ? publicAuthoringCodeDefinedPlugin.manifest
        : JSON.parse(readFileSync(
            join(examplesRoot, exampleName, '.happier-plugin', 'plugin.json'),
            'utf8',
        )) as unknown;
    const parsed = parsePluginManifest(manifest);
    const diagnostics = parsed.ok
        ? ''
        : `\n${parsed.diagnostics.map((diagnostic) => `${diagnostic.path?.join('.') || '<root>'}: ${diagnostic.message}`).join('\n')}`;
    expect(
        parsed.ok,
        `${exampleName} manifest must match the public manifest contract${diagnostics}`,
    ).toBe(true);
    if (!parsed.ok) {
        throw new Error(parsed.diagnostics.map((diagnostic) => diagnostic.message).join('; '));
    }
    return parsed.manifest;
}

function readPackageExportSpecifiers(path: string): ReadonlySet<string> {
    const packageJson = JSON.parse(readFileSync(path, 'utf8')) as {
        name: string;
        exports: Record<string, unknown>;
    };
    return new Set([
        packageJson.name,
        ...Object.keys(packageJson.exports)
            .filter((subpath) => !subpath.startsWith('./internal/'))
            .map((subpath) => `${packageJson.name}${subpath.slice(1)}`),
    ]);
}

function readExamplePackageJson(exampleName: string): Readonly<{
    name?: unknown;
    version?: unknown;
    type?: unknown;
    happier?: Readonly<{ manifest?: unknown }>;
    keywords?: unknown;
    files?: unknown;
    scripts?: Readonly<Record<string, unknown>>;
    dependencies?: Readonly<Record<string, unknown>>;
    devDependencies?: Readonly<Record<string, unknown>>;
}> {
    return JSON.parse(readFileSync(join(examplesRoot, exampleName, 'package.json'), 'utf8')) as {
        name?: unknown;
        version?: unknown;
        type?: unknown;
        happier?: Readonly<{ manifest?: unknown }>;
        keywords?: unknown;
        files?: unknown;
        scripts?: Readonly<Record<string, unknown>>;
        dependencies?: Readonly<Record<string, unknown>>;
        devDependencies?: Readonly<Record<string, unknown>>;
    };
}

function expectPackedLifecycleAction(
    manifest: ParsedPluginManifest,
    localId: string,
): void {
    const action = manifest.contributes.actions.find((candidate) => candidate.id === localId);
    expect(action, `${manifest.id}/${localId} must declare its packed lifecycle Action`).toBeDefined();
    if (!action) {
        throw new Error(`${manifest.id}/${localId} action missing`);
    }

    // `happier plugins test . --packed` intentionally invokes only a safe CLI
    // Action that accepts `{}`. Keeping that contract in the production
    // references proves their package/load check reaches their own behavior,
    // rather than stopping after install because a required fixture input was
    // unavailable to the canonical packed-test owner.
    expect(action.dangerLevel).toBe('safe');
    expect(action.scopes).toContain('global');
    expect(action.surfaces).toContain('cli');
    const inputSchema = action.inputSchema;
    expect(
        inputSchema === undefined
            || (
                inputSchema !== null
                && typeof inputSchema === 'object'
                && isValidPluginJsonSchemaValue(compilePluginJsonSchema(inputSchema), {})
            ),
        `${manifest.id}/${localId} must accept the packed lifecycle's empty CLI input`,
    ).toBe(true);
}

function expectPackagedReferenceResource(params: Readonly<{
    exampleName: string;
    manifest: ParsedPluginManifest;
    localId: string;
}>): void {
    const resource = params.manifest.contributes.resources
        .find((candidate) => candidate.id === params.localId);
    expect(resource, `${params.manifest.id}/${params.localId} resource declaration`).toBeDefined();
    if (!resource) {
        throw new Error(`${params.manifest.id}/${params.localId} resource missing`);
    }
    if (
        resource === null
        || typeof resource !== 'object'
        || isDynamicPluginResourceContributionV2(resource)
        || !('path' in resource)
        || typeof resource.path !== 'string'
    ) {
        throw new Error(`${params.manifest.id}/${params.localId} must declare a packaged Resource`);
    }
    const resourcePath = resource.path;

    expect(resource).toMatchObject({
        source: 'packaged',
        kind: 'template',
        path: 'resources/review-guide.md',
        contentType: 'text/markdown',
    });
    expect(existsSync(join(examplesRoot, params.exampleName, resourcePath))).toBe(true);
    const packageJson = readExamplePackageJson(params.exampleName);
    expect(packageJson.files).toContain('resources');
}

function sourceExportsName(sourcePath: string, exportName: string): boolean {
    const sourceFile = ts.createSourceFile(
        sourcePath,
        readFileSync(sourcePath, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
    );
    const isExported = (node: ts.Node): boolean => Boolean(
        ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Export,
    );
    return sourceFile.statements.some((statement) => {
        if (ts.isFunctionDeclaration(statement)) {
            return isExported(statement) && statement.name?.text === exportName;
        }
        if (ts.isVariableStatement(statement)) {
            return isExported(statement) && statement.declarationList.declarations.some((declaration) => (
                ts.isIdentifier(declaration.name) && declaration.name.text === exportName
            ));
        }
        return ts.isExportDeclaration(statement)
            && statement.exportClause !== undefined
            && ts.isNamedExports(statement.exportClause)
            && statement.exportClause.elements.some((element) => element.name.text === exportName);
    });
}

function readFencedCode(
    documentPath: string,
    language: 'ts' | 'tsx',
    occurrence = 0,
): string {
    const source = readFileSync(documentPath, 'utf8');
    const blocks = [...source.matchAll(new RegExp(
        ['```', language, '\\n([\\s\\S]*?)\\n```'].join(''),
        'gu',
    ))];
    const block = blocks[occurrence]?.[1];
    if (block === undefined) {
        throw new Error(`Expected ${language} code block ${String(occurrence)} in ${documentPath}`);
    }
    return block;
}

type FencedCodeBlock = Readonly<{
    language: string;
    source: string;
}>;

function readFencedCodeBlocks(documentPath: string): readonly FencedCodeBlock[] {
    const source = readFileSync(documentPath, 'utf8');
    return [...source.matchAll(/```([^\n]*)\n([\s\S]*?)\n```/gu)].map((match) => ({
        language: match[1].trim(),
        source: match[2],
    }));
}

function containsDefinePluginCall(source: string): boolean {
    const sourceFile = ts.createSourceFile(
        'documented-plugin-example.ts',
        source,
        ts.ScriptTarget.Latest,
        true,
    );
    let found = false;
    const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node)
            && ts.isIdentifier(node.expression)
            && node.expression.text === 'definePlugin') {
            found = true;
            return;
        }
        ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return found;
}

function propertyName(node: ts.PropertyName | undefined): string | undefined {
    if (!node) return undefined;
    if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)) {
        return node.text;
    }
    return undefined;
}

function hasDocumentedPluginDaemonEntrypoint(source: string): boolean {
    const sourceFile = ts.createSourceFile(
        'documented-plugin-example.ts',
        source,
        ts.ScriptTarget.Latest,
        true,
    );
    let found = false;
    let everyDocumentedPluginHasDaemonEntrypoint = true;
    const visit = (node: ts.Node): void => {
        if (
            ts.isCallExpression(node)
            && ts.isIdentifier(node.expression)
            && node.expression.text === 'definePlugin'
            && ts.isObjectLiteralExpression(node.arguments[0])
        ) {
            const entrypoints = node.arguments[0].properties.find((property) => (
                ts.isPropertyAssignment(property) && propertyName(property.name) === 'entrypoints'
            ));
            const hasDaemonEntrypoint = Boolean(
                entrypoints
                && ts.isPropertyAssignment(entrypoints)
                && ts.isObjectLiteralExpression(entrypoints.initializer)
                && entrypoints.initializer.properties.some((property) => (
                    ts.isPropertyAssignment(property)
                    && propertyName(property.name) === 'daemon'
                    && ts.isStringLiteral(property.initializer)
                )),
            );
            found = true;
            everyDocumentedPluginHasDaemonEntrypoint &&= hasDaemonEntrypoint;
        }
        ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return found && everyDocumentedPluginHasDaemonEntrypoint;
}

function collectDocumentationLocalIds(source: string): readonly string[] {
    const sourceFile = ts.createSourceFile(
        'documented-plugin-example.ts',
        source,
        ts.ScriptTarget.Latest,
        true,
    );
    const values: string[] = [];
    const localIdMaps = new Set([
        'actions',
        'agents',
        'accountCollections',
        'backgroundServices',
        'commands',
        'events',
        'hooks',
        'managedServices',
        'mcpServers',
        'notificationChannels',
        'promptAssets',
        'resources',
        'settings',
        'tools',
        'webhooks',
    ]);
    const visit = (node: ts.Node, parentProperty: string | undefined): void => {
        if (ts.isCallExpression(node)
            && ts.isIdentifier(node.expression)
            && (node.expression.text === 'definePlugin'
                || node.expression.text === 'defineAccountCollection'
                || node.expression.text === 'defineUiSurfaceDefinition')) {
            const parentExpression = node.expression.text;
            const argument = node.arguments[0];
            if (argument && ts.isObjectLiteralExpression(argument)) {
                ts.forEachChild(argument, (child) => visit(child, parentExpression));
            }
            return;
        }
        if (ts.isPropertyAssignment(node)) {
            const name = propertyName(node.name);
            if (name === 'localId' && ts.isStringLiteral(node.initializer)) {
                values.push(node.initializer.text);
            }
            if (name && localIdMaps.has(name) && ts.isObjectLiteralExpression(node.initializer)) {
                for (const child of node.initializer.properties) {
                    const childName = propertyName(
                        ts.isPropertyAssignment(child) || ts.isMethodDeclaration(child)
                            ? child.name
                            : undefined,
                    );
                    if (childName) values.push(childName);
                }
            }
            if (name === 'id' && parentProperty === 'defineAccountCollection'
                && ts.isStringLiteral(node.initializer)) {
                values.push(node.initializer.text);
            }
            if (name === 'id' && parentProperty === 'defineUiSurfaceDefinition'
                && ts.isStringLiteral(node.initializer)) {
                values.push(node.initializer.text);
            }
            ts.forEachChild(node.initializer, (child) => visit(child, name));
            return;
        }
        ts.forEachChild(node, (child) => visit(child, parentProperty));
    };
    // The parent marker lets us distinguish a plugin's top-level id from
    // collection/surface ids while still walking every nested declaration.
    for (const statement of sourceFile.statements) {
        if (ts.isVariableStatement(statement)) {
            ts.forEachChild(statement, (child) => visit(child, undefined));
        } else {
            visit(statement, undefined);
        }
    }
    return values;
}

function collectManifestJsonLocalIds(value: unknown): readonly string[] {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
    const contributes = (value as Readonly<{ contributes?: unknown }>).contributes;
    if (!contributes || typeof contributes !== 'object' || Array.isArray(contributes)) return [];

    const values: string[] = [];
    for (const contribution of Object.values(contributes as Record<string, unknown>)) {
        if (Array.isArray(contribution)) {
            for (const row of contribution) {
                if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
                const candidate = row as Readonly<{ id?: unknown; action?: unknown; localId?: unknown }>;
                for (const field of [candidate.id, candidate.action, candidate.localId]) {
                    if (typeof field === 'string') values.push(field);
                }
            }
        } else if (contribution && typeof contribution === 'object') {
            for (const key of Object.keys(contribution)) values.push(key);
        }
    }
    return values;
}

function expectDocumentationLocalId(value: string, location: string): void {
    expect(
        PluginContributionLocalIdSchema.safeParse(value).success,
        `${location} uses non-canonical contribution local id '${value}'`,
    ).toBe(true);
}

async function listMdxFiles(dir: string): Promise<readonly string[]> {
    const entries = await readdir(dir, { withFileTypes: true });
    const files = await Promise.all(entries.map(async (entry) => {
        const entryPath = join(dir, entry.name);
        if (entry.isDirectory()) return listMdxFiles(entryPath);
        return entry.isFile() && entry.name.endsWith('.mdx') ? [entryPath] : [];
    }));
    return files.flat().sort();
}

async function listPublishedAuthoringDocumentationFiles(): Promise<readonly string[]> {
    return [
        ...await listMdxFiles(pluginDocsRoot),
        sdkReadmePath,
    ].sort();
}

function publishedAuthoringDocumentationKey(documentPath: string): string {
    return documentPath === sdkReadmePath
        ? 'README.md'
        : relative(pluginDocsRoot, documentPath);
}

/**
 * Complete documentation examples may name a real, separately compiled
 * companion leaf. Stage that maintained source beside the extracted package
 * root so this source-level contract exercises the same ESM resolution an
 * author uses, rather than replacing the import with a test-only stub.
 */
const documentedSnippetSupportFiles = new Map<string, readonly Readonly<{
    source: string;
    destination: string;
}>[]>([
    ['surfaces/external-sessions.mdx#0', [{
        source: 'advanced-package-root/agent/reviewAgent.ts',
        destination: 'agent/reviewAgent.ts',
    }]],
    ['surfaces/external-sessions.mdx#5', [{
        source: 'advanced-package-root/agent/reviewAgent.ts',
        destination: 'agent/reviewAgent.ts',
    }]],
    ['surfaces/external-sessions.mdx#6', [{
        source: 'advanced-package-root/agent/reviewAgent.ts',
        destination: 'agent/reviewAgent.ts',
    }]],
    ['surfaces/external-sessions.mdx#8', [{
        source: 'advanced-package-root/agent/reviewAgent.ts',
        destination: 'agent/reviewAgent.ts',
    }]],
]);

function shouldCopyExamplePath(source: string): boolean {
    return !source.split(/[\\/]+/u).some((segment) => segment === 'node_modules' || segment === 'dist');
}

function findInstalledPackageRoot(packageName: string): string | undefined {
    const pathSegments = packageName.split('/');
    for (const nodeModulesRoot of [
        join(packageRoot, 'node_modules'),
        join(repoRoot, 'node_modules'),
    ]) {
        const candidate = join(nodeModulesRoot, ...pathSegments);
        if (existsSync(candidate)) {
            return candidate;
        }
    }
    return undefined;
}

function linkDeclaredExampleDependencies(tempRoot: string): void {
    const destinationNodeModules = join(tempRoot, 'node_modules');
    const linkedPackages = new Set([
        '@happier-dev/plugin-sdk',
        '@happier-dev/plugin-ui',
    ]);

    for (const example of copyableExamples) {
        const packageJson = readExamplePackageJson(example.name);
        const packageNames = [
            ...Object.keys(packageJson.dependencies ?? {}),
            ...Object.keys(packageJson.devDependencies ?? {}),
        ];
        for (const packageName of packageNames) {
            if (linkedPackages.has(packageName)) {
                continue;
            }
            linkedPackages.add(packageName);

            const installedRoot = findInstalledPackageRoot(packageName);
            // This source-level declaration probe models an author package
            // after its declared direct dependencies are installed. Build-only
            // dependencies can legitimately be absent in this checkout; they
            // are exercised by the managed candidate build instead.
            if (!installedRoot) {
                continue;
            }

            const destination = join(destinationNodeModules, ...packageName.split('/'));
            mkdirSync(join(destination, '..'), { recursive: true });
            symlinkSync(installedRoot, destination, 'dir');
        }
    }
}

function copyExamplesOutsideWorkspace(): string {
    const tempRoot = mkdtempSync(join(tmpdir(), 'happier-plugin-sdk-examples-'));
    cpSync(examplesRoot, tempRoot, {
        recursive: true,
        filter: shouldCopyExamplePath,
    });
    mkdirSync(join(tempRoot, 'node_modules', '@happier-dev'), { recursive: true });
    symlinkSync(packageRoot, join(tempRoot, 'node_modules', '@happier-dev', 'plugin-sdk'), 'dir');
    symlinkSync(pluginUiPackageRoot, join(tempRoot, 'node_modules', '@happier-dev', 'plugin-ui'), 'dir');
    linkDeclaredExampleDependencies(tempRoot);
    return tempRoot;
}

describe('public SDK authoring examples', { timeout: 60_000 }, () => {
    it('includes the one-file code-defined workflow without authored JSON metadata', () => {
        const sourcePath = join(examplesRoot, 'code-defined', 'index.ts');
        const source = readFileSync(sourcePath, 'utf8');
        expect(source).toContain("from '@happier-dev/plugin-sdk'");
        expect(source).toMatch(/export const \{ manifest, activate \} = definePlugin/u);
        expect(existsSync(join(examplesRoot, 'code-defined', '.happier-plugin', 'plugin.json'))).toBe(false);
    });

    it('does not synthesize a host engine constraint into code-defined authoring examples', async () => {
        const [codeDefined, advanced] = await Promise.all([
            import(pathToFileURL(join(examplesRoot, 'code-defined', 'index.ts')).href),
            import(pathToFileURL(join(examplesRoot, 'advanced-package-root', 'index.ts')).href),
        ]) as readonly [
            Readonly<{ manifest: PluginManifest }>,
            Readonly<{ manifest: PluginManifest }>,
        ];

        expect(codeDefined.manifest.engines).toBeUndefined();
        expect(publicAuthoringCodeDefinedPlugin.manifest.engines).toBeUndefined();
        expect(advanced.manifest.engines).toBeUndefined();
    });

    it('runs the Background Indexer through its declared public daemon-database and background-service seams', async () => {
        // The Background Indexer authors one source module through the single
        // public `definePlugin(...)` path: its cold manifest is projected from
        // that module, never hand-maintained beside it.
        expect(existsSync(join(examplesRoot, 'background-indexer', '.happier-plugin', 'plugin.json')))
            .toBe(false);

        const module = await import(pathToFileURL(join(
            examplesRoot,
            'background-indexer',
            'src',
            'index.ts',
        )).href) as Readonly<{
            activate(api: Pick<PluginApi, 'backgroundServices'>): void;
            daemonDatabases: Readonly<Record<string, unknown>>;
        }>;
        const runners = new Map<string, (context: unknown) => Promise<void>>();
        module.activate({
            backgroundServices: {
                register(localId, runner) {
                    runners.set(localId, runner as (context: unknown) => Promise<void>);
                },
            },
        });
        expect(Object.keys(module.daemonDatabases)).toEqual(['workspace-index']);
        const runner = runners.get('workspace-indexer');
        if (!runner) throw new Error('background_indexer_runner_not_registered');

        const execute = vi.fn(async () => ({ changes: 1 }));
        const query = vi.fn(async () => [{
            path: '.happier/background-indexer',
            content_digest: 'background-indexer-v1',
        }]);
        const transaction = vi.fn(async (operation: (database: Readonly<{
            execute: typeof execute;
            query: typeof query;
        }>) => Promise<unknown>) => await operation({ execute, query }));
        const database = Object.freeze({ query, transaction });
        const open = vi.fn(async () => database);
        const signal = new AbortController().signal;
        await runner({
            signal,
            services: {
                storage: {
                    daemon: { database: open },
                },
            },
        });

        expect(open).toHaveBeenCalledWith('workspace-index', expect.objectContaining({
            signal,
            migrations: expect.any(Array),
            incumbentQueryFixture: expect.objectContaining({ id: 'workspace-index-v1' }),
        }));
        expect(transaction).toHaveBeenCalledOnce();
        expect(execute).toHaveBeenCalledWith(
            expect.stringContaining('INSERT INTO workspace_documents'),
            expect.arrayContaining(['.happier/background-indexer', 'background-indexer-v1']),
            { signal },
        );
        expect(query).toHaveBeenCalledWith(
            expect.stringContaining('SELECT path, content_digest'),
            ['.happier/background-indexer'],
            { signal },
        );

        const cancelled = new AbortController();
        cancelled.abort('background_service_retired');
        await expect(runner({
            signal: cancelled.signal,
            services: { storage: { daemon: { database: open } } },
        })).rejects.toThrow();
        expect(open).toHaveBeenCalledOnce();
    });

    it('typechecks the Background Indexer outside the workspace through published SDK entry points', () => {
        const copiedRoot = copyExamplesOutsideWorkspace();
        try {
            const configPath = join(copiedRoot, 'background-indexer.tsconfig.json');
            const outputRoot = '.background-indexer-output';
            writeFileSync(configPath, `${JSON.stringify({
                compilerOptions: {
                    target: 'ES2022',
                    module: 'ESNext',
                    moduleResolution: 'Bundler',
                    lib: ['ES2022', 'DOM'],
                    strict: true,
                    skipLibCheck: true,
                    declaration: true,
                    rootDir: '.',
                    outDir: outputRoot,
                },
                files: ['background-indexer/src/index.ts'],
            }, null, 2)}\n`, 'utf8');

            const typecheck = spawnSync(process.execPath, [
                join(repoRoot, 'scripts', 'workspaces', 'runTypeScriptCli.mjs'),
                '-p',
                configPath,
            ], {
                cwd: copiedRoot,
                encoding: 'utf8',
            });
            expect(
                typecheck.status,
                [typecheck.stdout, typecheck.stderr].filter(Boolean).join('\n'),
            ).toBe(0);

            const declaration = readFileSync(join(
                copiedRoot,
                outputRoot,
                'background-indexer',
                'src',
                'index.d.ts',
            ), 'utf8');
            expect(declaration).toContain('@happier-dev/plugin-sdk');
            expect(declaration).not.toMatch(/(?:apps[\\/]cli|packages[\\/]|node:sqlite|bun:sqlite)/u);
        } finally {
            rmSync(copiedRoot, { recursive: true, force: true });
        }
    });

    it('ships every copyable authoring example as a complete package derived from the public toolchain bindings', () => {
        for (const example of copyableExamples) {
            const root = join(examplesRoot, example.name);
            const packageJson = readExamplePackageJson(example.name);
            const dependencies = packageJson.dependencies ?? {};
            const devDependencies = packageJson.devDependencies ?? {};

            expect(existsSync(join(root, example.sourceEntry)), `${example.name}/${example.sourceEntry}`).toBe(true);
            expect(existsSync(join(root, 'tsconfig.json')), `${example.name}/tsconfig.json`).toBe(true);
            expect(existsSync(join(root, 'test', 'index.test.mjs')), `${example.name}/test/index.test.mjs`).toBe(true);
            expect(packageJson.name, `${example.name} package name`).toMatch(/^@(?:example|happier-dev)\//u);
            expect(packageJson.version, `${example.name} package version`).toBe('0.1.0');
            expect(packageJson.type).toBe('module');
            expect(packageJson.happier?.manifest).toBe('.happier-plugin/plugin.json');
            expect(packageJson.keywords).toContain('happier-plugin');
            expect(packageJson.files).toContain('dist');
            expect(packageJson.scripts).toMatchObject({
                build: 'happier plugins author build .',
                typecheck: 'happier plugins author typecheck .',
                test: 'happier plugins test .',
                'pack:plugin': 'happier plugins pack .',
            });
            expect(dependencies['@happier-dev/plugin-sdk']).toBe(
                PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1.dependencies['@happier-dev/plugin-sdk'],
            );
            expect(devDependencies['@types/node']).toBe(
                PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1.devDependencies['@types/node'],
            );
            expect(devDependencies['@typescript/native']).toBe(
                PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1.devDependencies['@typescript/native'],
            );
            for (const dependencySpec of [
                ...Object.values(dependencies),
                ...Object.values(devDependencies),
            ]) {
                expect(String(dependencySpec), `${example.name} must not import the workspace`).not.toMatch(
                    /(?:workspace:|file:|\.\.[\\/])/u,
                );
            }

            if (example.coldManifest) {
                expect(packageJson.files).toContain('.happier-plugin');
            } else {
                expect(packageJson.files).not.toContain('.happier-plugin');
            }

            if (example.ui === 'hostedWeb' || example.ui === 'both') {
                expect(packageJson.scripts?.['build:ui']).toBe('happier-plugin-build-ui --project-root .');
                expect(devDependencies.vite).toBe(
                    PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1.devDependencies.vite,
                );
                expect(
                    example.ui === 'hostedWeb' ? devDependencies.react : dependencies.react,
                ).toBe(PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1.dependencies.react);
                expect(existsSync(join(root, 'index.html')), `${example.name}/index.html`).toBe(true);
                expect(existsSync(join(root, 'vite.config.mjs')), `${example.name}/vite.config.mjs`).toBe(false);
            }

            if (example.ui === 'reactNative' || example.ui === 'both') {
                expect(packageJson.scripts?.['build:ui']).toBe('happier-plugin-build-ui --project-root .');
                expect(dependencies).toMatchObject({
                    '@happier-dev/plugin-ui': PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1.dependencies['@happier-dev/plugin-ui'],
                    react: PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1.dependencies.react,
                    'react-dom': PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1.dependencies['react-dom'],
                    'react-native': PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1.dependencies['react-native'],
                    'react-native-web': PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1.dependencies['react-native-web'],
                });
                expect(devDependencies).toMatchObject({
                    vite: PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1.devDependencies.vite,
                    '@vitejs/plugin-react': PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1.devDependencies['@vitejs/plugin-react'],
                    '@types/react': PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1.devDependencies['@types/react'],
                    '@callstack/repack': PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1.devDependencies['@callstack/repack'],
                    '@react-native-community/cli': PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1.devDependencies['@react-native-community/cli'],
                    '@rspack/core': PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1.devDependencies['@rspack/core'],
                    '@swc/helpers': PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1.devDependencies['@swc/helpers'],
                });
                expect(
                    existsSync(join(root, 'rspack.config.mjs')),
                    `${example.name}/rspack.config.mjs`,
                ).toBe(false);
                expect(
                    existsSync(join(root, 'react-native.config.cjs')),
                    `${example.name}/react-native.config.cjs`,
                ).toBe(false);
            }
        }
    });

    it('keeps the production Inspector RN and hosted references distinct, lifecycle-bearing packages', () => {
        const inspectorRoot = join(repoRoot, 'packages', 'plugins', 'inspector');
        const inspectorManifest = JSON.parse(readFileSync(
            join(inspectorRoot, '.happier-plugin', 'plugin.json'),
            'utf8',
        )) as {
            contributes?: {
                resources?: readonly { id?: string; kind?: string; path?: string }[];
                ui?: { renderers?: readonly { artifact?: string; id?: string; kind?: string }[] };
            };
        };
        const publicAuthoringCompanionReadme = readFileSync(
            join(examplesRoot, 'public-authoring', 'README.md'),
            'utf8',
        );
        const hostedRoot = join(examplesRoot, 'production-hosted-reference');
        const hostedManifest = readExampleManifest('production-hosted-reference');
        const hostedPackage = readExamplePackageJson('production-hosted-reference');
        const hostedSource = readFileSync(join(hostedRoot, 'ui', 'reviewPanel.web.ts'), 'utf8');
        const hostedReadme = readFileSync(join(hostedRoot, 'README.md'), 'utf8');

        expect(inspectorRoot).not.toBe(hostedRoot);
        expect(inspectorManifest.contributes?.ui?.renderers).toContainEqual(expect.objectContaining({
            id: 'inspector-renderer',
            kind: 'reactNative',
            artifact: 'inspector-app-native',
        }));
        expect(inspectorManifest.contributes?.resources).toContainEqual(expect.objectContaining({
            id: 'brand-icon',
            kind: 'asset',
            path: 'assets/brand.png',
        }));
        expect(publicAuthoringCompanionReadme).toMatch(
            /It is not the portfolio's\s+production React Native or hosted reference\./u,
        );

        const hostedRenderer = hostedManifest.contributes.ui.renderers.find((renderer) => (
            renderer.id === 'review-hosted'
        ));
        expect(hostedRenderer).toMatchObject({
            kind: 'hostedWeb',
            source: { kind: 'artifact', artifact: 'review-hosted' },
            requiredHostMethods: expect.arrayContaining(['context', 'executeAction', 'readResource', 'openSurface']),
        });
        expect(hostedManifest.contributes.resources).toContainEqual(expect.objectContaining({
            id: 'review-guide',
            source: 'packaged',
            kind: 'template',
            path: 'resources/review-guide.md',
        }));
        expect(hostedManifest.brand).toEqual({ iconResourceId: 'brand-icon' });
        expect(hostedManifest.contributes.resources).toContainEqual(expect.objectContaining({
            id: 'brand-icon',
            kind: 'asset',
            path: 'assets/brand.png',
            contentType: 'image/png',
        }));
        expect(hostedPackage.files).toContain('assets');
        expect(hostedPackage.dependencies?.['@happier-dev/plugin-ui']).toBe(
            PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1.dependencies['@happier-dev/plugin-ui'],
        );
        expect(existsSync(join(hostedRoot, 'assets', 'brand.png'))).toBe(true);
        expect(hostedSource).toContain('createPluginUiRenderContext');
        expect(hostedSource).toContain("readResource('review-guide'");
        expect(hostedSource).toContain('context.subPath');
        expect(hostedSource).toContain('context.launchInput');
        expect(hostedSource).toMatch(/openSurface\(\s*'review-dashboard'/u);
        expect(hostedSource).toContain('watchContext');
        expect(hostedSource).toContain("context.signal.addEventListener('abort'");
        expect(hostedSource).toContain('dispose()');
        expect(hostedSource).toContain('if (context.signal.aborted) return;\n            throw error;');
        expect(hostedSource).toContain('setStatus(root, message, \'error\')');
        expect(hostedSource).not.toMatch(/(?:window\.parent|location\.(?:search|hash)|URLSearchParams)/u);
        expect(hostedSource).not.toMatch(/(?:createObjectURL|data:image|<img)/u);
        expect(existsSync(join(hostedRoot, 'test', 'index.test.mjs'))).toBe(true);
        expect(hostedReadme).toMatch(/brand presentation owns byte validation and its neutral\s+fallback/u);
        expect(hostedReadme).toContain(
            'real emitted graph is checked against the incumbent installed-Artifact',
        );
        expect(hostedReadme).toContain('there is no global fixed candidate');
    });

    it('uses cold JSON only for cold-manifest examples and code-defined public authoring without startup activation', () => {
        const exampleNames = [
            ...requiredExamples,
            'production-hosted-reference',
        ] as const;

        for (const exampleName of exampleNames) {
            const manifestPath = join(examplesRoot, exampleName, '.happier-plugin', 'plugin.json');
            const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown;
            const parsed = parsePluginManifest(manifest);

            expect(
                parsed.ok,
                `${exampleName}/.happier-plugin/plugin.json must be a valid public author source`,
            ).toBe(true);
            expect(
                existsSync(join(examplesRoot, exampleName, 'manifest.ts')),
                `${exampleName} must not teach an executable TypeScript manifest`,
            ).toBe(false);
            const sourceEntryPath = join(examplesRoot, exampleName, 'src', 'index.ts');
            if (existsSync(sourceEntryPath)) {
                expect(readFileSync(sourceEntryPath, 'utf8')).not.toMatch(
                    /\bexport\s+const\s+manifest\b/u,
                );
            }
            if (parsed.ok) {
                expect(parsed.manifest.activation?.events ?? []).not.toContainEqual({ kind: 'startup' });
            }
        }

        const publicAuthoringRoot = join(examplesRoot, 'public-authoring');
        const publicAuthoringEntry = readFileSync(join(publicAuthoringRoot, 'index.ts'), 'utf8');
        expect(existsSync(join(publicAuthoringRoot, '.happier-plugin', 'plugin.json'))).toBe(false);
        expect(publicAuthoringEntry).toMatch(
            /export const \{ manifest, activate, collectionMigrations \} = definePlugin/u,
        );
        expect(readExampleManifest('public-authoring').activation?.events ?? []).not.toContainEqual({ kind: 'startup' });
    });

    it('binds code-defined public authoring manifest projection and runtime registrations to its declared daemon entrypoint', async () => {
        const manifest = readExampleManifest('public-authoring');
        const sourceEntry = readFileSync(join(examplesRoot, 'public-authoring', 'index.ts'), 'utf8');
        const publicAuthoringEntry = await loadPublicAuthoringSourceActivationEntry();
        const actualPublicAuthoringEntry = await import(pathToFileURL(
            join(examplesRoot, 'public-authoring', 'index.ts'),
        ).href) as Partial<PublicAuthoringSourceActivationEntry>;
        const sourceManifest = parsePluginManifest(publicAuthoringEntry.manifest);

        expect(sourceManifest.ok).toBe(true);
        if (!sourceManifest.ok) return;
        expect(existsSync(join(examplesRoot, 'public-authoring', '.happier-plugin', 'plugin.json'))).toBe(false);
        expect(sourceEntry).toMatch(
            /export const \{ manifest, activate, collectionMigrations \} = definePlugin\(publicAuthoringDefinition\)/u,
        );
        expect(readFileSync(join(examplesRoot, 'public-authoring', 'definition.ts'), 'utf8')).toMatch(
            /export const publicAuthoringDefinition: PublicAuthoringDefinition = \{/u,
        );
        expect(sourceManifest.manifest).toEqual(manifest);
        expect(sourceManifest.manifest.entrypoints?.daemon).toBe('./dist/daemon.js');
        // The owner test must consume the entry's exports, rather than a local
        // reapplication of its definition that can bypass entry wiring.
        expect(publicAuthoringEntry.manifest).toBe(actualPublicAuthoringEntry.manifest);
        expect(publicAuthoringEntry.activate).toBe(actualPublicAuthoringEntry.activate);
        expect(publicAuthoringEntry.activate).toBeTypeOf('function');
        expect(publicAuthoringEntry.collectionMigrations).toEqual({
            'review-session-statuses': [],
        });
        expect(actualPublicAuthoringEntry.collectionMigrations).toBe(
            publicAuthoringEntry.collectionMigrations,
        );

        const testkit = await createPluginTestkit({
            manifest: sourceManifest.manifest,
            module: publicAuthoringEntry,
        });
        try {
            expect(testkit.registration('resources', 'review-session-status')).toBeDefined();
        } finally {
            await testkit.dispose();
        }
    });

    it('declares and packages the mounted native-context Action through one exact web/iOS/Android client artifact', async () => {
        const manifest = readExampleManifest('public-authoring');
        const clientModule = await import(pathToFileURL(
            join(examplesRoot, 'public-authoring', 'ui', 'reviewClientActions.ts'),
        ).href) as Readonly<{
            activate(api: Pick<PluginClientApi, 'actions'>): void;
        }>;
        const clientActions = new Map<string, unknown>();
        clientModule.activate({
            actions: {
                register(id, handler) {
                    clientActions.set(id, handler);
                },
            },
        });

        const supportedPlatforms = ['web', 'ios', 'android'] as const;
        const actionExecution = {
            target: 'client',
            client: {
                artifactId: 'review-client-actions',
                modulePath: './activate',
                exportName: 'activate',
            },
            platforms: supportedPlatforms,
        } as const;
        const action = manifest.contributes.actions.find(({ id }) => id === 'open-review-status');
        if (!action) {
            throw new TypeError('public_authoring_cross_platform_client_action_missing');
        }
        expect(action).toEqual(expect.objectContaining({
            id: 'open-review-status',
            surfaces: ['ui', 'voice'],
            execution: actionExecution,
        }));

        const buildModule = await import(pathToFileURL(
            join(examplesRoot, 'public-authoring', 'pluginUiBuild.ts'),
        ).href) as Readonly<{
            pluginUiBuildConfig?: Readonly<{
                targets?: readonly Readonly<{
                    rendererId: string;
                    entry: string;
                    kind: 'reactNative' | 'hostedWeb';
                    platforms?: readonly string[];
                    module?: Readonly<{
                        containerName: string;
                        modulePath: string;
                        exportName: string;
                    }>;
                }>[];
            }>;
        }>;
        const target = buildModule.pluginUiBuildConfig?.targets?.find(
            ({ rendererId }) => rendererId === actionExecution.client.artifactId,
        );
        expect(target).toEqual({
            rendererId: 'review-client-actions',
            entry: 'ui/reviewClientActions.ts',
            kind: 'reactNative',
            platforms: supportedPlatforms,
            module: {
                containerName: 'examples_public_authoring_review_client_actions',
                modulePath: './activate',
                exportName: 'activate',
            },
        });
        if (!target) {
            throw new TypeError('public_authoring_cross_platform_client_target_missing');
        }
        expect(sourceExportsName(
            join(examplesRoot, 'public-authoring', target.entry),
            actionExecution.client.exportName,
        )).toBe(true);
        const sdkPackageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
            files?: readonly string[];
        };
        expect(sdkPackageJson.files).toContain(
            'examples/public-authoring/ui/reviewClientActions.ts',
        );
        const voiceProviders = new Map<string, RegisteredVoiceProviderRuntime>();
        expect([...clientActions.keys()]).toEqual(['open-review-status']);

        const handler = clientActions.get('open-review-status');
        const isClientActionHandler = (value: unknown): value is PluginClientActionHandler =>
            typeof value === 'function';
        expect(isClientActionHandler(handler)).toBe(true);
        if (!isClientActionHandler(handler)) {
            throw new TypeError('public_authoring_cross_platform_client_action_handler_missing');
        }
        const openSurface = vi.fn<PluginClientActionContext['ui']['openSurface']>(
            async () => undefined,
        );
        const context = {
            plugin: { id: 'example.public-authoring', version: '1.0.0' },
            contribution: {
                id: 'open-review-status',
                qualifiedId: 'example.public-authoring:open-review-status',
            },
            invocationSurface: 'voice',
            signal: new AbortController().signal,
            ui: { openSurface },
        } satisfies PluginClientActionContext;
        await handler({}, context);
        expect(openSurface).toHaveBeenCalledOnce();
        expect(openSurface).toHaveBeenCalledWith(
            'review-session-status-details',
            undefined,
            { signal: context.signal },
        );

        for (const platform of supportedPlatforms) {
            expect(actionExecution.platforms).toContain(platform);
            expect(target.platforms).toContain(platform);
            expect(target.module?.modulePath).toBe(actionExecution.client.modulePath);
            expect(target.module?.exportName).toBe(actionExecution.client.exportName);
        }

        const nativeSurface = readFileSync(
            join(examplesRoot, 'public-authoring', 'ui', 'reviewPanel.native.tsx'),
            'utf8',
        );
        expect(nativeSurface).toContain('publishCurrentUiContext({');
        expect(nativeSurface).toContain("action: 'open-review-status'");
        expect(nativeSurface).toContain('return () => context.hostApi.publishCurrentUiContext(null);');

        const webOnlyAction = manifest.contributes.actions.find(
            ({ id }) => id === 'open-review-status-web-only-fixture',
        );
        const webOnlyActionExecution = {
            target: 'client',
            client: {
                artifactId: 'voice-runtime-web',
                modulePath: './voiceProvider',
                exportName: 'activate',
            },
            platforms: ['web'],
        } as const;
        if (!webOnlyAction) {
            throw new TypeError('public_authoring_web_only_client_fixture_missing');
        }
        expect(webOnlyAction).toEqual(expect.objectContaining({
            id: 'open-review-status-web-only-fixture',
            execution: webOnlyActionExecution,
        }));
        const voiceTarget = buildModule.pluginUiBuildConfig?.targets?.find(
            ({ rendererId }) => rendererId === webOnlyActionExecution.client.artifactId,
        );
        expect(voiceTarget).toEqual(expect.objectContaining({
            rendererId: 'voice-runtime-web',
            entry: 'voiceProvider.ts',
            kind: 'reactNative',
            platforms: ['web'],
        }));
        for (const platform of ['ios', 'android'] as const) {
            expect(webOnlyActionExecution.platforms).not.toContain(platform);
            expect(voiceTarget?.platforms).not.toContain(platform);
        }

        const voiceClientModule = await import(pathToFileURL(
            join(examplesRoot, 'public-authoring', 'voiceProvider.ts'),
        ).href) as Readonly<{
            activate(api: Pick<PluginClientApi, 'actions' | 'voiceProviders'>): void;
        }>;
        const webOnlyClientActions = new Map<string, unknown>();
        voiceClientModule.activate({
            actions: {
                register(id, registeredHandler) {
                    webOnlyClientActions.set(id, registeredHandler);
                },
            },
            voiceProviders: {
                register(id, runtime) {
                    voiceProviders.set(id, runtime);
                },
            },
        });
        expect([...webOnlyClientActions.keys()]).toEqual(['open-review-status-web-only-fixture']);
        expect([...voiceProviders.keys()]).toEqual(['credentialed-browser', 'raw-browser']);
    });

    it('import only published SDK and plugin-ui entry points', async () => {
        const allowedSpecifiersByPackage = new Map<string, ReadonlySet<string>>([
            ['@happier-dev/plugin-sdk', readPackageExportSpecifiers(packageJsonPath)],
            ['@happier-dev/plugin-ui', readPackageExportSpecifiers(pluginUiPackageJsonPath)],
        ]);
        const files = await listTypeScriptFiles(examplesRoot);
        expect(files.length).toBeGreaterThan(0);

        const violations: string[] = [];
        for (const filePath of files) {
            const sourceFile = ts.createSourceFile(
                filePath,
                readFileSync(filePath, 'utf8'),
                ts.ScriptTarget.Latest,
                true,
                ts.ScriptKind.TS,
            );
            sourceFile.forEachChild((node) => {
                if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) {
                    return;
                }
                const specifier = node.moduleSpecifier.text;
                const owner = [...allowedSpecifiersByPackage.keys()]
                    .find((packageName) => specifier === packageName || specifier.startsWith(`${packageName}/`));
                if (owner && !allowedSpecifiersByPackage.get(owner)?.has(specifier)) {
                    violations.push(`${relative(packageRoot, filePath)} imports ${specifier}`);
                }
            });
        }

        expect(violations).toEqual([]);
    });

    it('uses the canonical manifest, agents/runtime, and UI build entrypoints without predecessor authoring APIs', async () => {
        const files = await listTypeScriptFiles(examplesRoot);
        const violations: string[] = [];

        for (const filePath of files) {
            const relativePath = relative(packageRoot, filePath);
            const source = readFileSync(filePath, 'utf8');
            for (const retired of [
                'defineAcpBackend',
                'beginTurnLifecycle',
                'startOrLoadSession',
                'waitForTurnCompletion',
                '@happier-dev/plugin-sdk/agent-runtime',
                '@happier-dev/plugin-sdk/ui/hostApiClient',
                '@happier-dev/plugin-sdk/ui/reactNativeBuild',
                '@happier-dev/plugin-sdk/ui/reactNativeWebBuild',
                '@happier-dev/plugin-sdk/ui/hostedWebBuild',
            ]) {
                if (source.includes(retired)) {
                    violations.push(`${relativePath}:uses:${retired}`);
                }
            }
        }

        const publicAuthoringDaemon = readFileSync(
            join(examplesRoot, 'public-authoring', 'daemon.ts'),
            'utf8',
        );
        const publicAuthoringManifest = readExampleManifest('public-authoring');
        const publicAuthoringDefinitionSource = readFileSync(
            join(examplesRoot, 'public-authoring', 'definition.ts'),
            'utf8',
        );
        const publicAuthoringBuild = readFileSync(
            join(examplesRoot, 'public-authoring', 'pluginUiBuild.ts'),
            'utf8',
        );
        const publicAuthoringVoice = readFileSync(
            join(examplesRoot, 'public-authoring', 'voiceProvider.ts'),
            'utf8',
        );
        const publicAuthoringSpeech = readFileSync(
            join(examplesRoot, 'public-authoring', 'voiceSpeechProvider.ts'),
            'utf8',
        );
        const publicAuthoringIndex = readFileSync(
            join(examplesRoot, 'public-authoring', 'index.ts'),
            'utf8',
        );
        expect(publicAuthoringDaemon).toContain("from '@happier-dev/plugin-sdk/agents/runtime'");
        expect(publicAuthoringDaemon).toContain("from '@happier-dev/plugin-sdk'");
        expect(publicAuthoringManifest.entrypoints).toEqual({ daemon: './dist/daemon.js' });
        expect(publicAuthoringManifest.activation?.events ?? []).not.toContainEqual({ kind: 'startup' });
        expect(publicAuthoringBuild).toContain("from '@happier-dev/plugin-sdk/ui/build'");
        expect(publicAuthoringDefinitionSource).toContain('run: runReviewSummary');
        expect(publicAuthoringDefinitionSource).toContain('handler: observeSessionSpawned');
        expect(publicAuthoringDefinitionSource).toContain('factory: createReviewAgentRuntime');
        expect(publicAuthoringDefinitionSource).toContain('runtime: speechToTextRuntime');
        expect(publicAuthoringDefinitionSource).toContain('runtime: textToSpeechRuntime');
        expect(publicAuthoringDaemon).toContain("context.ui?.status.set('review-summary'");
        expect(publicAuthoringDaemon).not.toContain('api.actions.register');
        expect(publicAuthoringDaemon).not.toContain('api.hooks.register');
        expect(publicAuthoringDaemon).not.toContain('api.agents.register');
        expect(publicAuthoringVoice).toContain("api.voiceProviders.register('credentialed-browser'");
        expect(publicAuthoringVoice).toContain("api.voiceProviders.register('raw-browser'");
        expect(publicAuthoringSpeech).not.toContain('api.voiceProviders.register');
        expect(publicAuthoringVoice).toContain("from '@happier-dev/plugin-sdk/voice'");
        expect(publicAuthoringVoice).toContain("from '@happier-dev/plugin-sdk/voice/client'");
        expect(publicAuthoringVoice).toMatch(
            /import type\s*\{[^}]*\bVoiceClientAuthArtifact\b[^}]*\}\s*from '@happier-dev\/plugin-sdk\/voice\/client';/u,
        );
        expect(publicAuthoringVoice).toMatch(
            /import type\s*\{\s*VoiceProviderCatalogItem\s*\}\s*from '@happier-dev\/plugin-sdk\/voice\/speech';/u,
        );
        expect(publicAuthoringVoice).not.toMatch(
            /\btype Voice(?:ClientAuthArtifact|CatalogItem)\b/u,
        );
        expect(publicAuthoringSpeech).toContain("from '@happier-dev/plugin-sdk'");
        expect(publicAuthoringSpeech).toContain("from '@happier-dev/plugin-sdk/voice/speech'");
        expect(publicAuthoringSpeech).not.toContain("from '@happier-dev/plugin-sdk/voice'");
        expect(`${publicAuthoringVoice}\n${publicAuthoringSpeech}`).not.toMatch(
            /@happier-dev\/plugin-sdk\/(?:runtime|ui\/client)|registerSpeech|PluginVoice|accountMediation|speechProviderIds|catalogProviders/u,
        );
        expect(publicAuthoringVoice).toContain("kind: 'conversation'");
        expect(publicAuthoringVoice).toContain('credentials.mediated');
        expect(publicAuthoringVoice).toContain("operationId: 'client-auth'");
        expect(publicAuthoringVoice).toContain("operationId: 'list-catalog'");
        expect(publicAuthoringVoice).not.toContain("ui.executeAction('mint-voice-session'");
        expect(publicAuthoringVoice).not.toContain("ui.executeAction('list-voice-catalog'");
        expect(publicAuthoringDaemon).not.toContain("api.actions.register('mint-voice-session'");
        expect(publicAuthoringDaemon).not.toContain("api.actions.register('list-voice-catalog'");
        expect(publicAuthoringDaemon).not.toContain('executeVoiceAccountOperation');
        expect(publicAuthoringDaemon).not.toContain("kind: 'voiceAccountOperation'");
        expect(publicAuthoringManifest.contributes.actions.map(({ id }) => id)).toEqual([
            'review-summary',
            'external-session-digest',
            'open-review-status',
            'open-review-status-web-only-fixture',
        ]);
        // The External Sessions consumer path is exercised, not stubbed: the
        // Action asks the host for availability, filters candidates on the
        // capability the host published, and reads a real transcript page.
        expect(publicAuthoringDaemon).toContain('context.services.sessions.external');
        expect(publicAuthoringDaemon).toContain('external.readTranscript(');
        expect(publicAuthoringDefinitionSource).toContain('run: runExternalSessionDigest');
        expect(publicAuthoringManifest.contributes.voiceProviders.map(({ id }) => id)).toEqual([
            'credentialed-browser',
            'raw-browser',
            'speech-stt',
            'speech-tts',
        ]);
        expect(publicAuthoringIndex).toContain('definePlugin(publicAuthoringDefinition)');
        expect(publicAuthoringIndex).not.toContain('activateCredentiallessBrowserVoiceProvider');
        expect(publicAuthoringIndex).toContain(
            "export { reviewAgentRunnerFactory } from './daemon.js';",
        );
        expect(publicAuthoringDaemon).not.toContain('api.lifecycle.onWillDeactivate');
        expect(publicAuthoringDaemon).not.toMatch(/\b(?:PluginContext|registerAction|registerHook|registerAgentRuntime|onDispose)\b/u);
        expect(violations).toEqual([]);
    });

    it('registers the custom Session Agent through one distinct named runner leaf', async () => {
        const manifest = readExampleManifest('public-authoring');
        const publicAuthoringEntry = await loadPublicAuthoringSourceActivationEntry();
        const runnerLeaf = await import(pathToFileURL(
            join(examplesRoot, 'public-authoring', 'agent', 'runtime.ts'),
        ).href) as Readonly<{
            createReviewAgentRuntime: unknown;
        }>;
        const testkit = await createPluginTestkit({ manifest, module: publicAuthoringEntry });
        try {
            expect(testkit.registration('agents', 'review-agent')).toMatchObject({
                factory: runnerLeaf.createReviewAgentRuntime,
                sessionRunnerFactory: {
                    module: './agent/runtime.js',
                    export: 'createReviewAgentRuntime',
                    runtimeApiVersion: 1,
                },
            });
        } finally {
            await testkit.dispose();
        }
    });

    it('keeps the advanced definePlugin reference package-rooted, realm-safe, and testkit-compatible', async () => {
        const exampleRoot = join(examplesRoot, 'advanced-package-root');
        const module = await import(pathToFileURL(join(exampleRoot, 'index.ts')).href) as Readonly<{
            manifest: PluginManifest;
            activate: DefinedPlugin['activate'];
        }>;
        const runnerLeaf = await import(pathToFileURL(
            join(exampleRoot, 'agent', 'reviewAgent.ts'),
        ).href) as Readonly<{
            createReviewAgentRuntime: () => object;
            externalSessions: unknown;
        }>;

        expect(readFileSync(join(exampleRoot, 'package.json'), 'utf8')).toContain(
            '"@happier-dev/plugin-sdk"',
        );
        const parsedManifest = parsePluginManifest(module.manifest);
        expect(
            parsedManifest.ok,
            parsedManifest.ok ? undefined : JSON.stringify(parsedManifest.diagnostics),
        ).toBe(true);
        if (!parsedManifest.ok) {
            throw new Error('Advanced package-root manifest must parse before exercising its activation module.');
        }
        const manifest = parsedManifest.manifest;
        expect(manifest.contributes.agents).toContainEqual(expect.objectContaining({
            id: 'reviewer',
            runtime: { kind: 'custom' },
        }));
        expect(manifest.contributes.agents[0]?.connectedAccounts).toEqual([{
            purpose: 'review-api',
            service: { pluginId: 'example.accounts', localId: 'review-api' },
            materializationKinds: ['httpHeaders'],
        }]);
        expect(manifest.contributes.providers).toContainEqual(expect.objectContaining({
            id: 'gateway',
            managedRuntime: { kind: 'managed', endpointTemplateIds: ['responses'] },
        }));
        expect(manifest.contributes.backgroundServices).toEqual([
            { id: 'catalog-refresh', title: 'Refresh the example catalog' },
        ]);
        expect(runnerLeaf.createReviewAgentRuntime()).not.toBe(runnerLeaf.createReviewAgentRuntime());

        const testkit = await createPluginTestkit({
            manifest: module.manifest,
            module,
        });
        try {
            await expect(testkit.invokeAction('summarize', { text: 'A review.' }))
                .resolves.toEqual({ summary: 'Summary ready.' });
            expect(testkit.registration('agents', 'reviewer')).toMatchObject({
                factory: runnerLeaf.createReviewAgentRuntime,
                externalSessions: expect.any(Object),
                sessionRunnerFactory: {
                    module: './agent/reviewAgent.js',
                    export: 'createReviewAgentRuntime',
                    runtimeApiVersion: 1,
                    externalSessionsExport: 'externalSessions',
                },
            });
        } finally {
            await testkit.dispose();
        }
    });

    it('declares each production reference\'s packed Action and packaged Resource contract', async () => {
        const publicAuthoringManifest = readExampleManifest('public-authoring');
        const productionHostedManifest = readExampleManifest('production-hosted-reference');
        const advancedRoot = join(examplesRoot, 'advanced-package-root');
        const advancedModule = await import(pathToFileURL(join(advancedRoot, 'index.ts')).href) as Readonly<{
            manifest: PluginManifest;
        }>;
        const advancedParsed = parsePluginManifest(advancedModule.manifest);

        expect(
            advancedParsed.ok,
            advancedParsed.ok ? undefined : JSON.stringify(advancedParsed.diagnostics),
        ).toBe(true);
        if (!advancedParsed.ok) {
            throw new Error('Advanced package-root manifest must parse before its packed lifecycle contract is checked.');
        }

        expectPackedLifecycleAction(publicAuthoringManifest, 'review-summary');
        expectPackedLifecycleAction(productionHostedManifest, 'refresh-review');
        expectPackedLifecycleAction(advancedParsed.manifest, 'summarize');
        // Both public UI renderers invoke this contributed Action through the
        // host API. That dispatcher stamps `executionSurface: 'ui'`; `plugin`
        // is reserved for a plugin-originated action caller and would not make
        // either renderer executable.
        expect(
            publicAuthoringManifest.contributes.actions.find(
                (action) => action.id === 'review-summary',
            )?.surfaces,
        ).toContain('ui');
        expectPackagedReferenceResource({
            exampleName: 'public-authoring',
            manifest: publicAuthoringManifest,
            localId: 'review-guide',
        });
        expectPackagedReferenceResource({
            exampleName: 'production-hosted-reference',
            manifest: productionHostedManifest,
            localId: 'review-guide',
        });
        expectPackagedReferenceResource({
            exampleName: 'advanced-package-root',
            manifest: advancedParsed.manifest,
            localId: 'review-guide',
        });

        const hostedRenderer = publicAuthoringManifest.contributes.ui.renderers.find(
            (renderer) => renderer.id === 'review-web',
        );
        expect(hostedRenderer).toMatchObject({
            kind: 'hostedWeb',
            requiredHostMethods: expect.arrayContaining(['context', 'executeAction', 'readResource']),
        });
        const hostedSource = readFileSync(
            join(examplesRoot, 'public-authoring', 'ui', 'reviewPanel.web.tsx'),
            'utf8',
        );
        expect(hostedSource).toContain("createPluginUiRenderContext");
        expect(hostedSource).toMatch(/readResource\(\s*'review-guide'/u);
        expect(hostedSource).not.toMatch(
            /(?:window\.parent|location\.(?:search|hash)|URLSearchParams)/u,
        );

        const productionHostedDaemon = await import(pathToFileURL(join(
            examplesRoot,
            'production-hosted-reference',
            'daemon.ts',
        )).href) as Readonly<{
            activate(api: Pick<PluginApi, 'actions'>): void;
            runReviewRefresh: Parameters<PluginApi['actions']['register']>[1];
        }>;
        const registerReviewRefresh = vi.fn();
        productionHostedDaemon.activate({ actions: { register: registerReviewRefresh } });
        expect(registerReviewRefresh).toHaveBeenCalledWith(
            'refresh-review',
            productionHostedDaemon.runReviewRefresh,
        );
    });

    it('registers a bounded cancellable Composer reference provider through the public SDK', async () => {
        const manifest = readExampleManifest('public-authoring');
        const publicAuthoringEntry = await loadPublicAuthoringSourceActivationEntry();
        expect(manifest.contributes.composerReferences).toEqual([
            {
                id: 'review-references',
                title: 'Review references',
                icon: 'search',
                triggers: ['@'],
            },
        ]);
        const testkit = await createPluginTestkit({
            manifest,
            module: publicAuthoringEntry,
        });
        try {
            const provider = testkit.registration('composerReferences', 'review-references');
            expect(provider).toBeDefined();
            if (!provider) throw new Error('review_reference_provider_not_registered');

            const candidates = await provider.search('security', new AbortController().signal);
            expect(candidates).toEqual([{
                id: 'security-check',
                label: 'Security review',
                description: 'Focus on authorization, secrets, and trust boundaries.',
            }]);
            const resolution = await provider.resolve('security-check', new AbortController().signal);
            expect(resolution).toEqual({
                ...candidates[0],
                context: 'Review focus: authorization, secrets, and trust boundaries.',
            });

            const cancelled = new AbortController();
            cancelled.abort('test_cancelled');
            await expect(provider.search('security', cancelled.signal)).rejects.toMatchObject({
                name: 'AbortError',
            });
        } finally {
            await testkit.dispose();
        }
    });

    it('authors the Agent Context Companion through the public bounded composition hook only', async () => {
        const manifest = readExampleManifest('public-authoring');
        const publicAuthoringEntry = await loadPublicAuthoringSourceActivationEntry();
        expect(manifest.contributes.hooks).toContainEqual(expect.objectContaining({
            id: 'agent-context-companion',
            on: 'agent.composition.resolve',
            category: 'augmentation',
            scope: 'agent',
            executionKind: 'augment',
        }));
        expect(manifest.contributes.promptAssets).toContainEqual(expect.objectContaining({
            id: 'agent-context-companion-prompt',
            resource: 'agent-context-companion-guide',
            target: { kind: 'agent', agent: 'review-agent' },
        }));

        const daemonPath = join(examplesRoot, 'public-authoring', 'daemon.ts');
        const daemonSource = readFileSync(daemonPath, 'utf8');
        const boundary = createReviewContextCompanionSessionBoundary();
        const compositionEvent = Object.freeze({
            payload: Object.freeze({
                sessionId: 'session-1',
                agentId: 'review-agent',
                runtimeFamily: 'hostSession' as const,
                declaredToolIds: Object.freeze([]),
                declaredPromptAssetIds: Object.freeze(['agent-context-companion-prompt']),
            }),
        });
        const unavailableCompositionEvent = Object.freeze({
            payload: Object.freeze({
                ...compositionEvent.payload,
                declaredToolIds: Object.freeze([]),
                declaredPromptAssetIds: Object.freeze([]),
            }),
        });
        const invoke = async (
            handler: Parameters<PluginApi['hooks']['register']>[1],
            event = compositionEvent,
        ) => {
            const controller = new AbortController();
            return await handler(event, createReviewContextCompanionInvocationContext(
                boundary,
                controller.signal,
            ));
        };
        const testkit = await createPluginTestkit({ manifest, module: publicAuthoringEntry });
        try {
            const handler = testkit.registration('hooks', 'agent-context-companion');
            expect(handler).toBeDefined();
            if (!handler) throw new Error('agent_context_companion_hook_not_registered');
            const result = await invoke(handler);
            expect(result).toEqual({
                enabledToolIds: [],
                enabledPromptAssetIds: ['agent-context-companion-prompt'],
                additionalInstructions: expect.stringContaining('review cursor'),
            });
            expect(boundary.get).toHaveBeenLastCalledWith('session-1', {
                signal: expect.any(AbortSignal),
            });
            expect(boundary.readSystemRecord).toHaveBeenLastCalledWith({
                address: boundary.address,
            }, { signal: expect.any(AbortSignal) });
            expect(boundary.upsertSystemRecord).toHaveBeenLastCalledWith(expect.objectContaining({
                address: boundary.address,
                expectedRevision: null,
                content: expect.objectContaining({
                    version: 1,
                    cursor: 'review-agent',
                }),
            }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
            expect(boundary.record()).toMatchObject({
                address: boundary.address,
                content: expect.objectContaining({
                    annotation: expect.stringContaining('review cursor'),
                }),
            });

            await expect(invoke(handler)).resolves.toEqual(result);
            expect(boundary.upsertSystemRecord).toHaveBeenLastCalledWith(expect.objectContaining({
                expectedRevision: 'revision-1',
            }), expect.objectContaining({ signal: expect.any(AbortSignal) }));

            const cancelled = new AbortController();
            cancelled.abort('companion_cancelled');
            await expect(handler(compositionEvent, createReviewContextCompanionInvocationContext(
                boundary,
                cancelled.signal,
            ))).rejects.toBe('companion_cancelled');

            let markReadStarted!: () => void;
            const readStarted = new Promise<void>((resolve) => {
                markReadStarted = resolve;
            });
            const inFlightRead = vi.fn(async (
                request: Parameters<SessionHandle['readSystemRecord']>[0],
                options?: Parameters<SessionHandle['readSystemRecord']>[1],
            ): ReturnType<SessionHandle['readSystemRecord']> => {
                expect(request).toEqual({ address: boundary.address });
                const signal = options?.signal;
                if (!signal) throw new Error('companion_read_requires_caller_signal');
                signal.throwIfAborted();
                markReadStarted();
                return await new Promise<never>((_resolve, reject) => {
                    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
                });
            });
            const inFlightController = new AbortController();
            const inFlightContext = Object.freeze({
                signal: inFlightController.signal,
                services: Object.freeze({
                    sessions: Object.freeze({
                        get: vi.fn(async () => Object.freeze({ readSystemRecord: inFlightRead })),
                    }),
                }),
            }) as unknown as PluginInvocationContext;
            const inFlight = handler(compositionEvent, inFlightContext);
            await readStarted;
            const cancellationReason = new DOMException('Companion read cancelled.', 'AbortError');
            inFlightController.abort(cancellationReason);
            await expect(inFlight).rejects.toBe(cancellationReason);
            expect(inFlightRead).toHaveBeenCalledTimes(1);
            expect(daemonSource).toContain("from '@happier-dev/plugin-sdk/sessions'");
            expect(daemonSource).not.toMatch(/from ['"]@happier-dev\/protocol/u);
        } finally {
            await testkit.dispose();
        }

        // A fresh registration consumes the same host-owned Session boundary
        // and performs a CAS update rather than relying on a module-global
        // cursor. Actual daemon-restart persistence is an activated-host gate.
        const restarted = await createPluginTestkit({ manifest, module: publicAuthoringEntry });
        try {
            const handler = restarted.registration('hooks', 'agent-context-companion');
            if (!handler) throw new Error('agent_context_companion_hook_not_registered_after_restart');
            await expect(invoke(handler)).resolves.toEqual({
                enabledToolIds: [],
                enabledPromptAssetIds: ['agent-context-companion-prompt'],
                additionalInstructions: expect.stringContaining('review cursor'),
            });
            expect(boundary.upsertSystemRecord).toHaveBeenLastCalledWith(expect.objectContaining({
                expectedRevision: 'revision-2',
            }), expect.objectContaining({ signal: expect.any(AbortSignal) }));

            boundary.conflictOnNextUpsert();
            await expect(invoke(handler)).resolves.toEqual({
                enabledToolIds: [],
                enabledPromptAssetIds: ['agent-context-companion-prompt'],
                additionalInstructions: expect.stringContaining('review cursor'),
            });
            expect(boundary.record()).toMatchObject({
                content: expect.objectContaining({ cursor: 'another-authorized-client' }),
            });

            await expect(invoke(handler, unavailableCompositionEvent)).resolves.toEqual({
                enabledToolIds: [],
                enabledPromptAssetIds: [],
            });
            expect(boundary.deleteSystemRecord).toHaveBeenLastCalledWith({
                address: boundary.address,
                expectedRevision: 'revision-4',
            }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
            expect(boundary.record()).toBeNull();
        } finally {
            await restarted.dispose();
        }

        // After the no-contribution cleanup, a fresh registration has no local
        // fallback: it creates through the same public host-backed API. Actual
        // disable/uninstall lifecycle behavior belongs to the activated host.
        const reinstalled = await createPluginTestkit({ manifest, module: publicAuthoringEntry });
        try {
            const handler = reinstalled.registration('hooks', 'agent-context-companion');
            if (!handler) throw new Error('agent_context_companion_hook_not_registered_after_reinstall');
            await expect(invoke(handler)).resolves.toEqual({
                enabledToolIds: [],
                enabledPromptAssetIds: ['agent-context-companion-prompt'],
                additionalInstructions: expect.stringContaining('review cursor'),
            });
            expect(boundary.upsertSystemRecord).toHaveBeenLastCalledWith(expect.objectContaining({
                expectedRevision: null,
            }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
        } finally {
            await reinstalled.dispose();
        }
    });

    it('keeps the Companion tool selection conditional on a supported-Agent host declaration', async () => {
        const manifest = readExampleManifest('public-authoring');
        const publicAuthoringEntry = await loadPublicAuthoringSourceActivationEntry();
        const boundary = createReviewContextCompanionSessionBoundary();
        const event = Object.freeze({
            payload: Object.freeze({
                sessionId: 'session-1',
                agentId: 'claude',
                runtimeFamily: 'hostSession' as const,
                declaredToolIds: Object.freeze(['review-summary-tool']),
                declaredPromptAssetIds: Object.freeze([]),
            }),
        });
        const testkit = await createPluginTestkit({ manifest, module: publicAuthoringEntry });
        try {
            const handler = testkit.registration('hooks', 'agent-context-companion');
            if (!handler) throw new Error('agent_context_companion_hook_not_registered_for_supported_agent');
            const result = await handler(event, createReviewContextCompanionInvocationContext(
                boundary,
                new AbortController().signal,
            ));
            expect(result).toEqual({
                enabledToolIds: ['review-summary-tool'],
                enabledPromptAssetIds: [],
                additionalInstructions: expect.stringContaining('review cursor'),
            });
        } finally {
            await testkit.dispose();
        }
    });

    it('reads one revision-bound opaque workspace reference through the selected viewer host methods', async () => {
        const manifest = readExampleManifest('public-authoring');
        expect(manifest.contributes.openableContentViewers).toEqual([{
            id: 'review-text-viewer',
            destination: 'review-openable-content',
            contentClasses: ['text'],
            mimeTypes: ['text/markdown', 'text/plain'],
            extensions: ['.md', '.txt'],
        }]);
        expect(manifest.contributes.ui.views.find((view) => view.id === 'review-openable-content'))
            .toMatchObject({ instancePolicy: 'singleton' });
        const requiredHostMethods = (rendererId: string) => {
            const renderer = manifest.contributes.ui.renderers.find((candidate) => candidate.id === rendererId);
            if (!renderer || renderer.kind === 'declarative') {
                throw new Error(`Expected host-rendered public-authoring renderer '${rendererId}'.`);
            }
            return renderer.requiredHostMethods;
        };
        expect(requiredHostMethods('review-native')).toEqual([
            'context',
            'executeAction',
            'openSurface',
            'publishCurrentUiContext',
            'readResource',
            'watchResource',
        ]);
        expect(requiredHostMethods('review-web')).toEqual([
            'context',
            'executeAction',
            'openSurface',
            'readResource',
            'watchResource',
        ]);
        for (const rendererId of ['review-openable-native', 'review-openable-web']) {
            expect(requiredHostMethods(rendererId)).toEqual([
                'context',
                'statOpenableContent',
                'readOpenableContent',
            ]);
        }

        const openable = await import(pathToFileURL(
            join(examplesRoot, 'public-authoring', 'ui', 'reviewOpenableContent.ts'),
        ).href) as Readonly<{
            readReviewOpenableContent(
                host: PluginUiHostApi,
                ref: Readonly<{ kind: 'workspaceFile'; handle: string }>,
                signal?: AbortSignal,
            ): Promise<unknown>;
        }>;
        const reference = { kind: 'workspaceFile', handle: 'mounted_review_file' } as const;
        let observedStat: unknown;
        let observedRead: unknown;
        const fixture = await createPluginUiTestkit({
            identity: {
                pluginId: manifest.id,
                pluginVersion: manifest.version,
                viewId: 'review-openable-content',
                generation: 'public-authoring-openable-test',
                sessionId: 'session-1',
            },
            surface: { kind: 'public-authoring-openable-test' },
            surfaceContext: createSurfaceContextFixture({
                mount: {
                    kind: 'destination',
                    destination: { pluginId: manifest.id, localId: 'review-openable-content' },
                    container: 'detailsTab',
                },
                target: { kind: 'session', sessionId: 'session-1' },
            }),
            adapter: createNoopSemanticAdapter(),
            handlers: {
                async statOpenableContent(input) {
                    observedStat = input;
                    return {
                        status: 'ready',
                        mimeType: 'text/markdown',
                        contentClass: 'text',
                        extension: '.md',
                        sizeBytes: 26,
                        revision: 'review-file-revision-1',
                    };
                },
                async readOpenableContent(input) {
                    observedRead = input;
                    return {
                        status: 'ready',
                        revision: 'review-file-revision-1',
                        content: { kind: 'utf8', text: '# Review notes\n\nCheck authorization.' },
                    };
                },
            },
        });
        try {
            await expect(openable.readReviewOpenableContent(fixture.context.hostApi, reference)).resolves.toEqual({
                status: 'ready',
                mimeType: 'text/markdown',
                contentClass: 'text',
                extension: '.md',
                sizeBytes: 26,
                revision: 'review-file-revision-1',
                content: { kind: 'utf8', text: '# Review notes\n\nCheck authorization.' },
            });
            expect(observedStat).toMatchObject({ ref: reference });
            expect(observedRead).toMatchObject({
                request: {
                    ref: reference,
                    expectedRevision: 'review-file-revision-1',
                    maxBytes: 64 * 1024,
                },
            });
        } finally {
            await fixture.dispose();
        }
    });

    it('binds the Session Account Resource to its declared Collection and public UI read/watch consumer', async () => {
        const manifest = readExampleManifest('public-authoring');
        const publicAuthoringEntry = await loadPublicAuthoringSourceActivationEntry();
        expect(manifest.hostAccess.required).toContainEqual({
            id: 'review-resource-account',
            capability: 'storage.account',
            reason: 'Read the declared Account review status for the current Session.',
            scope: { enabled: true },
        });
        expect(manifest.contributes.accountCollections).toContainEqual(expect.objectContaining({
            id: 'review-session-statuses',
            rowIdField: 'id',
            serverReadable: ['summary'],
        }));
        expect(manifest.contributes.resources).toContainEqual(expect.objectContaining({
            id: 'review-session-status',
            source: 'dynamic',
            kind: 'config',
            contentType: 'text/plain',
            scope: 'session',
            hostAccess: ['review-resource-account'],
            maxBytes: 8192,
        }));
        expect(manifest.contributes.ui.views).toContainEqual(expect.objectContaining({
            id: 'review-session-status-details',
            container: 'detailsTab',
            target: { kind: 'session' },
            renderer: 'review-native',
            fallbackRenderers: ['review-web'],
            instancePolicy: 'singleton',
        }));

        const testkit = await createPluginTestkit({
            manifest,
            module: publicAuthoringEntry,
        });
        try {
            const resource = testkit.registration('resources', 'review-session-status');
            expect(resource).toBeDefined();
            if (!resource) throw new Error('review_session_status_resource_not_registered');

            const accountBoundary = createReviewSessionStatusAccountStorage('Check the authorization boundary.');
            const readSignal = new AbortController();
            await expect(resource.read({
                signal: readSignal.signal,
                context: { kind: 'session', sessionId: 'session-1' },
                accountStorage: accountBoundary.accountStorage,
            })).resolves.toBe('Check the authorization boundary.');
            expect(accountBoundary.get).toHaveBeenCalledWith('session-1', { signal: readSignal.signal });

            const invalidated = vi.fn();
            const watchController = new AbortController();
            resource.observe(invalidated, {
                signal: watchController.signal,
                context: { kind: 'session', sessionId: 'session-1' },
                accountStorage: accountBoundary.accountStorage,
            });
            accountBoundary.emitChange();
            expect(invalidated).toHaveBeenCalledTimes(1);
            watchController.abort('session_surface_retired');
            expect(accountBoundary.isWatchDisposed()).toBe(true);
            accountBoundary.emitChange();
            expect(invalidated).toHaveBeenCalledTimes(1);

            const cancelledWatchController = new AbortController();
            cancelledWatchController.abort('retired_before_watch');
            const cancelledWatchBoundary = createReviewSessionStatusAccountStorage('Unused.');
            expect(() => resource.observe(vi.fn(), {
                signal: cancelledWatchController.signal,
                context: { kind: 'session', sessionId: 'session-1' },
                accountStorage: cancelledWatchBoundary.accountStorage,
            })).toThrow(expect.objectContaining({ name: 'AbortError' }));
            expect(cancelledWatchBoundary.collectionRequests()).toBe(0);
            expect(cancelledWatchBoundary.watch).not.toHaveBeenCalled();

            const hostedPanel = await import(pathToFileURL(
                join(examplesRoot, 'public-authoring', 'ui', 'reviewPanel.web.tsx'),
            ).href) as Readonly<{
                mountSessionStatus?: (
                    root: HTMLElement,
                    context: unknown,
                    activity?: boolean,
                ) => Promise<void> | void;
            }>;
            expect(hostedPanel.mountSessionStatus).toBeTypeOf('function');
            if (typeof hostedPanel.mountSessionStatus !== 'function') {
                throw new Error('review_session_status_mount_not_exported');
            }

            type HostedResource = Awaited<ReturnType<PluginUiHostApi['readResource']>>;
            const initialRead = deferred<HostedResource>();
            const queuedReads: Array<ReturnType<typeof deferred<HostedResource>>> = [initialRead];
            const readResource = vi.fn(({ resource: requested }: Readonly<{ resource: unknown }>) => {
                expect(requested).toEqual({
                    pluginId: manifest.id,
                    localId: 'review-session-status',
                });
                const next = queuedReads.shift();
                if (!next) throw new Error('unexpected_review_status_read');
                return next.promise;
            });
            const watchResource = vi.fn(({ resource: requested }: Readonly<{ resource: unknown }>) => {
                expect(requested).toEqual({
                    pluginId: manifest.id,
                    localId: 'review-session-status',
                });
                return { digest: `sha256:${'a'.repeat(64)}` };
            });
            const makeResourceContent = (summary: string, digestCharacter: string): HostedResource => ({
                contentType: 'text/plain',
                digest: `sha256:${digestCharacter.repeat(64)}`,
                bytes: new TextEncoder().encode(summary),
            });
            const uiFixture = await createPluginUiTestkit({
                identity: {
                    pluginId: manifest.id,
                    pluginVersion: manifest.version,
                    viewId: 'review-session-status-details',
                    generation: 'public-authoring-session-resource-test',
                    sessionId: 'session-1',
                },
            surface: { kind: 'public-authoring-session-resource-test' },
            surfaceContext: createSurfaceContextFixture({
                mount: {
                    kind: 'destination',
                    destination: { pluginId: manifest.id, localId: 'review-session-status-details' },
                    container: 'detailsTab',
                },
                target: { kind: 'session', sessionId: 'session-1' },
                }),
                adapter: createNoopSemanticAdapter(),
                handlers: {
                    readResource,
                    watchResource,
                },
            });
            try {
                const root = createHostedReviewPanelRoot();
                await hostedPanel.mountSessionStatus(root.root, uiFixture.context);
                await vi.waitFor(() => expect(readResource).toHaveBeenCalledTimes(1));
                initialRead.resolve(makeResourceContent('Initial review status.', 'a'));
                await vi.waitFor(() => expect(root.guide.textContent).toBe('Initial review status.'));
                await vi.waitFor(() => expect(watchResource).toHaveBeenCalledTimes(1));

                const staleRead = deferred<HostedResource>();
                const latestRead = deferred<HostedResource>();
                queuedReads.push(staleRead, latestRead);
                uiFixture.invalidateResource({
                    pluginId: manifest.id,
                    localId: 'review-session-status',
                }, `sha256:${'b'.repeat(64)}`);
                await vi.waitFor(() => expect(readResource).toHaveBeenCalledTimes(2));

                // A newer invalidation arrives before the older read settles.
                // The canonical Resource store serializes the rereads, so the
                // newer request cannot publish before the older one releases.
                uiFixture.invalidateResource({
                    pluginId: manifest.id,
                    localId: 'review-session-status',
                }, `sha256:${'c'.repeat(64)}`);
                await Promise.resolve();
                await Promise.resolve();
                expect(readResource).toHaveBeenCalledTimes(2);
                staleRead.resolve(makeResourceContent('Older review status.', 'b'));
                await vi.waitFor(() => expect(readResource).toHaveBeenCalledTimes(3));
                latestRead.resolve(makeResourceContent('Latest review status.', 'c'));
                await vi.waitFor(() => expect(root.guide.textContent).toBe('Latest review status.'));

                const failedReread = deferred<HostedResource>();
                queuedReads.push(failedReread);
                uiFixture.invalidateResource({
                    pluginId: manifest.id,
                    localId: 'review-session-status',
                }, `sha256:${'d'.repeat(64)}`);
                await vi.waitFor(() => expect(readResource).toHaveBeenCalledTimes(4));
                failedReread.reject(new Error('temporary_resource_failure'));
                await vi.waitFor(() => expect(root.status.textContent).toBe('Showing last known review status'));
                expect(root.guide.textContent).toBe('Latest review status.');
            } finally {
                await uiFixture.dispose();
            }
        } finally {
            await testkit.dispose();
        }
    });

    it('declares the Project Companion dashboard as one dynamic declarative document through the public Resource path', async () => {
        const manifest = readExampleManifest('public-authoring');
        const publicAuthoringEntry = await loadPublicAuthoringSourceActivationEntry();
        const documentResource = manifest.contributes.resources.find(
            (resource) => resource.id === 'project-companion-dashboard-document',
        );
        expect(documentResource).toEqual({
            id: 'project-companion-dashboard-document',
            source: 'dynamic',
            kind: 'config',
            contentType: PLUGIN_DECLARATIVE_DOCUMENT_CONTENT_TYPE_V1,
            scope: 'session',
            hostAccess: ['review-resource-account'],
            maxBytes: 8192,
        });
        const dashboardRenderer = manifest.contributes.ui.renderers.find(
            (renderer) => renderer.id === 'project-companion-dashboard-renderer',
        );
        expect(dashboardRenderer).toEqual({
            id: 'project-companion-dashboard-renderer',
            kind: 'declarative',
            root: {
                kind: 'group',
                title: 'Project Companion',
                description: 'Live review status for the current Session.',
                children: [{
                    kind: 'status',
                    label: 'Review status',
                    value: 'Waiting for the current review status.',
                }],
            },
            documentSource: {
                kind: 'resource',
                resourceId: 'project-companion-dashboard-document',
            },
        });
        expect(manifest.contributes.ui.views.find(
            (view) => view.id === 'project-companion-dashboard',
        )).toMatchObject({
            id: 'project-companion-dashboard',
            container: 'rightPane',
            target: { kind: 'session' },
            renderer: 'project-companion-dashboard-renderer',
            title: 'Project Companion',
            instancePolicy: 'singleton',
        });
        expect(manifest.contributes.sessionHeaderActions).toContainEqual({
            id: 'open-project-companion-dashboard',
            title: 'Open Project Companion',
            action: {
                kind: 'openSurface',
                destination: 'project-companion-dashboard',
            },
        });

        const testkit = await createPluginTestkit({
            manifest,
            module: publicAuthoringEntry,
        });
        try {
            const resource = testkit.registration('resources', 'project-companion-dashboard-document');
            expect(resource).toBeDefined();
            if (!resource) throw new Error('project_companion_dashboard_document_resource_not_registered');

            const accountBoundary = createReviewSessionStatusAccountStorage('Check the authorization boundary.');
            const uiFixture = await createPluginUiTestkit({
                identity: {
                    pluginId: manifest.id,
                    pluginVersion: manifest.version,
                    viewId: 'project-companion-dashboard',
                    generation: 'public-authoring-project-companion-dashboard-test',
                    sessionId: 'session-1',
                },
                surface: { kind: 'public-authoring-project-companion-dashboard-test' },
                surfaceContext: createSurfaceContextFixture({
                    mount: {
                        kind: 'destination',
                        destination: { pluginId: manifest.id, localId: 'project-companion-dashboard' },
                        container: 'rightPane',
                    },
                    target: { kind: 'session', sessionId: 'session-1' },
                }),
                adapter: createNoopSemanticAdapter(),
                handlers: {
                    async readResource({ resource: requested, signal }) {
                        expect(requested).toBe('project-companion-dashboard-document');
                        const document = await resource.read({
                            signal,
                            context: { kind: 'session', sessionId: 'session-1' },
                            accountStorage: accountBoundary.accountStorage,
                        });
                        return {
                            contentType: PLUGIN_DECLARATIVE_DOCUMENT_CONTENT_TYPE_V1,
                            digest: `sha256:${'d'.repeat(64)}`,
                            bytes: typeof document === 'string'
                                ? new TextEncoder().encode(document)
                                : document,
                        };
                    },
                },
            });
            try {
                const response = await uiFixture.context.hostApi.readResource(
                    'project-companion-dashboard-document',
                );
                const candidate = JSON.parse(new TextDecoder().decode(response.bytes)) as unknown;
                const normalized = normalizePluginDeclarativeDocumentV1({
                    pluginId: manifest.id,
                    generation: 'public-authoring-project-companion-dashboard-test',
                    document: candidate,
                    actions: [],
                    resourceContentTypes: {
                        declaredContentType: documentResource?.contentType,
                        returnedContentType: response.contentType,
                    },
                });
                expect(normalized.root).toMatchObject({
                    kind: 'group',
                    path: 'root',
                    title: 'Project Companion',
                    children: [{
                        kind: 'status',
                        label: 'Review status',
                        value: 'Check the authorization boundary.',
                    }],
                });

                const invalidated = vi.fn();
                const watchController = new AbortController();
                resource.observe(invalidated, {
                    signal: watchController.signal,
                    context: { kind: 'session', sessionId: 'session-1' },
                    accountStorage: accountBoundary.accountStorage,
                });
                accountBoundary.emitChange();
                expect(invalidated).toHaveBeenCalledTimes(1);
                watchController.abort('project_companion_dashboard_retired');
                expect(accountBoundary.isWatchDisposed()).toBe(true);
            } finally {
                await uiFixture.dispose();
            }
        } finally {
            await testkit.dispose();
        }
    });

    it('opens Project Companion Session details through the mounted public host owner', async () => {
        const manifest = readExampleManifest('public-authoring');
        const activityView = manifest.contributes.ui.views.find(
            (view) => view.id === 'project-companion-activity-log',
        );
        expect(activityView).toMatchObject({
            container: 'bottomPane',
            target: { kind: 'session' },
            renderer: 'review-native',
            instancePolicy: 'singleton',
        });
        const nativeRenderer = manifest.contributes.ui.renderers.find(
            (renderer) => renderer.kind !== 'declarative' && renderer.id === 'review-native',
        );
        expect(nativeRenderer).toMatchObject({
            requiredHostMethods: expect.arrayContaining(['openSurface']),
        });

        const hostedPanel = await import(pathToFileURL(
            join(examplesRoot, 'public-authoring', 'ui', 'reviewPanel.web.tsx'),
        ).href) as Readonly<{
            openProjectCompanionReviewDetails?: (host: PluginUiHostApi, signal?: AbortSignal) => Promise<void>;
        }>;
        const openSurface = vi.fn();
        const fixture = await createPluginUiTestkit({
            identity: {
                pluginId: manifest.id,
                pluginVersion: manifest.version,
                viewId: 'project-companion-activity-log',
                generation: 'public-authoring-project-companion-open-details-test',
                sessionId: 'session-1',
            },
            surface: { kind: 'public-authoring-project-companion-open-details-test' },
            surfaceContext: createSurfaceContextFixture({
                mount: {
                    kind: 'destination',
                    destination: { pluginId: manifest.id, localId: 'project-companion-activity-log' },
                    container: 'bottomPane',
                },
                target: { kind: 'session', sessionId: 'session-1' },
            }),
            adapter: createNoopSemanticAdapter(),
            handlers: { openSurface },
        });
        try {
            expect(hostedPanel.openProjectCompanionReviewDetails).toEqual(expect.any(Function));
            await hostedPanel.openProjectCompanionReviewDetails!(fixture.context.hostApi, fixture.context.signal);
            expect(openSurface).toHaveBeenCalledWith(expect.objectContaining({
                view: {
                    pluginId: manifest.id,
                    localId: 'review-session-status-details',
                },
                signal: expect.any(AbortSignal),
            }));
        } finally {
            await fixture.dispose();
        }
    });

    it('executes declared Voice account operations through the provider runtime owner', async () => {
        const voiceModule = await import(pathToFileURL(
            join(examplesRoot, 'public-authoring', 'voiceProvider.ts'),
        ).href) as Readonly<{
            activate(api: Pick<PluginClientApi, 'actions' | 'voiceProviders'>): void;
        }>;
        const captured = new Map<string, RegisteredVoiceProviderRuntime>();
        voiceModule.activate({
            actions: { register() {} },
            voiceProviders: {
                register(id, runtime) {
                    captured.set(id, runtime);
                },
            },
        });
        const capturedRuntime = captured.get('credentialed-browser');
        if (!capturedRuntime) {
            throw new Error('credentialed_browser_voice_provider_not_registered');
        }
        expect([...captured.keys()]).toEqual(['credentialed-browser', 'raw-browser']);
        const runtime = capturedRuntime;
        if (!('protocol' in runtime)) {
            throw new Error('credentialed_browser_voice_provider_not_conversation_runtime');
        }
        const signal = new AbortController().signal;
        const accountOperationRequest = vi.fn(async (
            input: Parameters<VoiceAccountOperationService['request']>[0],
        ) => {
            const body = input.operationId === 'client-auth'
                ? {
                    sessionToken: 'short-lived-client-token',
                    expiresAtMs: 4_000_000_000_000,
                }
                : input.operationId === 'list-catalog'
                    ? {
                        voices: [{
                            voiceId: 'synthetic-voice',
                            displayName: 'Synthetic Voice',
                            locale: 'en',
                        }],
                    }
                    : null;
            if (!body) {
                throw new Error(`unexpected_voice_account_operation:${input.operationId}`);
            }
            return {
                status: 200,
                finalUrl: `https://voice.example.test/v1/${
                    input.operationId === 'client-auth' ? 'session' : 'catalog'
                }`,
                headers: { 'content-type': 'application/json' },
                body: new TextEncoder().encode(JSON.stringify(body)),
            };
        });
        const accountOperations: VoiceAccountOperationService = {
            request: accountOperationRequest,
        };

        const preparation = await runtime.protocol.prepare({
            controlSessionId: 'public-authoring-voice',
            attemptId: 1,
            reason: 'initial',
            request: null,
            platform: 'web',
            providerConfig: {},
            credentials: {
                phase: 'prepare',
                mediated: accountOperations,
                raw: null,
            },
            providerConversation: null,
            hostedConversation: null,
            signal,
        });
        expect(preparation.kind).toBe('prepared');
        if (preparation.kind !== 'prepared') {
            throw new Error(`unexpected_voice_preparation:${preparation.kind}`);
        }
        expect(accountOperationRequest).toHaveBeenNthCalledWith(1, {
            operationId: 'client-auth',
            parameters: {},
            signal,
        });
        expect(preparation.session.safeMetadata).toEqual({});
        expect(JSON.stringify(preparation.session.safeMetadata)).not.toContain(
            'short-lived-client-token',
        );

        const settingsOperations = runtime.settingsOperations;
        if (!settingsOperations?.listCatalog) {
            throw new Error('credentialed_browser_voice_catalog_not_registered');
        }
        await expect(settingsOperations.listCatalog({
            catalog: 'voices',
            providerConfig: {},
            credentials: {
                phase: 'settings',
                mediated: accountOperations,
                raw: null,
            },
            signal,
        })).resolves.toEqual([{
            id: 'synthetic-voice',
            name: 'Synthetic Voice',
            metadata: { locale: 'en' },
        }]);
        expect(accountOperationRequest).toHaveBeenNthCalledWith(2, {
            operationId: 'list-catalog',
            parameters: {},
            signal,
        });

        const executeAction = vi.fn(async (): Promise<never> => {
            throw new Error('ui_execute_action_must_not_own_voice_account_operations');
        });
        const manifest = readExampleManifest('public-authoring');
        const uiFixture = await createPluginUiTestkit({
            identity: {
                pluginId: manifest.id,
                pluginVersion: manifest.version,
                viewId: 'project-companion-activity-log',
                generation: 'public-authoring-voice-host-test',
                sessionId: 'session-1',
            },
            surface: { kind: 'public-authoring-voice-host-test' },
            surfaceContext: createSurfaceContextFixture({
                mount: {
                    kind: 'destination',
                    destination: { pluginId: manifest.id, localId: 'project-companion-activity-log' },
                    container: 'bottomPane',
                },
                target: { kind: 'session', sessionId: 'session-1' },
            }),
            adapter: createNoopSemanticAdapter(),
            handlers: { executeAction },
        });
        const unexpectedMediaCall = (): never => {
            throw new Error('unexpected_voice_media_call');
        };
        try {
            const connection = await runtime.createConnection({
                session: preparation.session,
                attemptId: 1,
                mic: {
                    ensureActive: async () => undefined,
                    setMuted: () => undefined,
                    isMuted: () => false,
                    teardown: async () => undefined,
                    getStream: () => null,
                },
                interruption: { duckGain: 0.25, retainedOutputMaxMs: 500 },
                levels: { onOutputLevel: () => undefined },
                media: {
                    createSdkHandleConnection: unexpectedMediaCall,
                    createWebRtcConnection: unexpectedMediaCall,
                    createPcmConnection: unexpectedMediaCall,
                },
                tools: [],
                ui: uiFixture.context.hostApi,
                signal,
                execution: { kind: 'direct_media' },
                credentials: {
                    phase: 'connection',
                    mediated: accountOperations,
                    raw: null,
                },
            });
            await connection.connect(signal);
            expect(executeAction).not.toHaveBeenCalled();
            await connection.close({ code: 'user_stop' });
        } finally {
            await uiFixture.dispose();
        }
    });

    it('registers declaration-correspondent public speech runtimes and prepares raw access without disclosure', async () => {
        const clientModule = await import(pathToFileURL(
            join(examplesRoot, 'public-authoring', 'voiceProvider.ts'),
        ).href) as Readonly<{
            activate(api: Pick<PluginClientApi, 'actions' | 'voiceProviders'>): void;
        }>;
        const manifest = readExampleManifest('public-authoring');
        const publicAuthoringEntry = await loadPublicAuthoringSourceActivationEntry();
        const testkit = await createPluginTestkit({
            manifest,
            module: publicAuthoringEntry,
        });
        const captured = new Map<string, RegisteredVoiceProviderRuntime>();
        const api = {
            actions: { register() {} },
            voiceProviders: {
                register(localId: string, runtime: RegisteredVoiceProviderRuntime) {
                    captured.set(localId, runtime);
                },
            },
        };
        clientModule.activate(api);
        try {
            const stt = testkit.registration('voiceProviders', 'speech-stt') as SpeechProviderRuntime | undefined;
            const tts = testkit.registration('voiceProviders', 'speech-tts') as SpeechProviderRuntime | undefined;
            expect(stt).toMatchObject({ kind: 'speech', transcribe: expect.any(Function) });
            expect(stt).not.toHaveProperty('synthesize');
            expect(tts).toMatchObject({
                kind: 'speech', synthesize: expect.any(Function),
                settingsActions: { execute: expect.any(Function) },
            });
            expect(tts).not.toHaveProperty('transcribe');
            expect(testkit.registration('voiceProviders', 'credentialed-browser')).toBeUndefined();
            expect(testkit.registration('voiceProviders', 'raw-browser')).toBeUndefined();

            const rawConversation = captured.get('raw-browser');
            if (!rawConversation || !('protocol' in rawConversation)) {
                throw new Error('raw_browser_voice_provider_not_registered');
            }
            await expect(rawConversation.protocol.prepare({
                controlSessionId: 'public-authoring-raw-voice',
                attemptId: 1,
                reason: 'initial',
                request: null,
                platform: 'web',
                providerConfig: {},
                credentials: { phase: 'prepare', mediated: null, raw: null },
                providerConversation: null,
                hostedConversation: null,
                signal: new AbortController().signal,
            })).resolves.toMatchObject({
                kind: 'prepared',
                session: { config: {}, safeMetadata: {} },
            });
        } finally {
            await testkit.dispose();
        }
    });

    it('ships the required installable example plugin packages', () => {
        const missing: string[] = [];
        for (const exampleName of requiredExamples) {
            const root = join(examplesRoot, exampleName);
            const files = [
                'README.md',
                '.happier-plugin/plugin.json',
                'src/index.ts',
            ];
            for (const file of files) {
                try {
                    readFileSync(join(root, file), 'utf8');
                } catch {
                    missing.push(`${exampleName}/${file}`);
                }
            }
        }

        expect(missing).toEqual([]);
        const examplesTypeScriptConfig = JSON.parse(
            readFileSync(join(examplesRoot, 'tsconfig.json'), 'utf8'),
        ) as {
            compilerOptions?: { jsx?: string; paths?: Readonly<Record<string, readonly string[]>> };
            include?: readonly string[];
        };
        expect(examplesTypeScriptConfig.compilerOptions?.paths).toBeUndefined();
        expect(examplesTypeScriptConfig.compilerOptions?.jsx).toBe('preserve');
        expect(examplesTypeScriptConfig.include).toContain('**/*.tsx');
    });

    it('parses every example manifest with the protocol schema', () => {
        for (const exampleName of requiredExamples) {
            expect(readExampleManifest(exampleName).id).toMatch(/^examples\./u);
        }
    });

    it('authors every external UI destination through the canonical container and target contract', () => {
        for (const exampleName of requiredExamples) {
            const manifest = readExampleManifest(exampleName);
            for (const view of manifest.contributes.ui.views) {
                expect(view).toMatchObject({
                    container: expect.any(String),
                    target: expect.objectContaining({ kind: expect.any(String) }),
                });
                expect(view).not.toHaveProperty('placement');
            }
        }

        const descriptor = readExampleManifest('descriptor-only');
        expect(descriptor.contributes.ui.settingsPages).toContainEqual(expect.objectContaining({
            id: 'settings',
            renderer: 'settings-form',
        }));
        expect(descriptor.contributes.ui.views).not.toContainEqual(expect.objectContaining({ id: 'settings' }));
    });

    it('does not expose a second author candidate registry outside the packed-candidate harness', () => {
        const quickstart = readFileSync(
            join(repoRoot, 'apps', 'docs', 'content', 'docs', 'plugins', 'quickstart.mdx'),
            'utf8',
        );
        const testsPackageJson = JSON.parse(readFileSync(
            join(repoRoot, 'packages', 'tests', 'package.json'),
            'utf8',
        )) as { scripts?: Readonly<Record<string, unknown>> };

        expect(quickstart).not.toMatch(/(?:local candidate registry|plugin-platform:author-registry|HAPPIER_PLUGIN_CANDIDATE_(?:REGISTRY_ORIGIN|SDK_VERSION))/iu);
        expect(testsPackageJson.scripts).not.toHaveProperty('plugin-platform:author-registry');
        expect(testsPackageJson.scripts?.['test:scripts:self']).not.toContain('author-candidate-registry.test.mjs');
        expect(existsSync(join(
            repoRoot,
            'packages',
            'tests',
            'scripts',
            'plugin-platform',
            'author-candidate-registry.mjs',
        ))).toBe(false);
    });

    it('documents shorthand surface declarations and the hosted scaffold without advertising runtime support', () => {
        const uiIndex = readFileSync(join(pluginUiDocsRoot, 'index.mdx'), 'utf8');
        const hostedWeb = readFileSync(join(pluginUiDocsRoot, 'hosted-web.mdx'), 'utf8');
        const reactNative = readFileSync(join(pluginUiDocsRoot, 'react-native.mdx'), 'utf8');
        const uiArtifacts = readFileSync(join(pluginUiDocsRoot, 'ui-artifacts.mdx'), 'utf8');
        const testing = readFileSync(
            join(repoRoot, 'apps', 'docs', 'content', 'docs', 'plugins', 'testing', 'index.mdx'),
            'utf8',
        );
        // Availability is stated per host, derived from the frame-adapter owner each host
        // runs. A single global sentence cannot be true: it is wrong for Linux/Wayland (no
        // adapter) and wrong for Windows and Linux/X11 (direct-Wry child, same as macOS).
        const hostedRuntimePerHost = 'each host then reports the one physical frame adapter it can construct, so packaged runtime availability is per host rather than a single global claim';
        const retiredGlobalClaim = 'packaged runtime support remains unavailable until the platform-specific frame adapter is present and verified';

        expect(uiIndex).toContain(hostedRuntimePerHost);
        expect(uiIndex).not.toContain(retiredGlobalClaim);
        expect(hostedWeb).not.toContain(retiredGlobalClaim);
        expect(uiArtifacts).not.toContain(retiredGlobalClaim);
        // The published per-host rows must name every desktop cell the frame owner decides,
        // including the one it refuses, so no reader infers generic packaged-desktop support.
        for (const perHostRow of [
            '| Browser | DOM iframe |',
            '| Packaged desktop — macOS |',
            '| Packaged desktop — Windows |',
            '| Packaged desktop — Linux/X11 |',
            '| Packaged desktop — Linux/Wayland |',
            'desktop_hosted_artifact_wayland_gtk_container_unimplemented',
            'desktop_hosted_artifact_linux_display_unavailable',
        ]) {
            expect(hostedWeb).toContain(perHostRow);
        }
        expect(uiIndex).toContain('--ui hostedWeb');
        expect(hostedWeb).toContain('--ui hostedWeb');
        expect(hostedWeb).toContain('createPluginUiRenderContext');
        expect(uiIndex).toContain(
            "await context.hostApi.executeAction('save-note', { note: 'hello' }, { signal: context.signal });",
        );
        expect(uiArtifacts).toContain("platforms: ['web', 'ios', 'android']");
        expect(uiArtifacts).not.toContain("platforms: ['web']");
        expect(uiArtifacts).toContain("entry: 'src/ui/index.ts'");
        expect(uiArtifacts).not.toContain("entry: 'ui/index.ts'");
        expect(reactNative).toContain("import { definePlugin, defineUiSurfaceDefinition } from '@happier-dev/plugin-sdk';");
        expect(reactNative).toContain('const mainSurface = defineUiSurfaceDefinition({');
        expect(reactNative).toContain("placement: 'appPage'");
        expect(reactNative).toContain("kind: 'reactNative'");
        expect(reactNative).toContain("platforms: ['web', 'ios', 'android']");
        expect(reactNative).toContain("containerName: 'happier_plugin_com_example_my_plugin_main_renderer'");
        expect(reactNative).toContain('surfaces: [mainSurface]');
        expect(reactNative).toContain("import { defineBuildConfig } from '@happier-dev/plugin-sdk/ui/build';");
        expect(reactNative).toContain("entry: 'src/ui/PluginPanel.tsx'");
        expect(reactNative).toContain("rendererId: 'main-renderer'");
        expect(reactNative).not.toContain('buildUiSurfaceTargets');
        expect(reactNative).not.toContain("from './plugin.js'");
        expect(reactNative).not.toContain("container: 'appPage'");
        expect(reactNative).not.toContain("target: { kind: 'app' }");
        expect(reactNative).not.toContain("renderer: 'main-native'");
        expect(reactNative).toContain("requiredHostMethods: ['context', 'executeAction']");
        expect(reactNative).toMatch(/admission requirement, not a\s+method-availability claim/u);
        expect(reactNative).toContain('`useLivePluginResource`');
        expect(reactNative).toMatch(/same-plugin, statically declared Data UI\s+query/u);
        expect(reactNative).toMatch(/not a\s+Happier component contract/u);
        expect(reactNative).not.toContain('manifest declares surface identity, placement');
        expect(testing).toContain('`createPluginUiTestkit`');
        expect(testing).toMatch(/does not prove\s+layout, styling, native reconciliation, CSP\/origin/u);
        expect(testing).toMatch(/installed discovery, on-demand activation, generation\s+replacement/u);
    });

    it('states hosted-web availability as a per-host fact on every overview page', () => {
        for (const documentPath of [
            join(repoRoot, 'apps', 'docs', 'content', 'docs', 'plugins', 'glossary.mdx'),
            join(repoRoot, 'apps', 'docs', 'content', 'docs', 'plugins', 'index.mdx'),
            join(repoRoot, 'apps', 'docs', 'content', 'docs', 'plugins', 'manifest', 'contributions.mdx'),
            join(repoRoot, 'apps', 'docs', 'content', 'docs', 'plugins', 'manifest', 'package-anatomy.mdx'),
            join(repoRoot, 'apps', 'docs', 'content', 'docs', 'plugins', 'security', 'index.mdx'),
            join(repoRoot, 'apps', 'docs', 'content', 'docs', 'plugins', 'security', 'sandboxing.mdx'),
            join(repoRoot, 'apps', 'docs', 'content', 'docs', 'plugins', 'security', 'trust-model.mdx'),
        ]) {
            const document = readFileSync(documentPath, 'utf8');
            // The retired claim asserted one global feasibility gate. Hosts now
            // each report the one frame adapter they constructed, so the page
            // must neither repeat the retired sentence nor drop the caveat and
            // read as an unconditional availability claim.
            expect(document, `${documentPath} must not repeat the retired global hosted-web unavailability claim`)
                .not.toContain('Artifact-backed frame adapter');
            expect(document, `${documentPath} must state hosted-web availability as a per-host fact`)
                .toMatch(/availability\s+is\s+(?:reported\s+)?per\s+host|per\s+host:|host-constructed frame adapter|each host reports/iu);
            expect(document, `${documentPath} must keep the typed unavailable outcome visible`)
                .toMatch(/\bunavailable\b/iu);
        }
    });

    it('documents openable-content viewers as same-plugin UI view destinations', () => {
        const contributions = readFileSync(
            join(repoRoot, 'apps', 'docs', 'content', 'docs', 'plugins', 'manifest', 'contributions.mdx'),
            'utf8',
        );

        expect(contributions).toContain('`contributes.openableContentViewers`');
        expect(contributions).toContain('`destination` is a same-plugin local reference to `contributes.ui.views`.');
        expect(contributions).toContain('not a renderer, route, placement, or host-projection binding');
    });

    it('keeps hosted source/build claims distinct from unavailable app-adoption evidence', () => {
        const hostedUnavailable = 'Packaged hosted-web rendering availability is reported per host; a host that cannot construct its frame adapter reports a typed unavailable reason instead.';
        for (const exampleName of ['hosted-web', 'multi-mode-fallback'] as const) {
            const manifest = readExampleManifest(exampleName);
            expect(manifest.contributes.ui.renderers).toContainEqual(
                expect.objectContaining({ kind: 'hostedWeb' }),
            );
            expect(readFileSync(join(examplesRoot, exampleName, 'README.md'), 'utf8')).toContain(
                hostedUnavailable,
            );
        }

        const productionReference = readFileSync(
            join(examplesRoot, 'public-authoring', 'README.md'),
            'utf8',
        );
        expect(readExampleManifest('public-authoring').contributes.ui.renderers).toContainEqual(
            expect.objectContaining({ kind: 'hostedWeb' }),
        );
        expect(productionReference).toMatch(
            /This reference proves code-defined public authoring and its source build entry\s+shape\./u,
        );
        expect(productionReference).toMatch(
            /It does \*\*not\*\* claim a packed archive, package-load, loaded Artifact\s+adoption, or browser, iOS, or Android proof\./u,
        );
        expect(productionReference).toContain('when the canonical publisher/artifact is available');
        expect(productionReference).toContain('there is no global fixed candidate');
        expect(productionReference).not.toContain(hostedUnavailable);
    });

    it('retains the hosted bridge browser QA owner', () => {
        const qaRoot = join(repoRoot, 'packages', 'tests', 'scripts', 'plugin-platform');
        expect(existsSync(join(qaRoot, 'run-hosted-web-bridge-browser-qa.mjs'))).toBe(true);
        expect(existsSync(join(qaRoot, 'run-hosted-web-bridge-browser-qa.test.mjs'))).toBe(true);
    });

    it('typechecks public UI documentation snippets against the source public packages', () => {
        const copiedRoot = copyExamplesOutsideWorkspace();
        try {
            const snippets = [
                ['index-react-native.tsx', join(pluginUiDocsRoot, 'index.mdx'), 'tsx', 0],
                ['react-native.tsx', join(pluginUiDocsRoot, 'react-native.mdx'), 'tsx', 0],
                // The Composer guide's mounted read path and staged-media leaf
                // are complete author files without a `definePlugin` call, so
                // the definePlugin snippet lane does not reach them.
                ['composer-mounted-read.tsx', join(pluginGuidesDocsRoot, 'composer.mdx'), 'tsx', 0],
                ['composer-staged-media.ts', join(pluginGuidesDocsRoot, 'composer.mdx'), 'ts', 1],
                ['action-resource-ui-panel.tsx', join(pluginExamplesDocsRoot, 'action-resource-ui-plugin.mdx'), 'tsx', 0],
            ] as const;
            const sourceFiles: string[] = [];
            for (const [fileName, documentPath, language, occurrence] of snippets) {
                const sourcePath = join(copiedRoot, 'documented-ui-snippets', fileName);
                mkdirSync(join(sourcePath, '..'), { recursive: true });
                writeFileSync(sourcePath, readFencedCode(documentPath, language, occurrence), 'utf8');
                sourceFiles.push(relative(copiedRoot, sourcePath));
            }

            const configPath = join(copiedRoot, 'documented-ui-snippets.tsconfig.json');
            writeFileSync(configPath, `${JSON.stringify({
                compilerOptions: {
                    target: 'ES2022',
                    module: 'ESNext',
                    moduleResolution: 'Bundler',
                    lib: ['ES2022', 'DOM'],
                    strict: true,
                    skipLibCheck: true,
                    jsx: 'preserve',
                },
                files: sourceFiles,
            }, null, 2)}\n`, 'utf8');
            const typecheck = spawnSync(process.execPath, [
                join(repoRoot, 'scripts', 'workspaces', 'runTypeScriptCli.mjs'),
                '-p',
                configPath,
                '--noEmit',
            ], {
                cwd: copiedRoot,
                encoding: 'utf8',
            });
            expect(
                typecheck.status,
                [typecheck.stdout, typecheck.stderr].filter(Boolean).join('\n'),
            ).toBe(0);
        } finally {
            rmSync(copiedRoot, { recursive: true, force: true });
        }
    });

    it('typechecks every complete definePlugin documentation example against the public SDK', async () => {
        const excludedExamples = new Map<string, string>([
            [
                'agent-runtimes/agent-runtime.mdx#0',
                'shape-only runtime excerpt; its factory is defined in the linked package reference',
            ],
            [
                'examples/agent-runtime-plugin.mdx#0',
                'shape-only runtime excerpt; its factory is defined in the linked package reference',
            ],
            [
                'api/lifecycle.mdx#0',
                'illustrative resource-acquisition callback; the helper is intentionally owned by the plugin',
            ],
        ]);

        const candidates: Array<Readonly<{
            key: string;
            language: 'ts' | 'tsx';
            source: string;
        }>> = [];
        for (const documentPath of await listPublishedAuthoringDocumentationFiles()) {
            const relativeDocumentPath = publishedAuthoringDocumentationKey(documentPath);
            for (const [blockIndex, block] of readFencedCodeBlocks(documentPath).entries()) {
                if (!['ts', 'tsx'].includes(block.language) || !containsDefinePluginCall(block.source)) {
                    continue;
                }
                const language = block.language as 'ts' | 'tsx';
                candidates.push({
                    key: `${relativeDocumentPath}#${blockIndex}`,
                    language,
                    source: block.source,
                });
            }
        }

        const candidateKeys = candidates.map((candidate) => candidate.key);
        for (const key of excludedExamples.keys()) {
            expect(candidateKeys, `${key} exclusion must match a definePlugin code block`).toContain(key);
        }
        for (const key of documentedSnippetSupportFiles.keys()) {
            expect(candidateKeys, `${key} support files must match a definePlugin code block`).toContain(key);
        }
        expect(candidates.length).toBeGreaterThan(0);
        expect(
            candidateKeys.filter((key) => !excludedExamples.has(key)),
            'Every published definePlugin example must be compiled or have an explicit owner-level exclusion',
        ).toHaveLength(candidates.length - excludedExamples.size);

        expect(
            candidates
                .filter((candidate) => !hasDocumentedPluginDaemonEntrypoint(candidate.source))
                .map((candidate) => candidate.key),
            'Code-defined plugin documentation must name entrypoints.daemon so the canonical author build and pack path can emit its activation module.',
        ).toEqual([]);

        for (const candidate of candidates) {
            for (const localId of collectDocumentationLocalIds(candidate.source)) {
                expectDocumentationLocalId(localId, candidate.key);
            }
        }
        for (const documentPath of await listPublishedAuthoringDocumentationFiles()) {
            const relativeDocumentPath = publishedAuthoringDocumentationKey(documentPath);
            for (const [blockIndex, block] of readFencedCodeBlocks(documentPath).entries()) {
                const location = `${relativeDocumentPath}#${blockIndex}`;
                if (block.language === 'json') {
                    let parsed: unknown;
                    try {
                        parsed = JSON.parse(block.source);
                    } catch {
                        parsed = undefined;
                    }
                    for (const localId of collectManifestJsonLocalIds(parsed)) {
                        expectDocumentationLocalId(localId, location);
                    }
                }
                for (const match of block.source.matchAll(/events\.plugin\.emit\(\s*['"]([^'"]+)['"]/gu)) {
                    expectDocumentationLocalId(match[1], location);
                }
                for (const match of block.source.matchAll(/\blocalId:\s*['"]([^'"]+)['"]/gu)) {
                    expectDocumentationLocalId(match[1], location);
                }
            }
        }

        const snippets = candidates.filter((candidate) => !excludedExamples.has(candidate.key));
        const copiedRoot = copyExamplesOutsideWorkspace();
        try {
            writeFileSync(join(copiedRoot, 'package.json'), '{"type":"module"}\n', 'utf8');
            const channelsProtocolRoot = findInstalledPackageRoot('@happier-dev/channels-protocol');
            expect(channelsProtocolRoot, 'cross-plugin documentation examples need the public feature protocol package').toBeDefined();
            if (channelsProtocolRoot) {
                const channelsProtocolDestination = join(
                    copiedRoot,
                    'node_modules',
                    '@happier-dev',
                    'channels-protocol',
                );
                if (!existsSync(channelsProtocolDestination)) {
                    mkdirSync(join(channelsProtocolDestination, '..'), { recursive: true });
                    symlinkSync(channelsProtocolRoot, channelsProtocolDestination, 'dir');
                }
            }

            const sourceFiles: string[] = [];
            for (const [index, snippet] of snippets.entries()) {
                const safeName = snippet.key.replace(/[^A-Za-z0-9._-]+/gu, '__');
                const sourcePath = join(
                    copiedRoot,
                    'documented-plugin-snippets',
                    `${String(index).padStart(2, '0')}-${safeName}.${snippet.language}`,
                );
                mkdirSync(join(sourcePath, '..'), { recursive: true });
                writeFileSync(sourcePath, `${snippet.source}\n`, 'utf8');
                for (const supportFile of documentedSnippetSupportFiles.get(snippet.key) ?? []) {
                    const destination = join(sourcePath, '..', supportFile.destination);
                    mkdirSync(join(destination, '..'), { recursive: true });
                    cpSync(join(copiedRoot, supportFile.source), destination);
                }
                sourceFiles.push(relative(copiedRoot, sourcePath));
            }

            const configPath = join(copiedRoot, 'documented-plugin-snippets.tsconfig.json');
            writeFileSync(configPath, `${JSON.stringify({
                compilerOptions: {
                    target: 'ES2022',
                    module: 'ESNext',
                    moduleResolution: 'Bundler',
                    lib: ['ES2022', 'DOM'],
                    strict: true,
                    skipLibCheck: true,
                    jsx: 'preserve',
                },
                files: sourceFiles,
            }, null, 2)}\n`, 'utf8');
            const typecheck = spawnSync(process.execPath, [
                join(repoRoot, 'scripts', 'workspaces', 'runTypeScriptCli.mjs'),
                '-p',
                configPath,
                '--noEmit',
            ], {
                cwd: copiedRoot,
                encoding: 'utf8',
            });
            expect(
                typecheck.status,
                [typecheck.stdout, typecheck.stderr].filter(Boolean).join('\n'),
            ).toBe(0);

            for (const [index, snippet] of snippets.entries()) {
                const sourceFile = sourceFiles[index];
                if (!sourceFile) throw new Error(`Missing compiled documentation source for ${snippet.key}`);
                const emittedFile = join(copiedRoot, sourceFile.replace(/\.tsx?$/u, '.js'));
                const documentedModule = await import(pathToFileURL(emittedFile).href) as Readonly<{
                    manifest?: unknown;
                }>;
                const parsed = parsePluginManifest(documentedModule.manifest);
                expect(
                    parsed.ok,
                    parsed.ok
                        ? undefined
                        : `${snippet.key}: ${parsed.diagnostics.map((diagnostic) => diagnostic.message).join('; ')}`,
                ).toBe(true);
            }
        } finally {
            rmSync(copiedRoot, { recursive: true, force: true });
        }
    });

    it('parses the advertised minimal cold manifest through the current public manifest contract', () => {
        const minimalManifestBlock = readFencedCodeBlocks(minimalManifestDocumentationPath).find((block) => (
            block.language === 'json'
            && block.source.includes('"schemaVersion": 2')
            && block.source.includes('"id": "com.example.plugin"')
        ));
        expect(minimalManifestBlock, 'The manifest guide must retain one advertised minimal cold manifest.').toBeDefined();
        if (!minimalManifestBlock) return;

        const parsed = parsePluginManifest(JSON.parse(minimalManifestBlock.source) as unknown);
        expect(
            parsed.ok,
            parsed.ok
                ? undefined
                : parsed.diagnostics.map((diagnostic) => diagnostic.message).join('; '),
        ).toBe(true);
    });

    it('parses the code-defined public authoring manifest with the protocol schema', () => {
        const ingested = parsePluginManifest(publicAuthoringCodeDefinedPlugin.manifest);

        expect(
            ingested.ok,
            ingested.ok ? undefined : JSON.stringify(ingested.diagnostics),
        ).toBe(true);
        if (ingested.ok) {
            expect(ingested.manifest.contributes.voiceModelPacks).toHaveLength(1);
            expect(ingested.manifest.contributes.voiceProviders).toHaveLength(4);
            expect(ingested.manifest.contributes.voiceProviders[0]).toMatchObject({
                id: 'credentialed-browser',
                platforms: ['web'],
                credentials: {
                    slot: { id: 'api_key', purpose: 'voice.client-auth' },
                    hostMediated: {
                        operations: [
                            expect.objectContaining({
                                id: 'client-auth',
                                purpose: 'voice.client-auth',
                                credentialSlotId: 'api_key',
                                request: expect.objectContaining({ method: 'POST' }),
                            }),
                            expect.objectContaining({
                                id: 'list-catalog',
                                purpose: 'voice.catalog',
                                credentialSlotId: 'api_key',
                                request: expect.objectContaining({ method: 'GET' }),
                            }),
                        ],
                    },
                },
            });
            expect(ingested.manifest.contributes.voiceProviders[1]).toMatchObject({
                id: 'raw-browser',
                credentials: {
                    sources: [
                        expect.objectContaining({
                            kind: 'savedSecret',
                            rawGrants: [expect.objectContaining({ realm: 'web', phase: 'connection' })],
                        }),
                        expect.objectContaining({
                            kind: 'connectedAccount',
                            service: { pluginId: 'acme.connected-accounts', localId: 'voice-oauth' },
                            rawGrants: [expect.objectContaining({ realm: 'web', phase: 'connection' })],
                        }),
                    ],
                },
            });
            expect(ingested.manifest.contributes.voiceProviders[2]).toMatchObject({
                id: 'speech-stt',
                catalogs: [{ kind: 'models', settingFieldId: 'model', allowCustom: true }],
            });
            expect(ingested.manifest.contributes.voiceProviders[3]).toMatchObject({
                id: 'speech-tts',
                catalogs: [{ kind: 'voices', settingFieldId: 'voice', allowCustom: false }],
                settings: { actions: [expect.objectContaining({ id: 'refresh-voices' })] },
            });
            expect(ingested.manifest.contributes.settings).toEqual(expect.arrayContaining([
                expect.objectContaining({ id: 'preferences', scope: 'account' }),
            ]));
            expect(ingested.manifest.hostAccess.required).toContainEqual(expect.objectContaining({
                id: 'model-pack-downloads',
                capability: 'network',
            }));
            expect(ingested.manifest.hostAccess.required).toEqual(expect.arrayContaining([
                expect.objectContaining({
                    id: 'voice-client-auth',
                    capability: 'network',
                    scope: expect.objectContaining({ methods: ['POST'] }),
                }),
                expect.objectContaining({
                    id: 'voice-catalog',
                    capability: 'network',
                    scope: expect.objectContaining({ methods: ['GET'] }),
                }),
            ]));
            expect(ingested.manifest.contributes.actions).toEqual([
                expect.objectContaining({
                    id: 'review-summary',
                    surfaces: ['cli', 'agent', 'ui'],
                    scopes: ['global'],
                }),
                expect.objectContaining({
                    id: 'external-session-digest',
                    surfaces: ['cli', 'agent', 'ui'],
                    scopes: ['global'],
                    execution: expect.objectContaining({ target: 'daemon' }),
                }),
                expect.objectContaining({
                    id: 'open-review-status',
                    surfaces: ['ui', 'voice'],
                    execution: expect.objectContaining({
                        target: 'client',
                        platforms: ['web', 'ios', 'android'],
                    }),
                }),
                expect.objectContaining({
                    id: 'open-review-status-web-only-fixture',
                    execution: expect.objectContaining({
                        target: 'client',
                        platforms: ['web'],
                    }),
                }),
            ]);
            expect(ingested.manifest.contributes.resources).toEqual([
                expect.objectContaining({
                    id: 'review-guide',
                    source: 'packaged',
                    kind: 'template',
                    path: 'resources/review-guide.md',
                    contentType: 'text/markdown',
                }),
                expect.objectContaining({
                    id: 'agent-context-companion-guide',
                    source: 'packaged',
                    kind: 'template',
                    path: 'resources/agent-context-companion-guide.md',
                    contentType: 'text/markdown',
                }),
                expect.objectContaining({
                    id: 'review-session-status',
                    source: 'dynamic',
                    scope: 'session',
                    hostAccess: ['review-resource-account'],
                }),
                expect.objectContaining({
                    id: 'project-companion-dashboard-document',
                    source: 'dynamic',
                    kind: 'config',
                    contentType: PLUGIN_DECLARATIVE_DOCUMENT_CONTENT_TYPE_V1,
                    scope: 'session',
                    hostAccess: ['review-resource-account'],
                    maxBytes: 8192,
                }),
            ]);
            expect(ingested.manifest.contributes.tools).toContainEqual(expect.objectContaining({
                id: 'review-summary-tool',
                action: 'review-summary',
            }));
            expect(ingested.manifest.contributes.commands).toContainEqual(expect.objectContaining({
                id: 'review-summary-command',
                action: 'review-summary',
            }));
        }
    });

    it('keeps executable source modules from becoming a second manifest owner', async () => {
        for (const exampleName of requiredExamples) {
            const module = await import(pathToFileURL(
                join(examplesRoot, exampleName, 'src/index.ts'),
            ).href) as { manifest?: unknown };
            expect(module).not.toHaveProperty('manifest');
        }
    });

    it('declares distinct strict public UI scenarios without authored artifact rows', async () => {
        const kindsByExample = new Map<string, readonly string[]>();
        for (const exampleName of requiredExamples) {
            const manifest = readExampleManifest(exampleName);
            kindsByExample.set(exampleName, manifest.contributes.ui.renderers.map((renderer) => renderer.kind));
            expect(manifest).not.toHaveProperty('uses');
            expect(manifest).not.toHaveProperty('permissions');
            expect(manifest.contributes).not.toHaveProperty('uiArtifacts');
        }
        expect(kindsByExample.get('descriptor-only')).toEqual(['declarative', 'declarative']);
        expect(kindsByExample.get('hosted-web')).toEqual(['hostedWeb', 'declarative']);
        expect(kindsByExample.get('react-native-installed')).toEqual(['reactNative', 'declarative']);
        expect(kindsByExample.get('react-native-dev-hot-reload')).toEqual(['reactNative', 'declarative']);
        expect(kindsByExample.get('multi-mode-fallback')).toEqual(['reactNative', 'hostedWeb', 'declarative']);
        const developmentModule = await import(pathToFileURL(join(
            examplesRoot,
            'react-native-dev-hot-reload',
            'src/index.ts',
        )).href) as { activate?: unknown };
        expect(developmentModule.activate).toBeTypeOf('function');
    });

    it('declares UI build inputs through the stable public build subpath', async () => {
        // `public-authoring` is checked here with every other UI example: it was
        // previously excluded, which is exactly why its two declared build
        // entries could stay absent from the tree while this suite was green.
        const uiExamples = [
            ...requiredExamples.filter((name) => name !== 'descriptor-only'),
            'projects-tasks',
            'public-authoring',
            'production-hosted-reference',
        ];
        for (const exampleName of uiExamples) {
            const buildPath = join(examplesRoot, exampleName, 'pluginUiBuild.ts');
            expect(readFileSync(buildPath, 'utf8')).toContain("from '@happier-dev/plugin-sdk/ui/build'");
            const module = await import(pathToFileURL(buildPath).href) as {
                pluginUiBuildConfig?: {
                    outDir?: string;
                    targets?: readonly {
                        entry: string;
                        kind: 'reactNative' | 'hostedWeb';
                        module?: Readonly<{
                            containerName: string;
                            modulePath: string;
                            exportName: string;
                        }>;
                        platforms?: readonly string[];
                        rendererId: string;
                    }[];
                };
            };
            expect(module.pluginUiBuildConfig?.targets?.length).toBeGreaterThan(0);
            expect(module.pluginUiBuildConfig?.outDir).toMatch(/^dist\//u);
            expect(module.pluginUiBuildConfig).not.toHaveProperty('surfaces');
            expect(module.pluginUiBuildConfig).not.toHaveProperty('runBundler');
            const manifest = readExampleManifest(exampleName);
            const byRendererId = (
                left: Readonly<{ rendererId: string }>,
                right: Readonly<{ rendererId: string }>,
            ): number => left.rendererId.localeCompare(right.rendererId);
            const executableRenderers = manifest.contributes.ui.renderers
                .filter((renderer) => renderer.kind !== 'declarative')
                .map((renderer) => ({ rendererId: renderer.id, kind: renderer.kind }))
                .sort(byRendererId);
            const targets = module.pluginUiBuildConfig?.targets ?? [];
            const rendererIds = new Set(executableRenderers.map(({ rendererId }) => rendererId));
            // Every executable renderer must be backed by a matching build
            // target. A package may also build non-renderer artifacts (the
            // public-authoring Voice client bundle), so those are checked for a
            // resolvable entry rather than a renderer export contract.
            expect(targets.filter(({ rendererId }) => rendererIds.has(rendererId))
                .map(({ rendererId, kind }) => ({ rendererId, kind }))
                .sort(byRendererId))
                .toEqual(executableRenderers);
            const hostedWebTargets = targets.filter((target) => target.kind === 'hostedWeb');
            const hasHostedWebRenderer = executableRenderers.some((renderer) => renderer.kind === 'hostedWeb');
            expect(hostedWebTargets.some((target) => rendererIds.has(target.rendererId)))
                .toBe(hasHostedWebRenderer);
            for (const target of hostedWebTargets) {
                expect(target).not.toHaveProperty('platforms');
            }
            const reactNativeTargets = targets.filter((target) => target.kind === 'reactNative');
            const hasReactNativeRenderer = executableRenderers.some((renderer) => renderer.kind === 'reactNative');
            expect(reactNativeTargets.some((target) => rendererIds.has(target.rendererId)))
                .toBe(hasReactNativeRenderer);
            for (const target of reactNativeTargets.filter((entry) => rendererIds.has(entry.rendererId))) {
                // A public executable React Native reference is one package
                // graph with its web/iOS/Android siblings, not a web-only
                // source illustration that asks each platform to supply a
                // substitute build later.
                expect(target.platforms).toEqual(expect.arrayContaining(['web', 'ios', 'android']));
                expect(target.platforms?.length).toBeGreaterThan(0);
                expect(target.module).toEqual(expect.objectContaining({
                    containerName: expect.any(String),
                    modulePath: expect.any(String),
                    exportName: expect.any(String),
                }));
            }
            for (const target of targets) {
                expect(target).not.toHaveProperty('bundlerConfig');
            }
            for (const configPath of ['vite.config.mjs', 'rspack.config.mjs', 'react-native.config.cjs']) {
                expect(existsSync(join(examplesRoot, exampleName, configPath)), `${exampleName}/${configPath}`)
                    .toBe(false);
            }
            for (const target of targets) {
                const sourcePath = join(examplesRoot, exampleName, target.entry);
                if (!rendererIds.has(target.rendererId)) continue;
                if (target.kind === 'reactNative') {
                    // RN source imports React Native's Flow-typed platform
                    // runtime, which Node/Vitest cannot parse. The authoring
                    // contract here is the declared source export; the managed
                    // Vite/Re.Pack candidate build is the executable oracle.
                    expect(sourceExportsName(sourcePath, 'renderSurface'), `${exampleName}:${target.rendererId}`).toBe(true);
                } else {
                    expect(sourceExportsName(sourcePath, 'connectHostedWebPanel'), `${exampleName}:${target.rendererId}`).toBe(true);
                }
            }

        }

        const publicAuthoringBuild = await import(pathToFileURL(join(
            examplesRoot,
            'public-authoring',
            'pluginUiBuild.ts',
        )).href) as { pluginUiBuildConfig?: { outDir?: string } };
        expect(publicAuthoringBuild.pluginUiBuildConfig?.outDir).toBe('dist/ui');
    });

    it('keeps public-authoring target-only while the managed-builder test fixture owns the advanced extension seam', () => {
        const publicAuthoringRoot = join(examplesRoot, 'public-authoring');
        const buildSource = readFileSync(join(publicAuthoringRoot, 'pluginUiBuild.ts'), 'utf8');
        expect(buildSource).not.toContain('bundlerConfig');
        for (const configPath of [
            'build/vite.review-native.config.mjs',
            'build/vite.review-openable-native.config.mjs',
            'build/vite.review-openable-web.config.ts',
            'build/vite.review-web.config.ts',
            'build/vite.voice-runtime-web.config.mjs',
            'rspack.config.mjs',
            'react-native.config.cjs',
        ]) {
            expect(existsSync(join(publicAuthoringRoot, configPath)), configPath).toBe(false);
        }
    });

    it('emits declaration-portable examples that name only published SDK specifiers', async () => {
        expect(shouldCopyExamplePath('/tmp/examples/hosted-web/dist/ui/index.js')).toBe(false);
        expect(shouldCopyExamplePath('C:\\tmp\\examples\\hosted-web\\dist\\ui\\index.js')).toBe(false);
        expect(shouldCopyExamplePath('/tmp/examples/hosted-web/node_modules/pkg/index.js')).toBe(false);
        expect(shouldCopyExamplePath('C:\\tmp\\examples\\hosted-web\\node_modules\\pkg\\index.js')).toBe(false);

        const copiedRoot = copyExamplesOutsideWorkspace();
        try {
            // Derived from what the examples actually contain, not a hardcoded
            // inventory: a hardcoded list silently stops covering any file an
            // example adds, and never notices one it declares but never wrote.
            const expectedTypeScriptFiles = (await Promise.all(
                [
                    ...requiredExamples,
                    'background-indexer',
                    'projects-tasks',
                    'code-defined',
                    'tracked-action',
                    'public-authoring',
                    'production-hosted-reference',
                    'advanced-package-root',
                ]
                    .map(async (exampleName) => await listTypeScriptFiles(join(copiedRoot, exampleName))),
            )).flat().filter((path) => (
                !path.endsWith('.d.ts')
                    // Vite/Re.Pack configs are typechecked through each external
                    // package's own declared build dependencies. This public ABI
                    // declaration probe isolates author runtime modules so it does
                    // not smuggle Vite's private declaration graph into the SDK
                    // portability contract.
                && !relative(copiedRoot, path).split(/[\\/]+/u).includes('build')
            ));
            expect(expectedTypeScriptFiles.length).toBeGreaterThan(0);
            const configFile = {
                compilerOptions: {
                    target: 'ES2022',
                    module: 'ESNext',
                    moduleResolution: 'Bundler',
                    lib: ['ES2022', 'DOM'],
                    strict: true,
                    skipLibCheck: true,
                    // Declarations are the outermost portability contract: an
                    // author package that emits `.d.ts` forces every type in a
                    // public SDK signature to be *nameable* from a published
                    // specifier. Without this the examples compile happily while
                    // inlining the SDK's private nested dependency closure.
                    declaration: true,
                    outDir: '.compiled-example-output',
                    jsx: 'preserve',
                },
                files: expectedTypeScriptFiles.map((sourcePath) => relative(copiedRoot, sourcePath)),
            };
            const configPath = join(copiedRoot, 'tsconfig.json');
            writeFileSync(configPath, `${JSON.stringify(configFile, null, 2)}\n`, 'utf8');
            for (const sourcePath of expectedTypeScriptFiles) {
                expect(existsSync(sourcePath), sourcePath).toBe(true);
            }
            const typecheck = spawnSync(process.execPath, [
                join(repoRoot, 'scripts', 'workspaces', 'runTypeScriptCli.mjs'),
                '-p',
                configPath,
            ], {
                cwd: copiedRoot,
                encoding: 'utf8',
            });
            expect(
                typecheck.status,
                [typecheck.stdout, typecheck.stderr].filter(Boolean).join('\n'),
            ).toBe(0);
            const emitRoot = join(copiedRoot, '.compiled-example-output');
            expect(existsSync(emitRoot)).toBe(true);
            const emittedDeclarations: string[] = [];
            for (const sourcePath of expectedTypeScriptFiles) {
                const emittedRelativePath = relative(copiedRoot, sourcePath)
                    .replace(/\.tsx$/u, '.jsx')
                    .replace(/\.ts$/u, '.js');
                expect(existsSync(join(emitRoot, emittedRelativePath)), emittedRelativePath).toBe(true);
                const declarationRelativePath = relative(copiedRoot, sourcePath)
                    .replace(/\.tsx?$/u, '.d.ts');
                const declarationPath = join(emitRoot, declarationRelativePath);
                expect(existsSync(declarationPath), declarationRelativePath).toBe(true);
                emittedDeclarations.push(declarationPath);
            }
            // An author's emitted declarations may only name the SDK or its
            // separately published semantic UI package through public
            // specifiers. Anything else — a bundled protocol package or a
            // transitive dependency — resolves only inside the monorepo and
            // breaks once an author package is consumed elsewhere.
            const allowedSpecifiers = new Set([
                ...readPackageExportSpecifiers(packageJsonPath),
                ...readPackageExportSpecifiers(pluginUiPackageJsonPath),
            ]);
            const nonPortableReferences: string[] = [];
            for (const declarationPath of emittedDeclarations) {
                const declaration = readFileSync(declarationPath, 'utf8');
                for (const [, specifier] of declaration.matchAll(/\bimport\("([^"]+)"\)/gu)) {
                    if (specifier.startsWith('.') || allowedSpecifiers.has(specifier)) {
                        continue;
                    }
                    nonPortableReferences.push(
                        `${relative(emitRoot, declarationPath)} names ${specifier}`,
                    );
                }
            }
            expect([...new Set(nonPortableReferences)]).toEqual([]);
        } finally {
            rmSync(copiedRoot, { recursive: true, force: true });
        }
    });
});
