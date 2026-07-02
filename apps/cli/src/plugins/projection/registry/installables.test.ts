import { describe, expect, it } from 'vitest';
import { GH_INSTALLABLE_DESCRIPTOR, InstallableDependencyDescriptorSchema } from '@happier-dev/protocol';

import { buildPluginProjectionV2 } from './projection/v2';
import { buildPluginContributionRegistry } from './normalize/package';
import { createResolvedContributionRegistry } from './createResolvedContributionRegistry';
import { resolveBuiltInContributions } from './resolveBuiltInContributions';
import type { ResolvedContributionRegistry } from './types';

const sourceSpec = {
    kind: 'path' as const,
    locator: '/plugins/acme-installables',
    trustPolicy: 'local_trusted' as const,
    installPolicy: 'link' as const,
};

function createEmptyRegistry(overrides: Partial<ResolvedContributionRegistry> = {}): ResolvedContributionRegistry {
    return {
        providers: [],
        backends: [],
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
        providerDefinitionsById: new Map(),
        backendDefinitionsById: new Map(),
        pluginDiagnosticsByPluginId: {},
        ...overrides,
    };
}

const acmeManualDescriptor = InstallableDependencyDescriptorSchema.parse({
    id: 'acme-tool',
    key: 'acme-tool',
    kind: 'dep',
    version: '1',
    capabilityId: 'dep.acme-tool',
    display: {
        name: 'Acme Tool',
    },
    description: 'Acme tool dependency',
    source: {
        kind: 'manual_only',
        setupUrl: 'https://example.com/acme-tool',
    },
    binary: {
        commands: ['acme-tool'],
        systemFirst: true,
    },
    defaultPolicy: {
        autoInstallWhenNeeded: false,
        autoUpdateMode: 'notify',
    },
    consent: {
        install: 'required',
        update: 'required',
    },
});

describe('installable plugin contributions', () => {
    it('contributes gh as a protected built-in installable', () => {
        const builtIns = resolveBuiltInContributions();

        expect(builtIns.installables).toEqual(expect.arrayContaining([
            expect.objectContaining({
                pluginId: 'happier.core',
                definition: expect.objectContaining({
                    key: GH_INSTALLABLE_DESCRIPTOR.key,
                    capabilityId: GH_INSTALLABLE_DESCRIPTOR.capabilityId,
                }),
            }),
        ]));
    });

    it('flattens installable descriptors from manifests without daemon execution metadata', () => {
        const registry = buildPluginContributionRegistry({
            loadedPlugins: [
                {
                    pluginId: 'acme.installables',
                    pluginRootPath: '/plugins/acme-installables',
                    manifestPath: '/plugins/acme-installables/.happier-plugin/plugin.json',
                    manifestDigest: 'sha256:acme',
                    daemonEntryPath: null,
                    sourceSpec,
                    manifest: {
                        schemaVersion: 2,
                        id: 'acme.installables',
                        version: '1.0.0',
                        displayName: 'Acme Installables',
                        engines: { happier: '^0.2.0' },
                        runtime: {
                            apiVersion: 1,
                            capabilities: [],
                        },
                        targets: {},
                        permissions: [],
                        contributes: {
                            providers: [],
                            backends: [],
                            actions: [],
                            tools: [],
                            commands: [],
                            resources: [],
                            uiDescriptors: [],
                            installables: [acmeManualDescriptor],
                            hooks: [],
                            lifecycleHandlers: [],
                        },
                    },
                },
            ],
        });

        expect(registry.installables).toEqual([
            expect.objectContaining({
                pluginId: 'acme.installables',
                daemonEntryPath: null,
                definition: expect.objectContaining({
                    key: 'acme-tool',
                    source: expect.objectContaining({ kind: 'manual_only' }),
                }),
            }),
        ]);
        expect(registry.providers).toEqual([]);
        expect(registry.backends).toEqual([]);
    });

    it('keeps built-in installables active when an external plugin duplicates a key or capability', () => {
        const registry = createResolvedContributionRegistry({
            providers: [],
            backends: [],
            installables: [
                {
                    provenance: 'first_party',
                    source: { kind: 'bundled' },
                    pluginId: 'happier.core',
                    definition: {
                        ...acmeManualDescriptor,
                        id: 'codex-acp',
                        key: 'codex-acp',
                        capabilityId: 'dep.codex-acp',
                        display: { name: 'Codex ACP' },
                    },
                },
                {
                    provenance: 'external',
                    source: { kind: 'path' },
                    pluginId: 'acme.shadow',
                    manifestPath: '/plugins/acme-shadow/.happier-plugin/plugin.json',
                    manifestDigest: 'sha256:shadow',
                    daemonEntryPath: null,
                    sourceSpec,
                    definition: {
                        ...acmeManualDescriptor,
                        id: 'codex-acp-shadow',
                        key: 'codex-acp',
                        capabilityId: 'dep.codex-acp-shadow',
                        display: { name: 'Shadow Codex ACP' },
                    },
                },
            ],
        });

        expect(registry.installablesByKey?.get('codex-acp')?.pluginId).toBe('happier.core');
        expect(registry.installables).toHaveLength(1);
        expect(registry.pluginDiagnosticsByPluginId['acme.shadow']).toEqual([
            expect.objectContaining({
                code: 'installable_duplicate_key',
            }),
        ]);
    });

    it('keeps host built-ins ahead of bundled first-party plugin installables deterministically', () => {
        const registry = createResolvedContributionRegistry({
            providers: [],
            backends: [],
            installables: [
                {
                    provenance: 'first_party',
                    source: { kind: 'bundled' },
                    pluginId: 'happier.core',
                    definition: {
                        ...acmeManualDescriptor,
                        id: 'acme-tool',
                        key: 'acme-tool',
                        capabilityId: 'dep.zzz-acme-tool',
                        display: { name: 'Host Acme Tool' },
                    },
                },
                {
                    provenance: 'first_party',
                    source: { kind: 'bundled' },
                    pluginId: 'acme.first-party',
                    manifestPath: 'bundled:acme.first-party',
                    manifestDigest: 'bundled:acme.first-party@1.0.0',
                    daemonEntryPath: '@happier-dev/plugins-acme-first-party',
                    sourceSpec,
                    definition: {
                        ...acmeManualDescriptor,
                        id: 'acme-tool-plugin',
                        key: 'acme-tool',
                        capabilityId: 'dep.aaa-acme-tool',
                        display: { name: 'Bundled Acme Tool' },
                    },
                },
            ],
        });

        expect(registry.installablesByKey?.get('acme-tool')?.pluginId).toBe('happier.core');
        expect(registry.pluginDiagnosticsByPluginId['acme.first-party']).toEqual([
            expect.objectContaining({
                code: 'installable_duplicate_key',
            }),
        ]);
    });

    it('projects installables through the static non-agent projection family', () => {
        const registry = createEmptyRegistry({
            installables: [
                {
                    provenance: 'external',
                    source: { kind: 'path' },
                    pluginId: 'acme.installables',
                    manifestPath: '/plugins/acme-installables/.happier-plugin/plugin.json',
                    manifestDigest: 'sha256:acme',
                    daemonEntryPath: null,
                    sourceSpec,
                    definition: acmeManualDescriptor,
                },
            ],
            installablesByKey: new Map(),
        });

        const projection = buildPluginProjectionV2({
            registry,
            generation: 9,
        });

        expect(projection.familiesById.installables?.entriesById['acme-tool']).toEqual({
            id: 'acme-tool',
            pluginId: 'acme.installables',
            key: 'acme-tool',
            capabilityId: 'dep.acme-tool',
            sourceKind: 'manual_only',
            display: {
                name: 'Acme Tool',
            },
            defaultPolicy: {
                autoInstallWhenNeeded: false,
                autoUpdateMode: 'notify',
            },
            experimental: false,
        });
    });
});
