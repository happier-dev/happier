import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { builtinModules, createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'vite';

import { describe, expect, it, vi } from 'vitest';
import { definePlugin } from '@happier-dev/plugin-sdk';
import { defineContributionProtocol } from '@happier-dev/plugin-sdk/contributions';
import { defineProtocolObject } from '@happier-dev/plugin-sdk/protocol';
import { createBundledPluginPublicationFailure } from '../../../../../../../scripts/workspaces/bundledPluginPublicationFailure.mjs';
import { projectBundledPluginCatalogEntries } from '@/plugins/projection/catalog/installed';

import { BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS } from '../sources/generatedBundledPluginManifests';
import {
    loadBundledPluginLocatorResult,
    loadBundledPluginLocators,
    readCurrentBundledPluginPublicationFailures,
    projectManagedRuntimePublicationManifest,
    type BundledPluginLocator,
} from './locators';

const requireFromTest = createRequire(import.meta.url);

function readSerializedBundledPluginManifest(packageName: string): unknown {
    const manifestEntrypoint = requireFromTest.resolve(`${packageName}/manifest`);
    const packageRoot = dirname(dirname(manifestEntrypoint));
    return JSON.parse(readFileSync(
        join(packageRoot, '.happier-plugin', 'plugin.json'),
        'utf8',
    )) as unknown;
}

function locator(overrides: Partial<BundledPluginLocator> = {}): BundledPluginLocator {
    return {
        pluginId: 'happier.provider.fixture',
        manifest: {
            schemaVersion: 2,
            id: 'happier.provider.fixture',
            version: '1.0.0',
            displayName: 'Fixture',
            engines: { happier: '^1.0.0' }, runtime: { apiVersion: 1 },
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
    it('admits distribution failures for compiled modules in a source checkout', async () => {
        const root = mkdtempSync(join(tmpdir(), 'happier-compiled-source-catalog-'));
        const projectRoot = join(root, 'apps', 'cli');
        const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../../..');
        try {
            mkdirSync(join(projectRoot, 'src'), { recursive: true });
            writeFileSync(join(projectRoot, 'package.json'), '{}');
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
        const execPathDescriptor = Object.getOwnPropertyDescriptor(process, 'execPath')!;
        try {
            // The filesystem/process identity is the boundary. The executing
            // module remains source, and semantic ingestion stays real.
            Object.defineProperty(process, 'execPath', { ...execPathDescriptor, value: join(root, 'happier') });
            writeFileSync(join(root, 'package.json'), '{}');
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
        const execPathDescriptor = Object.getOwnPropertyDescriptor(process, 'execPath')!;
        try {
            Object.defineProperty(process, 'execPath', { ...execPathDescriptor, value: join(root, 'happier') });
            writeFileSync(join(root, 'package.json'), '{}');
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
                pluginRootPath: '@happier-dev/plugins-fixture',
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
            const manifest = candidate.manifest as {
                contributes?: { pluginContributionPoints?: readonly { id: string }[] };
            };
            return (manifest.contributes?.pluginContributionPoints?.length ?? 0) > 0;
        });

        expect(targetLocators.length).toBeGreaterThan(0);

        for (const candidate of targetLocators) {
            const manifest = candidate.manifest as {
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
            .toBe(providerLocator.manifest);
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
        expect(locator!.manifest).toMatchObject({ id: pluginId });
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

    it('projects generated and serialized Claude manifests identically through strict bundled intake', () => {
        const claudeLocator = BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS.find(
            (candidate) => candidate.pluginId === 'happier.agent.claude',
        );

        expect(claudeLocator).toBeDefined();
        const [generated] = loadBundledPluginLocators([claudeLocator!]);
        const [serialized] = loadBundledPluginLocators([{
            ...claudeLocator!,
            manifest: readSerializedBundledPluginManifest(claudeLocator!.sourceSpec.locator),
        }]);

        expect(serialized).toBeDefined();
        expect(generated).toMatchObject({
            pluginId: serialized!.pluginId,
            daemonEntryPath: serialized!.daemonEntryPath,
            manifest: serialized!.manifest,
            sourceSpec: serialized!.sourceSpec,
        });
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
            const manifest = locator.manifest as Readonly<{
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
