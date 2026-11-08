import { expect, it } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol';

import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { createCommittedContributedActionInvoker } from '../invocation/actions/createCommittedContributedActionDeps';
import { loadInstalledPlugins } from '@/plugins/discovery/load/installed';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { projectLoadedPluginContributes } from '@/plugins/projection/registry/fullProjection';
import { readInstalledPluginCatalogSnapshot } from '@/plugins/projection/catalog/installed';
import { joinInstalledCatalogRuntimeIntrospection } from '@/plugins/projection/introspection/catalogSnapshot';
import { resolveExecutablePluginRuntimeRegistry } from '../resolveExecutablePluginRuntimeRegistry';
import type { ResolvedExecutablePluginRuntimeRegistry } from '../resolveExecutablePluginRuntimeRegistry';
import { createPluginReloadController } from './controller';

const ids = ['acme.broken', 'acme.dependent', 'acme.transitive', 'acme.healthy', 'acme.declarative'];

// Real immutable source admission, native module loading, activation and publication.
// Browser Actions supply manifest-owned cross-plugin references, including a two-hop chain.
it.each(['initial adoption', 'recovery from a withdrawn census', 'cold initialization'] as const)(
    'keeps healthy plugins serving during %s while failed dependencies remain typed unavailable',
    async (scenario) => {
        const controller = createPluginReloadController({
            resolveRuntimeRegistry: async () => resolveExecutablePluginRuntimeRegistry({
                contributes: createResolvedContributionRegistry({}), pluginIds: [],
            }),
        });
        if (scenario === 'recovery from a withdrawn census') {
            const withdrawn = await controller.acquireRuntimeRegistry();
            expect(withdrawn.registry.activatedPluginIds.size).toBe(0);
            await withdrawn.release();
        }
        let fixture: Awaited<ReturnType<typeof createAuthoredAdmittedPluginRuntimeFixture>> | undefined;
        let coldController: ReturnType<typeof createPluginReloadController> | undefined;
        try {
            fixture = await createAuthoredAdmittedPluginRuntimeFixture({
                controller,
                plugins: ids.map((id, index) => ({
                    manifest: createPluginManifestV2Fixture({
                        id,
                        ...(index === 4 ? { entrypoints: {} } : {}),
                        contributes: {
                            ...(index === 4 ? {} : { actions: [{ id: 'read', title: 'Read', scopes: ['global'], surfaces: ['cli'],
                                execution: { target: 'daemon' }, placementBindings: ['commandPalette'], dangerLevel: 'safe' }] }),
                            ...(index === 1 || index === 2 || index === 4 ? {
                                browserTargets: [{ id: 'target', title: 'Target', url: 'https://example.test' }],
                                browserActions: [{ id: 'launch', title: 'Launch', target: 'target',
                                    action: { pluginId: ids[index === 4 ? 0 : index - 1], localId: 'read' } }],
                            } : {}),
                        },
                    }),
                    files: index === 4 ? {} : { 'daemon.mjs': index === 0
                        ? 'export function activate() { throw new Error("fixture activation failed"); }'
                        : 'export function activate(api) { api.actions.register("read", async () => ({ healthy: true })); }' },
                })),
                resolveContributes: async (happyHomeDir) => createResolvedContributionRegistry(projectLoadedPluginContributes({
                    loadResult: await loadInstalledPlugins({ happyHomeDir }), provenance: 'external',
                    referenceGraph: { loadedPlugins: [], diagnosticsByPluginId: {} },
                })),
            });
            let registry: ResolvedExecutablePluginRuntimeRegistry = fixture.registry;
            if (scenario === 'cold initialization') {
                const candidate = await resolveExecutablePluginRuntimeRegistry({
                    happyHomeDir: fixture.happyHomeDir, contributes: registry.contributes,
                    generationAuthority: fixture.committed, pluginIds: ids,
                });
                coldController = createPluginReloadController({ resolveRuntimeRegistry: async () => candidate });
                const cold = await coldController.acquireRuntimeRegistry();
                registry = cold.registry;
                await cold.release();
            }
            expect(controller.getState().lastResult).toMatchObject({ ok: true, registryStatus: 'active' });
            expect([...registry.activatedPluginIds]).toEqual(['acme.healthy']);
            for (const pluginId of ids.slice(0, 3)) {
                const code = pluginId === 'acme.broken' ? 'plugin_activation_failed' : 'plugin_manifest_invalid';
                expect(registry.pluginDiagnosticsByPluginId[pluginId]).toEqual(expect.arrayContaining([
                    expect.objectContaining({ code }),
                ]));
                expect(registry.targetActivationFacts?.find(fact => fact.pluginId === pluginId))
                    .toMatchObject({ status: 'unavailable', bound: [], diagnostics: expect.arrayContaining([
                        expect.objectContaining({ code }),
                    ]) });
            }
            expect(registry.pluginDiagnosticsByPluginId['acme.dependent']).toEqual(expect.arrayContaining([
                expect.objectContaining({ details: expect.objectContaining({
                    blockingPlugins: [{ pluginId: 'acme.broken', codes: ['plugin_activation_failed'] }],
                }) }),
            ]));
            expect(registry.pluginDiagnosticsByPluginId['acme.declarative']).toEqual(expect.arrayContaining([
                expect.objectContaining({ code: 'plugin_manifest_invalid', stage: 'normalization' }),
            ]));
            expect(registry.targetActivationFacts?.find(fact => fact.pluginId === 'acme.declarative')).toBeUndefined();
            const catalog = joinInstalledCatalogRuntimeIntrospection(
                (await readInstalledPluginCatalogSnapshot({ happyHomeDir: fixture.happyHomeDir })).entries, registry,
            );
            for (const pluginId of ['acme.dependent', 'acme.transitive', 'acme.declarative']) {
                expect(catalog.find(entry => entry.pluginId === pluginId))
                    .toMatchObject({ enabled: false, compatibility: { status: 'load_error' } });
            }
            expect(registry.targetActivationFacts?.find(fact => fact.pluginId === 'acme.healthy'))
                .toMatchObject({ status: 'active' });
            const executor = createActionExecutor({
                ...createUnavailableActionTransportDeps(),
                invokeContributedAction: createCommittedContributedActionInvoker({
                    acquireRuntimeRegistryLease: async () => ({ registry, source: 'ephemeral', durableRevision: -1, release: async () => {} }),
                }),
            });
            expect(await executor.execute('action.invoke', {
                action: { pluginId: 'acme.healthy', localId: 'read' }, input: {},
            }, { surface: 'cli' })).toMatchObject({ ok: true, result: { healthy: true } });
            expect(await executor.execute('action.invoke', {
                action: { pluginId: 'acme.transitive', localId: 'read' }, input: {},
            }, { surface: 'cli' })).toMatchObject({ ok: false });
        } finally {
            await coldController?.shutdown();
            await fixture?.dispose();
            await controller.shutdown();
        }
    },
);
