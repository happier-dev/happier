import { describe, expect, it } from 'vitest';
import {
    CODEX_ACP_DEP_ID,
    GH_INSTALLABLE_DESCRIPTOR,
    INSTALLABLE_KEYS,
    InstallableDependencyDescriptorSchema,
} from '@happier-dev/protocol';

import { buildPluginProjectionV2 } from './projection/v2';
import { buildPluginContributionRegistry } from './normalize/package';
import { createResolvedContributionRegistry } from './createResolvedContributionRegistry';
import { resolveBuiltInContributions } from './resolveBuiltInContributions';
import type { ResolvedContributionRegistry } from './types';

const sourceSpec = {
    kind: 'path' as const,
    locator: '/plugins/acme-dependencies',
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

describe('managed dependency plugin contributions', () => {
    it('projects codex-acp from the bundled Codex plugin instead of core built-ins', () => {
        const builtIns = resolveBuiltInContributions();

        expect(builtIns.managedDependencies).toEqual(expect.arrayContaining([
            expect.objectContaining({
                pluginId: 'happier.agent.codex',
                definition: expect.objectContaining({
                    key: INSTALLABLE_KEYS.CODEX_ACP,
                    capabilityId: CODEX_ACP_DEP_ID,
                }),
            }),
        ]));
        expect(builtIns.managedDependencies).not.toEqual(expect.arrayContaining([
            expect.objectContaining({
                pluginId: 'happier.core',
                definition: expect.objectContaining({
                    key: INSTALLABLE_KEYS.CODEX_ACP,
                }),
            }),
        ]));
    });

    it('contributes gh as a protected built-in managed dependency', () => {
        const builtIns = resolveBuiltInContributions();

        expect(builtIns.managedDependencies).toEqual(expect.arrayContaining([
            expect.objectContaining({
                pluginId: 'happier.core',
                definition: expect.objectContaining({
                    key: GH_INSTALLABLE_DESCRIPTOR.key,
                    capabilityId: GH_INSTALLABLE_DESCRIPTOR.capabilityId,
                }),
            }),
        ]));
    });

    it('flattens managed dependency descriptors from manifests without daemon execution metadata', () => {
        const registry = buildPluginContributionRegistry({
            loadedPlugins: [
                {
                    pluginId: 'acme.dependencies',
                    pluginRootPath: '/plugins/acme-dependencies',
                    manifestPath: '/plugins/acme-dependencies/.happier-plugin/plugin.json',
                    manifestDigest: 'sha256:acme',
                    daemonEntryPath: null,
                    sourceSpec,
                    devDaemonEntryPath: null,
                    manifest: {
                        schemaVersion: 2,
                        id: 'acme.dependencies',
                        version: '1.0.0',
                        displayName: 'Acme Dependencies',
                        engines: { happier: '^0.2.0' },
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
                            managedDependencies: [acmeManualDescriptor],
                            hooks: [],
                            lifecycleHandlers: [],
                        },
                    },
                },
            ],
        });

        expect(registry.managedDependencies).toEqual([
            expect.objectContaining({
                pluginId: 'acme.dependencies',
                daemonEntryPath: null,
                definition: expect.objectContaining({
                    key: 'acme-tool',
                    source: expect.objectContaining({ kind: 'manual_only' }),
                }),
            }),
        ]);
        expect(registry.agents).toEqual([]);
        expect(registry.agentRuntimes).toEqual([]);
    });

    it('keeps built-in managed dependencies active when an external plugin duplicates a key or capability', () => {
        const registry = createResolvedContributionRegistry({
            agents: [],
            agentRuntimes: [],
            managedDependencies: [
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
                    devDaemonEntryPath: null,
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

        expect(registry.managedDependenciesByKey?.get('codex-acp')?.pluginId).toBe('happier.core');
        expect(registry.managedDependencies).toHaveLength(1);
        expect(registry.pluginDiagnosticsByPluginId['acme.shadow']).toEqual([
            expect.objectContaining({
                code: 'installable_duplicate_key',
            }),
        ]);
    });

    it('keeps host built-ins ahead of bundled first-party plugin managed dependencies deterministically', () => {
        const registry = createResolvedContributionRegistry({
            agents: [],
            agentRuntimes: [],
            managedDependencies: [
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
                    devDaemonEntryPath: null,
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

        expect(registry.managedDependenciesByKey?.get('acme-tool')?.pluginId).toBe('happier.core');
        expect(registry.pluginDiagnosticsByPluginId['acme.first-party']).toEqual([
            expect.objectContaining({
                code: 'installable_duplicate_key',
            }),
        ]);
    });

    it('projects managed dependencies through the static non-agent projection family', () => {
        const registry = createEmptyRegistry({
            managedDependencies: [
                {
                    provenance: 'external',
                    source: { kind: 'path' },
                    pluginId: 'acme.dependencies',
                    manifestPath: '/plugins/acme-dependencies/.happier-plugin/plugin.json',
                    manifestDigest: 'sha256:acme',
                    daemonEntryPath: null,
                    sourceSpec,
                    devDaemonEntryPath: null,
                    definition: acmeManualDescriptor,
                },
            ],
            managedDependenciesByKey: new Map(),
        });

        const projection = buildPluginProjectionV2({
            registry,
            generation: 9,
        });

        expect(projection.familiesById.managedDependencies?.entriesById['acme-tool']).toEqual({
            id: 'acme-tool',
            pluginId: 'acme.dependencies',
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
