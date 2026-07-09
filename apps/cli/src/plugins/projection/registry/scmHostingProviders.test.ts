import { describe, expect, it } from 'vitest';

import { buildPluginProjectionV2 } from './projection/v2';
import { buildPluginContributionRegistry } from './normalize/package';
import { createResolvedContributionRegistry } from './createResolvedContributionRegistry';
import type { ResolvedContributionRegistry } from './types';

const sourceSpec = {
    kind: 'path' as const,
    locator: '/plugins/acme-scm',
    trustPolicy: 'local_trusted' as const,
    installPolicy: 'link' as const,
};

function createEmptyRegistry(overrides: Partial<ResolvedContributionRegistry> = {}): ResolvedContributionRegistry {
    return {
        agents: [],
        agentRuntimes: [],
        actions: [],
        tools: [],
        commands: [],
        resources: [],
        uiDescriptors: [],
        activationTargets: [],
        hookRegistrations: [],
        lifecycleHandlers: [],
        actionsById: new Map(),
        toolsById: new Map(),
        commandsById: new Map(),
        resourcesById: new Map(),
        uiDescriptorsById: new Map(),
        lifecycleHandlersById: new Map(),
        surfaceHandlersByBackendId: new Map(),
        catalogEntriesById: {},
        agentDefinitionsById: new Map(),
        agentRuntimeDefinitionsById: new Map(),
        pluginDiagnosticsByPluginId: {},
        ...overrides,
    } as ResolvedContributionRegistry;
}

describe('SCM hosting-provider plugin contributions', () => {
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
                    manifest: {
                        schemaVersion: 2,
                        id: 'acme.scm',
                        version: '1.0.0',
                        displayName: 'Acme SCM',
                        engines: {
                            happier: '^0.2.0',
                        },
                        activationEvents: [],
                        uses: [],
                        entrypoints: { main: './daemon.js' },
                        permissions: [],
                        contributes: {
                            agents: [],
                            agentRuntimes: [],
                            actions: [],
                            tools: [],
                            commands: [],
                            resources: [],
                            uiDescriptors: [],
                            scmHostingProviders: [
                                {
                                    id: 'acme.scm.github',
                                    kind: 'github',
                                    displayName: 'Acme GitHub',
                                    baseUrl: 'https://github.example.com',
                                    remoteHostMatchers: {
                                        exactHosts: ['github.example.com'],
                                    },
                                    urlSafety: {
                                        allowedSchemes: ['https:'],
                                        allowedBaseUrls: ['https://github.example.com'],
                                        allowedOrigins: ['https://github.example.com'],
                                    },
                                },
                            ],
                            hooks: [],
                            lifecycleHandlers: [],
                        },
                    },
                },
            ],
        });

        expect(registry.scmHostingProviders).toEqual([
            expect.objectContaining({
                pluginId: 'acme.scm',
                identity: {
                    pluginId: 'acme.scm',
                    family: 'scmHostingProviders',
                    contributionId: 'acme.scm.github',
                    provenance: 'external',
                },
                definition: expect.objectContaining({
                    id: 'acme.scm.github',
                    kind: 'github',
                }),
            }),
        ]);
        expect(registry.agents).toEqual([]);
        expect(registry.agentRuntimes).toEqual([]);
    });

    it('keeps first-party providers active when an external plugin declares a duplicate id', () => {
        const registry = createResolvedContributionRegistry({
            agents: [],
            agentRuntimes: [],
            scmHostingProviders: [
                {
                    id: 'scm.github',
                    provenance: 'first_party',
                    source: { kind: 'bundled' },
                    pluginId: 'happier.scm.hosting.github',
                    definition: {
                        id: 'scm.github',
                        kind: 'github',
                        displayName: 'GitHub',
                        baseUrl: 'https://github.com',
                        remoteHostMatchers: {
                            exactHosts: ['github.com'],
                        },
                        urlSafety: {
                            allowedSchemes: ['https:'],
                            allowedBaseUrls: ['https://github.com'],
                            allowedOrigins: ['https://github.com'],
                        },
                    },
                },
                {
                    id: 'scm.github',
                    provenance: 'external',
                    source: { kind: 'path' },
                    pluginId: 'acme.shadow',
                    manifestPath: '/plugins/acme-shadow/.happier-plugin/plugin.json',
                    manifestDigest: 'sha256:shadow',
                    daemonEntryPath: null,
                    sourceSpec,
                    devDaemonEntryPath: null,
                    definition: {
                        id: 'scm.github',
                        kind: 'github',
                        displayName: 'Shadow GitHub',
                        baseUrl: 'https://github.shadow.example.com',
                        remoteHostMatchers: {
                            exactHosts: ['github.shadow.example.com'],
                        },
                        urlSafety: {
                            allowedSchemes: ['https:'],
                            allowedBaseUrls: ['https://github.shadow.example.com'],
                            allowedOrigins: ['https://github.shadow.example.com'],
                        },
                    },
                },
            ],
        });

        expect(registry.scmHostingProvidersById?.get('scm.github')?.pluginId).toBe('happier.scm.hosting.github');
        expect(registry.scmHostingProviders).toHaveLength(1);
        expect(registry.pluginDiagnosticsByPluginId['acme.shadow']).toEqual([
            expect.objectContaining({
                code: 'scm_hosting_provider_duplicate',
                message: expect.stringContaining('acme.shadow:scmHostingProviders:scm.github'),
            }),
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
                        displayName: 'Acme GitHub',
                        baseUrl: 'https://github.example.com',
                        remoteHostMatchers: {
                            exactHosts: ['github.example.com'],
                        },
                        urlSafety: {
                            allowedSchemes: ['https:'],
                            allowedBaseUrls: ['https://github.example.com'],
                            allowedOrigins: ['https://github.example.com'],
                        },
                        capabilities: {
                            compareUrl: true,
                            openUrl: true,
                        },
                    },
                },
            ],
            scmHostingProvidersById: new Map(),
        });

        const projection = buildPluginProjectionV2({
            registry,
            generation: 3,
        });

        expect(projection.familiesById.scmHostingProviders?.entriesById['acme.scm.github']).toEqual({
            id: 'acme.scm.github',
            pluginId: 'acme.scm',
            kind: 'github',
            displayName: 'Acme GitHub',
            baseUrl: 'https://github.example.com',
            urlSafety: {
                allowedSchemes: ['https:'],
                allowedBaseUrls: ['https://github.example.com'],
                allowedOrigins: ['https://github.example.com'],
            },
            capabilities: expect.objectContaining({
                compareUrl: true,
                openUrl: true,
            }),
        });
    });

    it('projects bundled first-party SCM hosting providers without agent or backend contributions', () => {
        const registry = createEmptyRegistry({
            agents: [],
            agentRuntimes: [],
            scmHostingProviders: [
                {
                    id: 'scm.github',
                    provenance: 'first_party',
                    source: { kind: 'bundled' },
                    pluginId: 'happier.scm.hosting.github',
                    definition: {
                        id: 'scm.github',
                        kind: 'github',
                        displayName: 'GitHub',
                        baseUrl: 'https://github.com',
                        remoteHostMatchers: {
                            exactHosts: ['github.com'],
                        },
                        urlSafety: {
                            allowedSchemes: ['https:'],
                            allowedBaseUrls: ['https://github.com'],
                            allowedOrigins: ['https://github.com'],
                        },
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
        expect(registry.agentRuntimes).toEqual([]);
        expect(projection.familiesById.scmHostingProviders?.entriesById['scm.github']).toEqual({
            id: 'scm.github',
            pluginId: 'happier.scm.hosting.github',
            kind: 'github',
            displayName: 'GitHub',
            baseUrl: 'https://github.com',
            urlSafety: {
                allowedSchemes: ['https:'],
                allowedBaseUrls: ['https://github.com'],
                allowedOrigins: ['https://github.com'],
            },
            capabilities: expect.objectContaining({
                compareUrl: false,
                openUrl: false,
            }),
        });
    });
});
