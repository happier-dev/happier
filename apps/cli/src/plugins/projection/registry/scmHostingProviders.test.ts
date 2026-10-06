import { describe, expect, it } from 'vitest';

import {
    buildQualifiedPluginContributionKey,
    createPluginContributionIdentity,
    type ScmHostingProviderContribution,
} from '@happier-dev/protocol';

import { buildPluginProjectionV2 } from './projection/v2';
import { buildPluginContributionRegistry } from './normalize/package';
import { readCanonicalPluginManifest } from '@/plugins/manifest/normalize';
import {
    createAdmittedPluginRuntimeFixture,
    createAuthoredAdmittedPluginRuntimeFixture,
} from '@/plugins/testkit/admittedRuntime';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';

const sourceSpec = {
    kind: 'path' as const,
    locator: '/plugins/acme-scm',
    trustPolicy: 'local_trusted' as const,
    installPolicy: 'link' as const,
};

function authoredHostingPlugin(
    pluginId: string,
    providers: readonly ScmHostingProviderContribution[],
) {
    return {
        manifest: createPluginManifestV2Fixture({
            id: pluginId,
            contributes: { scmHostingProviders: providers },
        }),
        files: {
            'daemon.mjs': `export function activate(api) {\n${providers.map((provider) => (
                `    api.scm.registerHostingProvider(${JSON.stringify(provider.id)}, { adapter: {} });`
            )).join('\n')}\n}\n`,
        },
    };
}

describe('SCM hosting-provider plugin contributions', () => {
    it('projects current runtime-v2 operation arrays without throwing in the full projection', async () => {
        const fixture = await createAdmittedPluginRuntimeFixture({
            runtimeOptions: { pluginIds: ['happier.scm.forge.bitbucket'] },
        });
        try {
            const projection = buildPluginProjectionV2({
                registry: fixture.registry.contributes,
                generation: fixture.controller.getState().generation,
            });

            expect(projection.familiesById.scmHostingProviders?.entriesById['happier.scm.forge.bitbucket/bitbucket']).toEqual(
                expect.objectContaining({
                    id: 'happier.scm.forge.bitbucket/bitbucket',
                    localId: 'bitbucket',
                    displayName: 'Bitbucket',
                    occurrenceId: fixture.registry.contributes.occurrenceIdsByPluginId?.['happier.scm.forge.bitbucket'],
                    operations: ['detect', 'clone', 'fetch', 'push', 'pullRequest'],
                    capabilities: expect.objectContaining({
                        pullRequests: expect.objectContaining({ list: true, get: true, create: true }),
                    }),
                }),
            );
        } finally {
            await fixture.dispose();
        }
    });

    it('flattens non-agent manifest descriptors without requiring provider or backend contributes', () => {
        const registry = buildPluginContributionRegistry({
            loadedPlugins: [{
                pluginId: 'acme.scm',
                pluginRootPath: '/plugins/acme-scm',
                manifestPath: '/plugins/acme-scm/.happier-plugin/plugin.json',
                daemonEntryPath: null,
                sourceSpec,
                devDaemonEntryPath: null,
                manifest: readCanonicalPluginManifest(createPluginManifestV2Fixture({
                    id: 'acme.scm',
                    displayName: 'Acme SCM',
                    contributes: {
                        scmHostingProviders: [{
                            id: 'github',
                            kind: 'github',
                            title: 'Acme GitHub',
                            capabilities: ['detect', 'pullRequest'],
                        }],
                    },
                }))!,
            }],
        });

        expect(registry.scmHostingProviders).toEqual([
            expect.objectContaining({
                pluginId: 'acme.scm',
                identity: { pluginId: 'acme.scm', localId: 'github' },
                definition: expect.objectContaining({ id: 'github', kind: 'github' }),
            }),
        ]);
        expect(registry.agents).toEqual([]);
    });

    it('keeps same-local-id providers from distinct plugin namespaces addressable', async () => {
        const fixture = await createAuthoredAdmittedPluginRuntimeFixture({
            plugins: [
                authoredHostingPlugin('acme.scm.one', [{
                    id: 'shared', kind: 'github', title: 'GitHub', capabilities: ['detect', 'pullRequest'],
                }]),
                authoredHostingPlugin('acme.scm.two', [{
                    id: 'shared', kind: 'github', title: 'Shadow GitHub', capabilities: ['detect'],
                }]),
            ],
        });
        try {
            const registry = fixture.registry.contributes;
            const firstKey = buildQualifiedPluginContributionKey(createPluginContributionIdentity({
                pluginId: 'acme.scm.one', localId: 'shared',
            }));
            const secondKey = buildQualifiedPluginContributionKey(createPluginContributionIdentity({
                pluginId: 'acme.scm.two', localId: 'shared',
            }));
            expect(registry.scmHostingProvidersById?.get(firstKey)?.pluginId).toBe('acme.scm.one');
            expect(registry.scmHostingProvidersById?.get(secondKey)?.pluginId).toBe('acme.scm.two');
            expect(registry.pluginDiagnosticsByPluginId['acme.scm.two']).toBeUndefined();
            const projection = buildPluginProjectionV2({
                registry, generation: fixture.controller.getState().generation,
            });
            expect(Object.keys(projection.familiesById.scmHostingProviders?.entriesById ?? {})).toEqual([
                firstKey, secondKey,
            ]);
        } finally {
            await fixture.dispose();
        }
    });

    it('projects admitted static descriptors through the sibling-owned projection family', async () => {
        const fixture = await createAuthoredAdmittedPluginRuntimeFixture({
            plugins: [authoredHostingPlugin('acme.scm', [{
                id: 'acme.scm.github', kind: 'github', title: 'Acme GitHub', capabilities: ['detect', 'pullRequest'],
            }])],
        });
        try {
            const projection = buildPluginProjectionV2({
                registry: fixture.registry.contributes,
                generation: fixture.controller.getState().generation,
            });

            expect(projection.familiesById.scmHostingProviders?.entriesById['acme.scm/acme.scm.github']).toEqual(
                expect.objectContaining({
                    id: 'acme.scm/acme.scm.github',
                    localId: 'acme.scm.github',
                    pluginId: 'acme.scm',
                    kind: 'github',
                    displayName: 'Acme GitHub',
                    capabilities: expect.objectContaining({
                        pullRequests: expect.objectContaining({ list: true, get: true, create: true }),
                    }),
                }),
            );
        } finally {
            await fixture.dispose();
        }
    });

    it('projects bundled first-party SCM hosting providers without agent or backend contributions', async () => {
        const pluginId = 'happier.scm.forge.github';
        const fixture = await createAdmittedPluginRuntimeFixture({ runtimeOptions: { pluginIds: [pluginId] } });
        try {
            const registry = fixture.registry.contributes;
            expect(registry.agents.filter((agent) => agent.pluginId === pluginId)).toEqual([]);
            expect(registry.scmBackends?.filter((backend) => backend.pluginId === pluginId)).toEqual([]);
            expect(registry.scmHostingProvidersById?.get(pluginId + '/github')).toMatchObject({
                provenance: 'first_party', source: { kind: 'bundled' },
            });
            const projection = buildPluginProjectionV2({
                registry, generation: fixture.controller.getState().generation,
            });

            expect(projection.familiesById.scmHostingProviders?.entriesById[pluginId + '/github']).toEqual(
                expect.objectContaining({
                    id: pluginId + '/github',
                    localId: 'github',
                    pluginId,
                    kind: 'github',
                    displayName: 'GitHub',
                    capabilities: expect.objectContaining({ compareUrl: false, openUrl: false }),
                }),
            );
        } finally {
            await fixture.dispose();
        }
    });

    it('projects only hosting providers backed by the current authoritative runtime lease with auth facts', async () => {
        const pluginId = 'acme.scm.hosting';
        const fixture = await createAuthoredAdmittedPluginRuntimeFixture({
            plugins: [authoredHostingPlugin(pluginId, [
                {
                    id: 'active',
                    title: 'Acme Forge',
                    description: 'Active hosting provider',
                    kind: 'acme',
                    capabilities: ['detect', 'clone', 'pullRequest'],
                    authService: 'account',
                    metadata: { tier: 'enterprise' },
                },
            ]), authoredHostingPlugin('acme.scm.dormant', [
                { id: 'stale', title: 'Stale Forge', kind: 'acme', capabilities: ['detect'] },
            ])],
        });
        try {
            const runtime = fixture.registry;
            if (!runtime.activatePluginsForValidation) throw new Error('Expected runtime activation owner');
            await runtime.activatePluginsForValidation([pluginId]);
            const active = runtime.scmHostingProvidersById.get(pluginId + '/active');
            expect(active).toBeDefined();
            expect(active && runtime.isPluginOccurrenceCurrent?.(pluginId, active.occurrenceId)).toBe(true);
            expect(fixture.controller.isRuntimeRegistryCurrent(runtime)).toBe(true);
            const projection = buildPluginProjectionV2({
                registry: runtime.contributes,
                generation: fixture.controller.getState().generation,
                scmRuntimeAvailability: {
                    backendIds: new Set(runtime.scmBackendsById?.keys()),
                    hostingProviderIds: new Set(runtime.scmHostingProvidersById.keys()),
                },
            });

            expect(projection.familiesById.scmHostingProviders?.entriesById).toEqual({
                'acme.scm.hosting/active': expect.objectContaining({
                    id: 'acme.scm.hosting/active',
                    localId: 'active',
                    pluginId,
                    occurrenceId: active?.occurrenceId,
                    displayName: 'Acme Forge',
                    description: 'Active hosting provider',
                    operations: ['detect', 'clone', 'pullRequest'],
                    authService: { pluginId, localId: 'account' },
                    metadata: { tier: 'enterprise' },
                }),
            });
        } finally {
            await fixture.dispose();
        }
    });
});
