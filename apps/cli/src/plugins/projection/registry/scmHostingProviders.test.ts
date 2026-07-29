import { describe, expect, it } from 'vitest';

import {
    buildQualifiedPluginContributionKey,
    createPluginContributionIdentity,
} from '@happier-dev/protocol';

import { buildPluginProjectionV2 } from './projection/v2';
import { buildPluginContributionRegistry } from './normalize/package';
import { createResolvedContributionRegistry } from './createResolvedContributionRegistry';
import type { ResolvedContributionRegistry } from './types';
import { readCanonicalPluginManifest } from '@/plugins/manifest/normalize';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';

const sourceSpec = {
    kind: 'path' as const,
    locator: '/plugins/acme-scm',
    trustPolicy: 'local_trusted' as const,
    installPolicy: 'link' as const,
};

function createEmptyRegistry(overrides: Partial<ResolvedContributionRegistry> = {}): ResolvedContributionRegistry {
    return {
        agents: [],
                actions: [],
        tools: [],
        commands: [],
        resources: [],
        activationTargets: [],
        actionsById: new Map(),
        toolsById: new Map(),
        commandsById: new Map(),
        resourcesById: new Map(),
                catalogEntriesById: {},
        agentDefinitionsById: new Map(),
                pluginDiagnosticsByPluginId: {},
        ...overrides,
    } as ResolvedContributionRegistry;
}

describe('SCM hosting-provider plugin contributions', () => {
    it('projects current runtime-v2 operation arrays without throwing in the full projection', () => {
        const registry = createEmptyRegistry({
            scmHostingProviders: [{
                id: 'bitbucket',
                provenance: 'first_party',
                source: { kind: 'bundled' },
                pluginId: 'happier.scm.hosting.bitbucket',
                definition: {
                    id: 'bitbucket',
                    title: 'Bitbucket',
                    kind: 'bitbucket',
                    capabilities: ['detect', 'clone', 'fetch', 'push', 'pullRequest'],
                    authService: 'bitbucket-account',
                },
            }],
        });

        const projection = buildPluginProjectionV2({ registry, generation: 3 });

        expect(projection.familiesById.scmHostingProviders?.entriesById['happier.scm.hosting.bitbucket/bitbucket']).toEqual(
            expect.objectContaining({
                id: 'happier.scm.hosting.bitbucket/bitbucket',
                localId: 'bitbucket',
                displayName: 'Bitbucket',
                capabilities: expect.objectContaining({
                    pullRequests: expect.objectContaining({ list: true, get: true, create: true }),
                }),
            }),
        );
    });
    it('flattens non-agent manifest descriptors without requiring provider or backend contributes', () => {
        const registry = buildPluginContributionRegistry({
            loadedPlugins: [
                {
                    pluginId: 'acme.scm',
                    pluginRootPath: '/plugins/acme-scm',
                    manifestPath: '/plugins/acme-scm/.happier-plugin/plugin.json',
                    manifestDigest: 'sha256:acme',
                    daemonEntryPath: null,
                    sourceSpec,
                    devDaemonEntryPath: null,
                    manifest: readCanonicalPluginManifest(createPluginManifestV2Fixture({
                        schemaVersion: 2,
                        id: 'acme.scm',
                        version: '1.0.0',
                        displayName: 'Acme SCM',
                        engines: {
                            happier: '^0.2.0',
                        },
                        entrypoints: { daemon: './daemon.js' },
                        contributes: {
                            agents: [],
                            actions: [],
                            tools: [],
                            commands: [],
                            resources: [],
                            scmHostingProviders: [
                                {
                                    id: 'github',
                                    kind: 'github',
                                    title: 'Acme GitHub',
                                    capabilities: ['detect', 'pullRequest'],
                                },
                            ],
                            hooks: [],
                        },
                    }))!,
                },
            ],
        });

        expect(registry.scmHostingProviders).toEqual([
            expect.objectContaining({
                pluginId: 'acme.scm',
                identity: {
                    pluginId: 'acme.scm',
                    localId: 'github',
                },
                definition: expect.objectContaining({
                    id: 'github',
                    kind: 'github',
                }),
            }),
        ]);
        expect(registry.agents).toEqual([]);
    });

    it('keeps same-local-id providers from distinct plugin namespaces addressable', () => {
        const registry = createResolvedContributionRegistry({
            agents: [],
                        scmHostingProviders: [
                {
                    id: 'shared',
                    provenance: 'external',
                    source: { kind: 'path' },
                    pluginId: 'acme.scm.one',
                    definition: {
                        id: 'shared',
                        kind: 'github',
                        title: 'GitHub',
                        capabilities: ['detect', 'pullRequest'],
                    },
                },
                {
                    id: 'shared',
                    provenance: 'external',
                    source: { kind: 'path' },
                    pluginId: 'acme.scm.two',
                    manifestPath: '/plugins/acme-shadow/.happier-plugin/plugin.json',
                    manifestDigest: 'sha256:shadow',
                    daemonEntryPath: null,
                    sourceSpec,
                    devDaemonEntryPath: null,
                    definition: {
                        id: 'shared',
                        kind: 'github',
                        title: 'Shadow GitHub',
                        capabilities: ['detect'],
                    },
                },
            ],
        });

        const firstKey = buildQualifiedPluginContributionKey(createPluginContributionIdentity({
            pluginId: 'acme.scm.one',
            localId: 'shared',
        }));
        const secondKey = buildQualifiedPluginContributionKey(createPluginContributionIdentity({
            pluginId: 'acme.scm.two',
            localId: 'shared',
        }));
        expect(registry.scmHostingProvidersById?.get(firstKey)?.pluginId).toBe('acme.scm.one');
        expect(registry.scmHostingProvidersById?.get(secondKey)?.pluginId).toBe('acme.scm.two');
        expect(registry.scmHostingProviders).toHaveLength(2);
        expect(registry.pluginDiagnosticsByPluginId['acme.scm.two']).toBeUndefined();
        const projection = buildPluginProjectionV2({ registry, generation: 9 });
        expect(Object.keys(projection.familiesById.scmHostingProviders?.entriesById ?? {})).toEqual([
            'acme.scm.one/shared',
            'acme.scm.two/shared',
        ]);
    });

    it('projects static descriptors through the sibling-owned projection family', () => {
        const registry = createEmptyRegistry({
            scmHostingProviders: [
                {
                    id: 'acme.scm.github',
                    provenance: 'external',
                    source: { kind: 'path' },
                    pluginId: 'acme.scm',
                    manifestPath: '/plugins/acme-scm/.happier-plugin/plugin.json',
                    manifestDigest: 'sha256:acme',
                    daemonEntryPath: null,
                    sourceSpec,
                    devDaemonEntryPath: null,
                    definition: {
                        id: 'acme.scm.github',
                        kind: 'github',
                        title: 'Acme GitHub',
                        capabilities: ['detect', 'pullRequest'],
                    },
                },
            ],
            scmHostingProvidersById: new Map(),
        });

        const projection = buildPluginProjectionV2({
            registry,
            generation: 3,
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
    });

    it('projects bundled first-party SCM hosting providers without agent or backend contributions', () => {
        const registry = createEmptyRegistry({
            agents: [],
                        scmHostingProviders: [
                {
                    id: 'scm.github',
                    provenance: 'first_party',
                    source: { kind: 'bundled' },
                    pluginId: 'happier.scm.hosting.github',
                    definition: {
                        id: 'scm.github',
                        kind: 'github',
                        title: 'GitHub',
                        capabilities: ['detect'],
                    },
                },
            ],
            scmHostingProvidersById: new Map(),
        });

        const projection = buildPluginProjectionV2({
            registry,
            generation: 4,
        });

        expect(registry.agents).toEqual([]);
        expect(projection.familiesById.scmHostingProviders?.entriesById['happier.scm.hosting.github/scm.github']).toEqual(
            expect.objectContaining({
                id: 'happier.scm.hosting.github/scm.github',
                localId: 'scm.github',
                pluginId: 'happier.scm.hosting.github',
                kind: 'github',
                displayName: 'GitHub',
                capabilities: expect.objectContaining({
                    compareUrl: false,
                    openUrl: false,
                }),
            }),
        );
    });

    it('projects only hosting providers backed by the current authoritative runtime lease with auth facts', () => {
        const registry = createEmptyRegistry({
            scmHostingProviders: [
                {
                    id: 'active',
                    provenance: 'external',
                    source: { kind: 'path' },
                    pluginId: 'acme.scm.hosting',
                    definition: {
                        id: 'active',
                        title: 'Acme Forge',
                        description: 'Active hosting provider',
                        kind: 'acme',
                        capabilities: ['detect', 'clone', 'pullRequest'],
                        authService: 'account',
                        metadata: { tier: 'enterprise' },
                    },
                },
                {
                    id: 'stale',
                    provenance: 'external',
                    source: { kind: 'path' },
                    pluginId: 'acme.scm.hosting',
                    definition: {
                        id: 'stale',
                        title: 'Stale Forge',
                        kind: 'acme',
                        capabilities: ['detect'],
                    },
                },
            ],
        });

        const projection = buildPluginProjectionV2({
            registry,
            generation: 12,
            scmRuntimeAvailability: {
                backendIds: new Set(),
                hostingProviderIds: new Set(['acme.scm.hosting/active']),
            },
        });

        expect(projection.familiesById.scmHostingProviders?.entriesById).toEqual({
            'acme.scm.hosting/active': expect.objectContaining({
                id: 'acme.scm.hosting/active',
                localId: 'active',
                pluginId: 'acme.scm.hosting',
                displayName: 'Acme Forge',
                description: 'Active hosting provider',
                operations: ['detect', 'clone', 'pullRequest'],
                authService: { pluginId: 'acme.scm.hosting', localId: 'account' },
                metadata: { tier: 'enterprise' },
            }),
        });
    });
});
