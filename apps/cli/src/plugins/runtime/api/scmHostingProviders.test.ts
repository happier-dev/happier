import { describe, expect, it } from 'vitest';

import type {
    PluginManifestV2,
    PluginSourceSpecV1,
    ScmHostingProviderContribution,
} from '@happier-dev/protocol';

import type { ResolvedContributionRegistry } from '@/plugins/projection/registry/types';
import { activatePluginRuntimeRegistry } from '../lifecycle/manager';

const sourceSpec: PluginSourceSpecV1 = {
    kind: 'path',
    locator: '/plugins/acme-scm',
    trustPolicy: 'local_trusted',
    installPolicy: 'link',
};

const scmHostingProviderDefinition: ScmHostingProviderContribution = {
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
};

const pluginManifest: PluginManifestV2 = {
    schemaVersion: 2,
    id: 'acme.scm',
    version: '1.0.0',
    displayName: 'Acme SCM',
    engines: {
        happier: '^0.2.0',
    },
    runtime: {
        apiVersion: 1,
        capabilities: ['scmHostingProviders'],
    },
    targets: {},
    capabilities: {
        permissions: [],
    },
    contributes: {
        scmHostingProviders: [
            scmHostingProviderDefinition,
        ],
    },
};

function createContributes(): ResolvedContributionRegistry {
    return {
        providers: [],
        backends: [],
        actions: [],
        tools: [],
        commands: [],
        resources: [],
        uiDescriptors: [],
        activationTargets: [
            {
                provenance: 'external',
                source: { kind: 'path' },
                pluginId: 'acme.scm',
                manifestPath: '/plugins/acme-scm/.happier-plugin/plugin.json',
                manifestDigest: 'sha256:acme',
                daemonEntryPath: '/plugins/acme-scm/daemon.mjs',
                sourceSpec,
            },
        ],
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
        providerDefinitionsById: new Map(),
        backendDefinitionsById: new Map(),
        scmHostingProviders: [
            {
                id: 'acme.scm.github',
                provenance: 'external',
                source: { kind: 'path' },
                pluginId: 'acme.scm',
                manifestPath: '/plugins/acme-scm/.happier-plugin/plugin.json',
                manifestDigest: 'sha256:acme',
                daemonEntryPath: '/plugins/acme-scm/daemon.mjs',
                sourceSpec,
                definition: scmHostingProviderDefinition,
            },
        ],
        scmHostingProvidersById: new Map(),
        pluginDiagnosticsByPluginId: {},
    };
}

describe('SCM hosting-provider runtime registration activation', () => {
    it('binds runtime registrations only through manifest-declared provider ids', async () => {
        const activated = await activatePluginRuntimeRegistry({
            contributes: createContributes(),
            generation: 1,
            resolveActivationSource: () => ({
                kind: 'bundled',
                moduleId: 'test:acme-scm',
                load: async () => ({
                    PLUGIN_MANIFEST: pluginManifest,
                    activate(api: Readonly<{
                        registerScmHostingProvider: (registration: Readonly<{
                            id: string;
                            adapter: Readonly<Record<string, unknown>>;
                        }>) => void;
                    }>) {
                        api.registerScmHostingProvider({
                            id: 'acme.scm.github',
                            adapter: {
                                testAdapter: true,
                            },
                        });
                    },
                }),
            }),
        });

        expect(activated.scmHostingProvidersById.get('acme.scm.github')).toEqual({
            pluginId: 'acme.scm',
            registration: {
                id: 'acme.scm.github',
                adapter: {
                    testAdapter: true,
                },
            },
        });
        expect(activated.pluginDiagnosticsByPluginId['acme.scm']).toEqual([]);
    });

    it('reports structured diagnostics when activation registers an undeclared provider id', async () => {
        const activated = await activatePluginRuntimeRegistry({
            contributes: createContributes(),
            generation: 2,
            resolveActivationSource: () => ({
                kind: 'bundled',
                moduleId: 'test:acme-scm',
                load: async () => ({
                    PLUGIN_MANIFEST: pluginManifest,
                    activate(api: Readonly<{
                        registerScmHostingProvider: (registration: Readonly<{
                            id: string;
                            adapter: Readonly<Record<string, unknown>>;
                        }>) => void;
                    }>) {
                        api.registerScmHostingProvider({
                            id: 'acme.scm.missing',
                            adapter: {},
                        });
                    },
                }),
            }),
        });

        expect(activated.scmHostingProvidersById.size).toBe(0);
        expect(activated.pluginDiagnosticsByPluginId['acme.scm']).toEqual([
            expect.objectContaining({
                code: 'plugin_scm_hosting_provider_undeclared_id',
            }),
            expect.objectContaining({
                code: 'plugin_activation_failed',
            }),
        ]);
    });
});
