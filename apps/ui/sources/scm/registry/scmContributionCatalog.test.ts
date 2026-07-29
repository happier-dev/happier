import type { PluginProjectionV2 } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import { createScmBackendSettingsRegistry } from '@/scm/settings/scmBackendSettingsRegistry';
import { createScmContributionCatalog } from './scmContributionCatalog';
import { createScmUiBackendRegistry } from './scmUiBackendRegistry';

function projectionWithScmFamilies(params: Readonly<{
    generation: number;
    backends?: Record<string, Readonly<{ id: string } & Record<string, unknown>>>;
    hostingProviders?: Record<string, Readonly<{ id: string } & Record<string, unknown>>>;
    connectedAccounts?: Record<string, Readonly<{ id: string } & Record<string, unknown>>>;
}>): PluginProjectionV2 {
    return {
        v: 2,
        generation: params.generation,
        installedPackagesById: {},
        agentsById: {},
        backendsById: {},
        actionsById: {},
        toolsById: {},
        commandsById: {},
        resourcesById: {},
        settingsById: {},
        familiesById: {
            scmBackends: {
                family: 'scmBackends',
                entriesById: params.backends ?? {},
            },
            scmHostingProviders: {
                family: 'scmHostingProviders',
                entriesById: params.hostingProviders ?? {},
            },
            connectedAccounts: {
                family: 'connectedAccounts',
                entriesById: params.connectedAccounts ?? {},
            },
        },
        diagnostics: [],
    } as unknown as PluginProjectionV2;
}

describe('SCM daemon contribution catalog', () => {
    it('uses projected packed backend and hosting-provider identities as the client registry authority', () => {
        const catalog = createScmContributionCatalog(projectionWithScmFamilies({
            generation: 7,
            backends: {
                'acme.scm/stacked': {
                    id: 'acme.scm/stacked',
                    localId: 'stacked',
                    pluginId: 'acme.scm',
                    title: { key: 'acme.scm.stacked.title', fallback: 'Acme Stacked SCM' },
                    displayName: 'Acme Stacked SCM',
                    description: 'Packed stacked-change backend',
                    kind: 'acme-stacked',
                    capabilities: ['detect', 'status', 'diff', 'commit', 'push'],
                },
            },
            hostingProviders: {
                'acme.scm/forge-cloud': {
                    id: 'acme.scm/forge-cloud',
                    localId: 'forge-cloud',
                    pluginId: 'acme.scm',
                    displayName: 'Acme Forge Cloud',
                    kind: 'acme-forge',
                    authService: { pluginId: 'acme.scm', localId: 'acme-forge-auth' },
                    capabilities: { pullRequests: { list: true, get: true, create: true } },
                },
                'acme.scm/forge-enterprise': {
                    id: 'acme.scm/forge-enterprise',
                    localId: 'forge-enterprise',
                    pluginId: 'acme.scm',
                    displayName: 'Acme Forge Enterprise',
                    kind: 'acme-forge',
                    authService: { pluginId: 'acme.scm', localId: 'acme-forge-auth' },
                    capabilities: { pullRequests: { list: true, get: true, create: true } },
                },
            },
            connectedAccounts: {
                'acme.scm/acme-forge-auth': {
                    id: 'acme-forge-auth',
                    serviceId: 'forge-cloud',
                    pluginId: 'acme.scm',
                    provenance: 'external',
                    sourceKind: 'packed',
                    title: 'Acme Forge account',
                    auth: {
                        kind: 'manual',
                        fields: [{ id: 'token', title: 'Token', secret: true }],
                    },
                    capabilities: ['scmHostingToken'],
                    availability: { state: 'available', reason: 'resolved' },
                    diagnostics: [],
                },
            },
        }));

        expect(catalog.source).toBe('daemon');
        expect(catalog.generation).toBe(7);
        expect(catalog.backends).toEqual([
            expect.objectContaining({ id: 'acme.scm/stacked', title: 'Acme Stacked SCM' }),
        ]);
        expect(catalog.hostingProviders).toEqual([
            expect.objectContaining({
                id: 'acme.scm/forge-cloud',
                title: 'Acme Forge Cloud',
                authService: { pluginId: 'acme.scm', localId: 'acme-forge-auth' },
            }),
            expect.objectContaining({
                id: 'acme.scm/forge-enterprise',
                title: 'Acme Forge Enterprise',
                authService: { pluginId: 'acme.scm', localId: 'acme-forge-auth' },
            }),
        ]);

        const uiRegistry = createScmUiBackendRegistry(catalog);
        expect(uiRegistry.getPlugin('acme.scm/stacked')).toEqual(
            expect.objectContaining({ id: 'acme.scm/stacked', displayName: 'Acme Stacked SCM' }),
        );

        const settingsRegistry = createScmBackendSettingsRegistry(catalog);
        expect(settingsRegistry.listPlugins()).toEqual([
            expect.objectContaining({ backendId: 'acme.scm/stacked', title: 'Acme Stacked SCM' }),
        ]);
        expect(settingsRegistry.listHostingProviders()).toEqual([
            expect.objectContaining({
                providerId: 'acme.scm/forge-cloud',
                serviceId: 'forge-cloud',
                authService: { pluginId: 'acme.scm', localId: 'acme-forge-auth' },
            }),
            expect.objectContaining({
                providerId: 'acme.scm/forge-enterprise',
                serviceId: 'forge-cloud',
                authService: { pluginId: 'acme.scm', localId: 'acme-forge-auth' },
            }),
        ]);
    });

    it('removes packed contributions when the authoritative next generation omits them', () => {
        const installed = createScmContributionCatalog(projectionWithScmFamilies({
            generation: 8,
            backends: {
                'acme.scm/stacked': {
                    id: 'acme.scm/stacked',
                    pluginId: 'acme.scm',
                    title: 'Acme Stacked SCM',
                },
            },
        }));
        const uninstalled = createScmContributionCatalog(projectionWithScmFamilies({ generation: 9 }));

        expect(createScmBackendSettingsRegistry(installed).getPlugin('acme.scm/stacked')).not.toBeNull();
        expect(createScmBackendSettingsRegistry(uninstalled).getPlugin('acme.scm/stacked')).toBeNull();
        expect(createScmUiBackendRegistry(uninstalled).listPlugins()).toEqual([]);
    });

    it('does not guess a connected-service route when the referenced account is not projected', () => {
        const catalog = createScmContributionCatalog(projectionWithScmFamilies({
            generation: 8,
            hostingProviders: {
                'acme.scm/forge': {
                    id: 'acme.scm/forge',
                    localId: 'forge',
                    pluginId: 'acme.scm',
                    displayName: 'Acme Forge',
                    authService: { pluginId: 'acme.scm', localId: 'forge-account' },
                },
            },
        }));

        expect(createScmBackendSettingsRegistry(catalog).listHostingProviders()).toEqual([
            expect.objectContaining({
                providerId: 'acme.scm/forge',
                serviceId: null,
            }),
        ]);
    });

    it('does not grant a packed same-local-id backend a first-party leaf UI policy', () => {
        const catalog = createScmContributionCatalog(projectionWithScmFamilies({
            generation: 9,
            backends: {
                'acme.scm/git': {
                    id: 'acme.scm/git',
                    localId: 'git',
                    pluginId: 'acme.scm',
                    displayName: 'Acme Git-shaped SCM',
                    kind: 'acme',
                    capabilities: ['detect', 'status'],
                },
            },
        }));

        expect(
            createScmUiBackendRegistry(catalog)
                .getPlugin('acme.scm/git')
                .diffModeConfig(null)
                .availableModes,
        ).toEqual(['pending']);
    });

    it('uses the built-in compatibility inventory only when an older daemon lacks the SCM family', () => {
        const legacy = createScmContributionCatalog(null);
        const authoritativeEmpty = createScmContributionCatalog(projectionWithScmFamilies({ generation: 1 }));

        expect(legacy.source).toBe('legacy');
        expect(legacy.backends.map((backend) => backend.id)).toEqual(['git', 'sapling']);
        expect(authoritativeEmpty.backends).toEqual([]);
    });
});
