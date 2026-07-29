import { describe, expect, it } from 'vitest';
import {
    GH_INSTALLABLE_DESCRIPTOR,
    INSTALLABLE_KEYS,
    InstallableDependencyDescriptorSchema,
} from '@happier-dev/protocol';

import { buildPluginProjectionV2 } from './projection/v2';
import { buildPluginContributionRegistry } from './normalize/package';
import { createResolvedContributionRegistry } from './createResolvedContributionRegistry';
import { resolveBuiltInContributions } from './resolveBuiltInContributions';
import type { ResolvedContributionRegistry } from './types';
import { readCanonicalPluginManifest } from '@/plugins/manifest/normalize';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';

const sourceSpec = {
    kind: 'path' as const,
    locator: '/plugins/acme-dependencies',
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

const acmeManualContribution = {
    id: 'acme-tool',
    title: 'Acme Tool',
    description: 'Acme tool dependency',
    sources: [{ kind: 'manual' as const, instructions: 'Install Acme Tool manually' }],
    executable: 'acme-tool',
};

describe('managed dependency plugin contributions', () => {
    it('projects the codex-acp dependency request from the bundled Codex plugin instead of core built-ins', () => {
        const builtIns = resolveBuiltInContributions();

        expect(builtIns.managedDependencies).toEqual(expect.arrayContaining([
            expect.objectContaining({
                pluginId: 'happier.agent.codex',
                definition: expect.objectContaining({
                    id: INSTALLABLE_KEYS.CODEX_ACP,
                    executable: INSTALLABLE_KEYS.CODEX_ACP,
                }),
            }),
        ]));
        expect(builtIns.managedDependencies).not.toEqual(expect.arrayContaining([
            expect.objectContaining({
                pluginId: 'happier.core',
                definition: expect.objectContaining({
                    id: INSTALLABLE_KEYS.CODEX_ACP,
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
                    manifest: readCanonicalPluginManifest(createPluginManifestV2Fixture({
                        schemaVersion: 2,
                        id: 'acme.dependencies',
                        version: '1.0.0',
                        displayName: 'Acme Dependencies',
                        engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 },
                        entrypoints: { daemon: './daemon.js' },
                        contributes: {
                            agents: [],
                            actions: [],
                            tools: [],
                            commands: [],
                            resources: [],
                            managedDependencies: [acmeManualContribution],
                            hooks: [],
                        },
                    }))!,
                },
            ],
        });

        expect(registry.managedDependencies).toEqual([
            expect.objectContaining({
                pluginId: 'acme.dependencies',
                daemonEntryPath: null,
                definition: expect.objectContaining({
                    id: 'acme-tool',
                    sources: [expect.objectContaining({ kind: 'manual' })],
                }),
            }),
        ]);
        expect(registry.agents).toEqual([]);
    });

    it('keeps built-in managed dependencies active when an external plugin duplicates a key or capability', () => {
        const registry = createResolvedContributionRegistry({
            agents: [],
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
                        id: 'codex-acp',
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
                        id: 'acme-tool',
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

    it('keeps same-local-id V2 dependencies qualified through registry lookup and projection', () => {
        const managedDependencies = ['acme.one', 'acme.two'].map((pluginId) => ({
            provenance: 'external' as const,
            source: { kind: 'path' as const },
            pluginId,
            manifestPath: `/plugins/${pluginId}/.happier-plugin/plugin.json`,
            manifestDigest: `sha256:${pluginId}`,
            daemonEntryPath: null,
            sourceSpec: { ...sourceSpec, locator: `/plugins/${pluginId}` },
            definition: {
                id: 'tool',
                title: `${pluginId} tool`,
                sources: [{ kind: 'system' as const, executableNames: [`${pluginId}-tool`] }],
                executable: `${pluginId}-tool`,
            },
        }));
        const registry = createResolvedContributionRegistry({
            agents: [],
                        managedDependencies,
        });

        expect(registry.managedDependenciesByKey?.get('acme.one/tool')?.pluginId).toBe('acme.one');
        expect(registry.managedDependenciesByKey?.get('acme.two/tool')?.pluginId).toBe('acme.two');

        const projection = buildPluginProjectionV2({ registry, generation: 9 });
        expect(Object.keys(projection.familiesById.managedDependencies?.entriesById ?? {})).toEqual([
            'acme.one/tool',
            'acme.two/tool',
        ]);
        expect(Object.values(
            projection.familiesById.managedDependencies?.entriesById ?? {},
        )).toEqual([
            expect.not.objectContaining({ title: expect.anything() }),
            expect.not.objectContaining({ title: expect.anything() }),
        ]);
    });

    it('includes qualified V2 ownership in the resolved registry generation identity', () => {
        const makeRegistry = (pluginId: string) => createResolvedContributionRegistry({
            agents: [],
                        managedDependencies: [{
                provenance: 'external',
                source: { kind: 'path' },
                pluginId,
                manifestPath: '/plugins/shared/.happier-plugin/plugin.json',
                manifestDigest: 'sha256:shared',
                daemonEntryPath: null,
                sourceSpec,
                definition: {
                    id: 'tool', title: 'Shared tool',
                    sources: [{ kind: 'system', executableNames: ['tool'] }],
                    executable: 'tool',
                },
            }],
        });

        expect(makeRegistry('acme.one').generationId).not.toBe(makeRegistry('acme.two').generationId);
    });
});
