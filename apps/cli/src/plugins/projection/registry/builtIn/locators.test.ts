import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'vite';

import { describe, expect, it, vi } from 'vitest';
import { definePlugin } from '@happier-dev/plugin-sdk';
import { defineContributionProtocol } from '@happier-dev/plugin-sdk/contributions';
import { defineProtocolObject } from '@happier-dev/plugin-sdk/protocol';
import type { PluginUiArtifactsManifestV2 } from '@happier-dev/protocol/plugins/ui';
import { createBundledPluginPublicationFailure } from '../../../../../../../scripts/workspaces/bundledPluginPublicationFailure.mjs';
import { projectBundledPluginCatalogEntries } from '@/plugins/projection/catalog/installed';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';

import { BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS } from '../sources/generatedBundledPluginManifests';
import {
    loadBundledPluginLocatorResult,
    loadBundledPluginLocators,
    readCurrentBundledPluginPublicationFailures,
    projectManagedRuntimePublicationManifest,
    readBundledPluginManifest,
    type BundledPluginLocator,
} from './locators';

function locator(
    overrides: Partial<BundledPluginLocator & Readonly<{ manifest: unknown }>> = {},
): BundledPluginLocator & Readonly<{ manifest: unknown }> {
    return {
        pluginId: 'happier.provider.fixture',
        manifest: {
            schemaVersion: 2,
            id: 'happier.provider.fixture',
            version: '1.0.0',
            displayName: 'Fixture',
            engines: createPluginManifestV2Fixture().engines, runtime: { apiVersion: 1 },
            hostAccess: { required: [], optional: [] },
            contributes: {},
        },
        manifestPath: 'bundled:happier.provider.fixture',
        daemonEntryPath: null,
        sourceSpec: {
            kind: 'bundled',
            locator: '@happier-dev/plugins-fixture',
            trustPolicy: 'local_trusted',
            installPolicy: 'link',
        },
        ...overrides,
    };
}

describe('bundled plugin locators', () => {
    it('reads an admitted bundled declaration with invalid Settings without dropping healthy families', () => {
        const bundled = locator();
        const result = loadBundledPluginLocatorResult([{ ...bundled, manifest: createPluginManifestV2Fixture({
            id: bundled.pluginId, entrypoints: {}, contributes: { settings: [{ id: 'preferences', title: 'Preferences', scope: 'daemon',
                target: { kind: 'plugin' }, fields: [{ id: 'enabled', title: 'Enabled', schema: { type: 'boolean' }, default: 'true' }] }] },
        }) }]);
        expect(result.pluginFailures).toEqual([]);
        expect(result.loadedPlugins[0]?.manifest.contributes.settings[0]?.id).toBe('preferences');
    });
    it('admits a requested file declaration and isolates an invalid optional manifest', () => {
        const root = mkdtempSync(join(tmpdir(), 'happier-lazy-bundled-declaration-'));
        const execPathDescriptor = Object.getOwnPropertyDescriptor(process, 'execPath')!;
        try {
            writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@happier-dev/cli' }));
            writeFileSync(join(root, 'manifest.json'), JSON.stringify(readBundledPluginManifest(locator())));
            // Native executable identity selects the physical runtime asset root.
            Object.defineProperty(process, 'execPath', { ...execPathDescriptor, value: join(root, 'happier') });
            const { manifest: _inline, ...metadata } = locator();
            const fileLocator = { ...metadata, manifestRelativePath: 'manifest.json' };
            expect(loadBundledPluginLocators([fileLocator])[0]?.manifest.id).toBe(metadata.pluginId);
            writeFileSync(join(root, 'manifest.json'), '{invalid');
            const healthyPluginId = 'happier.provider.healthy';
            writeFileSync(join(root, 'healthy.json'), JSON.stringify(createPluginManifestV2Fixture({
                id: healthyPluginId, entrypoints: {}, contributes: {},
            })));
            const healthyLocator = { ...fileLocator, pluginId: healthyPluginId,
                manifestRelativePath: 'healthy.json', manifestPath: `bundled:${healthyPluginId}`,
                sourceSpec: { ...fileLocator.sourceSpec, locator: '@happier-dev/plugins-healthy' } };
            const failed = loadBundledPluginLocatorResult([fileLocator, healthyLocator]);
            expect(failed.loadedPlugins.map(plugin => plugin.pluginId)).toEqual([healthyPluginId]);
            expect(failed.pluginFailures).toEqual([expect.objectContaining({
                pluginId: metadata.pluginId, diagnostic: expect.objectContaining({ code: 'plugin_manifest_invalid' }),
            })]);
        } finally {
            Object.defineProperty(process, 'execPath', execPathDescriptor);
            rmSync(root, { recursive: true, force: true });
        }
    });
    it('admits derived source declarations and their isolated failures from the explicitly launched bundle', async () => {
        const root = mkdtempSync(join(tmpdir(), 'happier-frozen-source-catalog-'));
        const projectRoot = join(root, 'apps', 'cli');
        const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../../..');
        const previousRoot = process.env.HAPPIER_STACK_CLI_ROOT_DIR;
        try {
            mkdirSync(join(projectRoot, 'src/chunks'), { recursive: true });
            writeFileSync(join(projectRoot, 'package.json'), JSON.stringify({ name: '@happier-dev/cli', type: 'module' }));
            cpSync(join(repoRoot, 'apps/cli/assets/bundled-plugin-manifests'), join(projectRoot, 'assets/bundled-plugin-manifests'), { recursive: true });
            const failurePath = join(projectRoot, '.project/tmp/bundled-plugin-publication/failures.json');
            mkdirSync(dirname(failurePath), { recursive: true });
            writeFileSync(failurePath, JSON.stringify([{
                packageName: '@happier-dev/plugins-inspector', pluginId: 'happier.inspector',
                diagnostic: { code: 'plugin_manifest_invalid', message: 'Captured source declaration is invalid' },
            }]));
            symlinkSync(join(repoRoot, 'node_modules'), join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
            await build({
                configFile: join(repoRoot, 'apps/cli/vitest.config.ts'), logLevel: 'silent',
                build: {
                    outDir: join(projectRoot, 'src/chunks'), emptyOutDir: false, minify: false, sourcemap: false,
                    lib: { entry: fileURLToPath(new URL('./locators.ts', import.meta.url)), formats: ['es'], fileName: () => 'locators.mjs' },
                    rollupOptions: { external: (id) => id.startsWith('node:') || builtinModules.includes(id)
                        || (!id.startsWith('.') && !isAbsolute(id) && !id.startsWith('@/') && !id.startsWith('@happier-dev/') && !id.startsWith('#') && !id.startsWith('\0')) },
                },
            });
            process.env.HAPPIER_STACK_CLI_ROOT_DIR = projectRoot;
            const compiled = await import(/* @vite-ignore */ pathToFileURL(join(projectRoot, 'src/chunks/locators.mjs')).href) as {
                loadCurrentBundledPluginLocatorResult: () => ReturnType<typeof loadBundledPluginLocatorResult>;
                loadBundledPluginLocators: typeof loadBundledPluginLocators;
            };
            const loaded = compiled.loadCurrentBundledPluginLocatorResult();
            expect(loaded.pluginFailures).toEqual([expect.objectContaining({
                pluginId: 'happier.inspector', diagnostic: { code: 'plugin_manifest_invalid', message: 'Captured source declaration is invalid' },
            })]);
            expect(loaded.loadedPlugins.some((plugin) => plugin.pluginId === 'happier.inspector')).toBe(false);
            expect(loaded.loadedPlugins.some((plugin) => plugin.pluginId === 'happier.agent.codex')).toBe(true);
            const retainedPluginRoot = join(root, 'packages/plugins/fixture');
            mkdirSync(join(retainedPluginRoot, 'dist/happier-plugin-ui'), { recursive: true });
            writeFileSync(join(retainedPluginRoot, 'package.json'), JSON.stringify({ name: '@happier-dev/plugins-fixture' }));
            // Declaration custody needs the real host package root even when
            // this package contributes no executable UI graph.
            const [declarationOnly] = compiled.loadBundledPluginLocators([locator()]);
            expect(declarationOnly?.pluginRootPath).toBe(retainedPluginRoot);
            expect(declarationOnly?.generatedUiArtifactsManifest).toBeUndefined();
            const graph = { version: 2, entries: [{ artifactId: 'panel', tier: 'reactNative',
                entry: 'react-native/panel/entry.cjs.bundle', files: [{ relativePath: 'react-native/panel/entry.cjs.bundle',
                    digest: `sha256:${'1'.repeat(64)}`, byteSize: 12 }], digest: `sha256:${'2'.repeat(64)}`,
                builtWith: { bundler: 'esbuild', version: '0.25.0' }, executable: { exports: ['renderSurface'] }, hostUiApiRange: '^1.0.0' }] } satisfies PluginUiArtifactsManifestV2;
            writeFileSync(join(retainedPluginRoot, 'dist/happier-plugin-ui/ui-artifacts.json'), JSON.stringify(graph));
            const [retained] = compiled.loadBundledPluginLocators([locator()]);
            expect(retained?.pluginRootPath).toBe(retainedPluginRoot);
            expect(retained?.generatedUiArtifactsManifest).toEqual(graph);

            // Missing emitted assets cannot silently borrow a mutable installed
            // package's graph. Both locations are genuine filesystem boundaries.
            const linkedPluginRoot = join(projectRoot, 'node_modules/@happier-dev/plugins-fixture');
            mkdirSync(join(linkedPluginRoot, 'dist/happier-plugin-ui'), { recursive: true });
            writeFileSync(join(linkedPluginRoot, 'package.json'), JSON.stringify({ name: '@happier-dev/plugins-fixture' }));
            writeFileSync(join(linkedPluginRoot, 'dist/happier-plugin-ui/ui-artifacts.json'), JSON.stringify(graph));
            rmSync(retainedPluginRoot, { recursive: true, force: true });
            expect(compiled.loadBundledPluginLocators([locator()])[0]?.generatedUiArtifactsManifest).toBeUndefined();
        } finally {
            if (previousRoot === undefined) delete process.env.HAPPIER_STACK_CLI_ROOT_DIR;
            else process.env.HAPPIER_STACK_CLI_ROOT_DIR = previousRoot;
            rmSync(root, { recursive: true, force: true });
        }
    });
    it('admits distribution failures for compiled modules in a source checkout', async () => {
        const root = mkdtempSync(join(tmpdir(), 'happier-compiled-source-catalog-'));
        const projectRoot = join(root, 'apps', 'cli');
        const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../../..');
        try {
            mkdirSync(join(projectRoot, 'src'), { recursive: true });
            writeFileSync(join(projectRoot, 'package.json'), '{}');
            cpSync(join(repoRoot, 'apps/cli/assets/bundled-plugin-manifests'), join(projectRoot, 'assets/bundled-plugin-manifests'), { recursive: true });
            // Installed third-party packages are the Node execution boundary;
            // compile and execute the real current owner and its internal graph.
            symlinkSync(join(repoRoot, 'node_modules'), join(root, 'node_modules'),
                process.platform === 'win32' ? 'junction' : 'dir');
            const failurePath = join(projectRoot, '.project', 'tmp', 'bundled-plugin-publication', 'failures.json');
            mkdirSync(dirname(failurePath), { recursive: true });
            writeFileSync(failurePath, JSON.stringify([{
                packageName: '@happier-dev/plugins-inspector', pluginId: 'happier.inspector',
                diagnostic: { code: 'plugin_package_build_failed', message: 'Current distribution preparation failed' },
            }]));
            await build({
                configFile: join(repoRoot, 'apps', 'cli', 'vitest.config.ts'),
                logLevel: 'silent',
                build: {
                    outDir: join(projectRoot, 'dist'),
                    emptyOutDir: true, minify: false, sourcemap: false,
                    lib: { entry: fileURLToPath(new URL('./locators.ts', import.meta.url)),
                        formats: ['es'], fileName: () => 'locators.mjs' },
                    rollupOptions: {
                        external: (id) => id.startsWith('node:') || builtinModules.includes(id)
                            || (!id.startsWith('.') && !isAbsolute(id) && !id.startsWith('@/')
                                && !id.startsWith('@happier-dev/') && !id.startsWith('#')
                                && !id.startsWith('\0')),
                    },
                },
            });
            // The emitted module namespace is an actual external loader boundary.
            const compiled = await import(/* @vite-ignore */ pathToFileURL(join(projectRoot, 'dist', 'locators.mjs')).href) as {
                loadCurrentBundledPluginLocatorResult: () => ReturnType<typeof loadBundledPluginLocatorResult>;
            };
            const loaded = compiled.loadCurrentBundledPluginLocatorResult();
            expect(loaded.pluginFailures).toEqual([expect.objectContaining({ pluginId: 'happier.inspector' })]);
            expect(loaded.loadedPlugins.some((plugin) => plugin.pluginId === 'happier.inspector')).toBe(false);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('loads current source declarations without a distribution publication inventory', async () => {
        vi.resetModules();
        const { loadCurrentBundledPluginLocatorResult } = await import('./locators');
        const root = mkdtempSync(join(tmpdir(), 'happier-cold-source-catalog-'));
        const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../../..');
        const execPathDescriptor = Object.getOwnPropertyDescriptor(process, 'execPath')!;
        try {
            // The filesystem/process identity is the boundary. The executing
            // module remains source, and semantic ingestion stays real.
            Object.defineProperty(process, 'execPath', { ...execPathDescriptor, value: join(root, 'happier') });
            writeFileSync(join(root, 'package.json'), '{}');
            cpSync(join(repoRoot, 'apps/cli/assets/bundled-plugin-manifests'), join(root, 'assets/bundled-plugin-manifests'), { recursive: true });
            const loaded = loadCurrentBundledPluginLocatorResult();
            expect(loaded.loadedPlugins.some((plugin) => plugin.pluginId === 'happier.agent.codex')).toBe(true);
            expect(loaded.loadedPlugins.some((plugin) => plugin.pluginId === 'happier.agent.ohmypi')).toBe(true);
            expect(() => readFileSync(join(root, '.project', 'tmp', 'bundled-plugin-publication', 'failures.json'))).toThrow();
        } finally {
            Object.defineProperty(process, 'execPath', execPathDescriptor);
            rmSync(root, { recursive: true, force: true });
            vi.resetModules();
        }
    });

    it('retains the process-admitted bundled catalog when publication files change', async () => {
        // This test admits its own process catalog; do not change the admission state
        // used by the existing publication-failure owner tests in this module.
        vi.resetModules();
        const { loadCurrentBundledPluginLocatorResult } = await import('./locators');
        const root = mkdtempSync(join(tmpdir(), 'happier-admitted-bundled-catalog-'));
        const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../../..');
        const execPathDescriptor = Object.getOwnPropertyDescriptor(process, 'execPath')!;
        try {
            Object.defineProperty(process, 'execPath', { ...execPathDescriptor, value: join(root, 'happier') });
            writeFileSync(join(root, 'package.json'), '{}');
            cpSync(join(repoRoot, 'apps/cli/assets/bundled-plugin-manifests'), join(root, 'assets/bundled-plugin-manifests'), { recursive: true });
            const failurePath = join(root, '.project', 'tmp', 'bundled-plugin-publication', 'failures.json');
            mkdirSync(dirname(failurePath), { recursive: true });
            writeFileSync(failurePath, '[]');
            const admitted = loadCurrentBundledPluginLocatorResult();
            expect(admitted.loadedPlugins.some((plugin) => plugin.pluginId === 'happier.agent.codex')).toBe(true);
            writeFileSync(join(root, 'package.json'), JSON.stringify({ happier: { managedRuntimePublication: { v: 2 } } }));
            // A running binary's imported declarations and publication are one admitted graph;
            // a later file write cannot replace its reference catalog during installed discovery.
            expect(loadCurrentBundledPluginLocatorResult().loadedPlugins).toEqual(admitted.loadedPlugins);
        } finally {
            Object.defineProperty(process, 'execPath', execPathDescriptor);
            rmSync(root, { recursive: true, force: true });
        }
    });
    it.each([
        ['cliproxyapi', 'happier.provider.cliproxyapi'],
    ])('projects an isolated %s publication failure as load_error while keeping a healthy sibling', (packageId, pluginId) => {
        const failure = createBundledPluginPublicationFailure({
            repoRoot: '', packageName: `@happier-dev/plugins-${packageId}`, pluginId,
            error: new Error('plugin publication failed'),
        });
        const result = loadBundledPluginLocatorResult([locator()], [failure]);
        expect(projectBundledPluginCatalogEntries(result)).toEqual(expect.arrayContaining([
            expect.objectContaining({
                pluginId,
                enabled: false,
                manifest: null,
                compatibility: expect.objectContaining({ status: 'load_error' }),
                diagnostics: [failure.diagnostic],
            }),
            expect.objectContaining({
                pluginId: 'happier.provider.fixture', enabled: true,
                compatibility: expect.objectContaining({ status: 'compatible' }),
            }),
        ]));
    });
    it('reads ignored publication failures and keeps required host imports fatal during ingest', () => {
        const root = mkdtempSync(join(tmpdir(), 'happier-bundled-failures-'));
        const execPathDescriptor = Object.getOwnPropertyDescriptor(process, 'execPath')!;
        try {
            Object.defineProperty(process, 'execPath', { ...execPathDescriptor, value: join(root, 'happier') });
            writeFileSync(join(root, 'package.json'), '{}');
            expect(() => readCurrentBundledPluginPublicationFailures()).toThrow(/publication state is unknown/);
            const failurePath = join(root, '.project', 'tmp', 'bundled-plugin-publication', 'failures.json');
            mkdirSync(dirname(failurePath), { recursive: true });
            writeFileSync(failurePath, JSON.stringify([{
                packageName: '@happier-dev/plugins-inspector', pluginId: 'happier.inspector',
                diagnostic: { code: 'plugin_package_build_failed', message: 'broken optional package' },
            }]));
            expect(readCurrentBundledPluginPublicationFailures()).toEqual([
                expect.objectContaining({ pluginId: 'happier.inspector' }),
            ]);
            writeFileSync(failurePath, '[]\n');
            expect(readCurrentBundledPluginPublicationFailures()).toEqual([
                expect.objectContaining({ pluginId: 'happier.inspector' }),
            ]);
            const badManifest = { ...locator(), manifest: { id: 'invalid' } };
            expect(loadBundledPluginLocatorResult([badManifest]).pluginFailures).toHaveLength(1);
            expect(() => loadBundledPluginLocatorResult([{
                ...badManifest,
                pluginId: 'happier.agent.codex',
                sourceSpec: { ...badManifest.sourceSpec, locator: '@happier-dev/plugins-codex' },
            }])).toThrow(/required by host code/);
        } finally {
            Object.defineProperty(process, 'execPath', execPathDescriptor);
            rmSync(root, { recursive: true, force: true });
        }
    });
    it('reads publication metadata beside the native executable and fails closed on invalid metadata', () => {
        const root = mkdtempSync(join(tmpdir(), 'happier-native-plugin-metadata-'));
        const execPathDescriptor = Object.getOwnPropertyDescriptor(process, 'execPath')!;
        try {
            Object.defineProperty(process, 'execPath', { ...execPathDescriptor, value: join(root, 'happier') });
            writeFileSync(join(root, 'package.json'), JSON.stringify({
                happier: { managedRuntimePublication: { v: 2 } },
            }));
            expect(() => loadBundledPluginLocators([locator()])).toThrow(
                /Invalid CLI managed runtime publication metadata/,
            );
            writeFileSync(join(root, 'package.json'), JSON.stringify({
                happier: { managedRuntimePublication: { v: 1, mode: 'complete', unavailableProviderRefs: [] } },
            }));
            expect(loadBundledPluginLocators([locator()])[0]?.pluginId).toBe('happier.provider.fixture');
        } finally {
            Object.defineProperty(process, 'execPath', execPathDescriptor);
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('loads declarative plugins without manufacturing daemon activation targets', () => {
        expect(loadBundledPluginLocators([locator()])).toEqual([
            expect.objectContaining({
                pluginId: 'happier.provider.fixture',
                daemonEntryPath: null,
                sourceSpec: expect.objectContaining({ kind: 'bundled' }),
            }),
        ]);
    });

    it('loads bundled target schemas from the canonical manifest without semantic sidecars', () => {
        const target = definePlugin({
            id: 'happier.provider.fixture',
            version: '1.0.0',
            contributionPoints: {
                providers: defineContributionProtocol({
                    id: 'fixture-provider',
                    version: 1,
                    operations: {
                        connect: {
                            required: true,
                            input: { kind: 'contributorDefined' },
                            resultSchema: defineProtocolObject({}, { policy: 'closed' }),
                            action: { surfaces: ['plugin'], dangerLevel: 'safe' },
                        },
                    },
                }).point(),
            },
        });

        const [loaded] = loadBundledPluginLocators([locator({
            manifest: target.manifest,
        })]);

        expect(Object.getOwnPropertySymbols(target.manifest.contributes.pluginContributionPoints)).toEqual([]);
        expect(loaded?.manifest.contributes.pluginContributionPoints[0]).not.toHaveProperty('semanticCarrier');
        expect(JSON.stringify(loaded?.manifest)).not.toContain('semanticCarrier');
        expect(loaded).not.toHaveProperty('semanticPointRefs');
    });

    it('loads every generated bundled target contribution point as canonical data only', () => {
        const targetLocators = BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS.filter((candidate) => {
            const manifest = readBundledPluginManifest(candidate) as {
                contributes?: { pluginContributionPoints?: readonly { id: string }[] };
            };
            return (manifest.contributes?.pluginContributionPoints?.length ?? 0) > 0;
        });

        expect(targetLocators.length).toBeGreaterThan(0);

        for (const candidate of targetLocators) {
            const manifest = readBundledPluginManifest(candidate) as {
                contributes: { pluginContributionPoints: readonly { id: string }[] };
            };
            const [loaded] = loadBundledPluginLocators([candidate]);
            const declaredPointIds = new Set(
                manifest.contributes.pluginContributionPoints.map((point) => point.id),
            );
            const loadedPointIds = new Set(
                loaded?.manifest.contributes.pluginContributionPoints.map((point) => point.id) ?? [],
            );

            expect(loadedPointIds, candidate.pluginId).toEqual(declaredPointIds);
            expect(loaded, candidate.pluginId).not.toHaveProperty('semanticPointRefs');
        }
    });

    it('rejects a locator whose daemon binding disagrees with the ingested manifest', () => {
        expect(() => loadBundledPluginLocators([
            locator({ daemonEntryPath: '@happier-dev/plugins-fixture' }),
        ])).toThrow(/daemon locator does not match its manifest entrypoint/);
    });

    it('rejects duplicate plugin owners before projection', () => {
        expect(() => loadBundledPluginLocators([locator(), locator()])).toThrow(
            /Duplicate bundled plugin locator/,
        );
    });

    it('removes only the source-only artifact managed facet while retaining external provider parity', () => {
        const providerLocator = locator({
            manifest: {
                schemaVersion: 2,
                id: 'happier.provider.fixture',
                version: '1.0.0',
                displayName: 'Fixture',
                engines: { happier: '^1.0.0' }, runtime: { apiVersion: 1 },
                hostAccess: { required: [], optional: [] },
                contributes: {
                    providers: [{
                        id: 'fixture',
                        name: 'Fixture provider',
                        kind: 'aggregator',
                        endpointTemplates: [],
                        managedRuntime: { kind: 'managed', endpointTemplateIds: [] },
                    }],
                },
            },
        });
        const key = 'happier.provider.fixture\u0000fixture';
        const unmatched = new Set([key]);
        const projected = projectManagedRuntimePublicationManifest(
            providerLocator,
            new Set([key]),
            unmatched,
        ) as { contributes: { providers: readonly Record<string, unknown>[] } };

        expect(projected.contributes.providers).toEqual([
            expect.objectContaining({ id: 'fixture', name: 'Fixture provider', kind: 'aggregator' }),
        ]);
        expect(projected.contributes.providers[0]).not.toHaveProperty('managedRuntime');
        expect(unmatched).toEqual(new Set());
        expect(projectManagedRuntimePublicationManifest(providerLocator, new Set(), new Set()))
            .toBe(readBundledPluginManifest(providerLocator));
    });

    it.each([
        ['happier.voice.openai', '@happier-dev/plugins-openai'],
        ['happier.voice.elevenlabs', null],
    ])('keeps the %s manifest and generated daemon locator aligned', (
        pluginId,
        daemonEntryPath,
    ) => {
        const locator = BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS.find(
            (candidate) => candidate.pluginId === pluginId,
        );

        expect(locator).toBeDefined();
        expect(loadBundledPluginLocators([locator!])).toEqual([
            expect.objectContaining({
                pluginId,
                daemonEntryPath,
            }),
        ]);
    });

    // The four forge plugins are activated under the `happier.scm.forge.*`
    // identity. The bundled locator table is generated from their manifests, so
    // a source-only id change would leave the daemon resolving an id no
    // manifest owns; asserting both halves here catches that split directly.
    it.each([
        'happier.scm.forge.github',
        'happier.scm.forge.gitlab',
        'happier.scm.forge.bitbucket',
        'happier.scm.forge.azure-devops',
    ])('activates %s under its forge identity', (pluginId) => {
        const locator = BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS.find(
            (candidate) => candidate.pluginId === pluginId,
        );

        expect(locator).toBeDefined();
        expect(readBundledPluginManifest(locator!)).toMatchObject({ id: pluginId });
        expect(loadBundledPluginLocators([locator!])).toEqual([
            expect.objectContaining({ pluginId }),
        ]);
    });

    it('retains no forge locator under the retired hosting identity', () => {
        expect(
            BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS
                .filter((candidate) => candidate.pluginId.startsWith('happier.scm.hosting.'))
                .map((candidate) => candidate.pluginId),
        ).toEqual([]);
    });

    it('gives every bundled ACP Agent that passes MCP through a tool delivery the host actually builds', () => {
        // `runHostSessionRuntime` builds a session's MCP servers only when the
        // Agent's `tools.delivery` is `native_mcp`. An Agent whose runtime
        // declares `mcp: { policy: 'pass_through' }` under any other delivery
        // forwards an empty set and advertises tools it never receives — the
        // exact defect Kimi shipped while declaring `shell_bridge`.
        //
        // `projectAgent` flattens the authored `declaration` wrapper away, so a
        // manifest contribution carries `runtime`/`capabilities` directly. Reading
        // a `declaration` here would make every branch below unreachable and the
        // assertion vacuously true.
        type BundledAgentContribution = Readonly<{
            id?: unknown;
            runtime?: Readonly<{
                kind?: unknown;
                definition?: Readonly<{ mcp?: Readonly<{ policy?: unknown }> }>;
            }>;
            capabilities?: Readonly<{ tools?: Readonly<{ delivery?: unknown }> }>;
        }>;

        const agentContributions = BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS.flatMap((locator) => {
            const manifest = readBundledPluginManifest(locator) as Readonly<{
                contributes?: Readonly<{ agents?: readonly BundledAgentContribution[] }>;
            }>;
            return (manifest.contributes?.agents ?? []).map((agent) => ({ locator, agent }));
        });

        // Guards the reachability of the check itself: bundled Agents exist and at
        // least one of them is a declarative ACP Agent to inspect.
        expect(agentContributions.length).toBeGreaterThan(0);
        expect(
            agentContributions.filter(({ agent }) => agent.runtime?.kind === 'acp').length,
        ).toBeGreaterThan(0);

        const inertPassThroughAgents = agentContributions.flatMap(({ locator, agent }) => {
            if (agent.runtime?.kind !== 'acp') return [];
            if (agent.runtime.definition?.mcp?.policy !== 'pass_through') return [];
            const delivery = agent.capabilities?.tools?.delivery;
            if (delivery === 'native_mcp') return [];
            return [`${locator.pluginId}/${String(agent.id)}:${String(delivery)}`];
        });

        expect(inertPassThroughAgents).toEqual([]);
    });

});
