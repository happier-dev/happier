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
import { createPluginRuntimeOccurrenceId } from '@/plugins/runtime/runtimeSlots';
import { resolveExecutableManagedDependenciesRegistry } from './managedDependencyExecutables';
import { getInstallablesRegistryEntries } from '../../../../../ui/sources/capabilities/installablesRegistry';
import { summarizeInstallables } from '../../../../../ui/sources/capabilities/installablesSummary';

const sourceSpec = {
    kind: 'path' as const,
    locator: '/plugins/acme-dependencies',
    trustPolicy: 'local_trusted' as const,
    installPolicy: 'link' as const,
};

function createEmptyRegistry(overrides: Partial<ResolvedContributionRegistry> = {}): ResolvedContributionRegistry {
    return {
        ...createResolvedContributionRegistry({}),
        occurrenceIdsByPluginId: { 'acme.dependencies': createPluginRuntimeOccurrenceId('acme.dependencies') },
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
    it('keeps installed core tools beside plugin tools in the Machine Tools summary without a core plugin occurrence', () => {
        const registry = createResolvedContributionRegistry(resolveBuiltInContributions());
        const projection = buildPluginProjectionV2({
            registry: {
                ...registry,
                occurrenceIdsByPluginId: Object.fromEntries((registry.managedDependencies ?? [])
                    .filter((entry) => entry.pluginId && entry.pluginId !== 'happier.core')
                    .map((entry) => [entry.pluginId!, createPluginRuntimeOccurrenceId(entry.pluginId!)])),
            },
            generation: 1,
        });
        const entries = getInstallablesRegistryEntries({ pluginProjection: projection });
        expect(entries.map((entry) => entry.key)).toEqual(expect.arrayContaining([
            'gh', 'az', 'difftastic', 'local-embeddings', 'local-voice-runtime',
        ]));
        expect(entries.some((entry) => entry.experimental)).toBe(true);
        expect(projection.familiesById?.managedDependencies.entriesById.gh).toMatchObject({
            pluginId: 'happier.core', key: 'gh',
        });
        const withoutPluginRuntimes = buildPluginProjectionV2({ registry: {
            ...registry, occurrenceIdsByPluginId: {},
        }, generation: 1 });
        expect(getInstallablesRegistryEntries({ pluginProjection: withoutPluginRuntimes })
            .some((entry) => entry.experimental)).toBe(false);
        const results = Object.fromEntries(entries.map((entry) => [entry.capabilityId, {
            ok: true as const, checkedAt: 1,
            data: { installed: entry.key === 'gh' || entry.key === 'local-voice-runtime',
                installedVersion: '2.163', sourceKind: 'system', lastInstallLogPath: null,
                lastBackgroundUpdateCheckAtMs: null },
        }]));
        expect(summarizeInstallables(entries, { status: 'loaded', snapshot: {
            response: { protocolVersion: 1, results },
        } })).toEqual({ status: 'ready', installed: 2, ready: 2, held: false });
    });

    it('carries a bundled manifest purpose through the daemon projection to the tool row data', () => {
        const registry = createResolvedContributionRegistry(resolveBuiltInContributions());
        const executable = resolveExecutableManagedDependenciesRegistry(registry.managedDependencies ?? [])
            .descriptors.find((entry) => entry.owner.provenance !== 'built_in' && entry.descriptor.description);
        if (!executable?.owner.pluginId) {
            throw new Error('Expected a bundled executable dependency with a manifest purpose');
        }
        const projection = buildPluginProjectionV2({ registry: { ...registry,
            occurrenceIdsByPluginId: { [executable.owner.pluginId]: createPluginRuntimeOccurrenceId(executable.owner.pluginId) },
        }, generation: 1 });
        expect(getInstallablesRegistryEntries({ pluginProjection: projection })
            .find((entry) => entry.key === executable.descriptor.key)?.subtitle).toBe(executable.descriptor.description);
    });

    it('requires a runtime occurrence for plugin-owned tools even when their plugin id is happier.core', () => {
        const projection = buildPluginProjectionV2({ registry: createEmptyRegistry({
            managedDependencies: [{
                provenance: 'external', source: { kind: 'path' }, pluginId: 'happier.core',
                manifestPath: '/plugins/core/.happier-plugin/plugin.json',
                definition: acmeManualDescriptor,
            }],
        }), generation: 1 });
        expect(getInstallablesRegistryEntries({ pluginProjection: projection })).toEqual([]);
    });

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
                            managedDependencies: [acmeManualContribution],
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
            occurrenceId: registry.occurrenceIdsByPluginId?.['acme.dependencies'],
            key: 'acme-tool',
            capabilityId: 'dep.acme-tool',
            sourceKind: 'manual_only',
            description: acmeManualDescriptor.description,
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
            occurrenceIdsByPluginId: Object.fromEntries(['acme.one', 'acme.two'].map((pluginId) => [
                pluginId, createPluginRuntimeOccurrenceId(pluginId),
            ])),
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

    it('keeps qualified V2 ownership without a global registry fingerprint', () => {
        const makeRegistry = (pluginId: string) => createResolvedContributionRegistry({
            agents: [],
                        managedDependencies: [{
                provenance: 'external',
                source: { kind: 'path' },
                pluginId,
                manifestPath: '/plugins/shared/.happier-plugin/plugin.json',
                daemonEntryPath: null,
                sourceSpec,
                definition: {
                    id: 'tool', title: 'Shared tool',
                    sources: [{ kind: 'system', executableNames: ['tool'] }],
                    executable: 'tool',
                },
            }],
        });

        const first = makeRegistry('acme.one');
        const second = makeRegistry('acme.two');

        expect(first.managedDependenciesByKey?.get('acme.one/tool')).toBeDefined();
        expect(second.managedDependenciesByKey?.get('acme.two/tool')).toBeDefined();
        expect(first).not.toHaveProperty('generationId');
        expect(second).not.toHaveProperty('generationId');
    });
    it('projects a pinned-archive dependency with the installable fields the UI installables registry requires', () => {
        const asset = (suffix: string) => ({
            archiveUrl: `https://downloads.acme.test/acme-pinned-tool-4.5.6-${suffix}.zip`,
            sha256: 'b'.repeat(64),
            executableSubpath: suffix.startsWith('win32') ? 'bin/acme-pinned-tool.exe' : 'bin/acme-pinned-tool',
        });
        const registry = createEmptyRegistry({
            managedDependencies: [{
                provenance: 'external',
                source: { kind: 'path' },
                pluginId: 'acme.dependencies',
                manifestPath: '/plugins/acme-dependencies/.happier-plugin/plugin.json',
                daemonEntryPath: null,
                sourceSpec,
                definition: {
                    id: 'pinned-tool',
                    title: 'Acme pinned tool',
                    description: 'Pinned Acme runtime',
                    executable: 'acme-pinned-tool',
                    sources: [{
                        kind: 'pinnedArchive',
                        installId: 'dep.acme.pinned-tool',
                        version: '4.5.6',
                        assetsByPlatform: {
                            'darwin-arm64': asset('darwin-arm64'),
                            'linux-x64': asset('linux-x64'),
                            'linux-arm64': asset('linux-arm64'),
                            'win32-x64': asset('win32-x64'),
                            'win32-arm64': asset('win32-arm64'),
                        },
                    }],
                },
            }],
            managedDependenciesByKey: new Map(),
        });

        const projection = buildPluginProjectionV2({ registry, generation: 9 });

        // The raw V2 request stays request-only; the installable projection is what the UI reads.
        expect(projection.familiesById.managedDependencies?.entriesById['acme.dependencies/pinned-tool'])
            .toEqual(expect.not.objectContaining({ key: expect.anything() }));
        expect(projection.familiesById.managedDependencies?.entriesById['dep.acme.pinned-tool']).toEqual({
            id: 'dep.acme.pinned-tool',
            pluginId: 'acme.dependencies',
            occurrenceId: registry.occurrenceIdsByPluginId?.['acme.dependencies'],
            key: 'dep.acme.pinned-tool',
            capabilityId: 'dep.acme.pinned-tool',
            sourceKind: 'pinned_archive',
            description: 'Pinned Acme runtime',
            display: {
                name: 'Acme pinned tool',
            },
            defaultPolicy: {
                autoInstallWhenNeeded: true,
                autoUpdateMode: 'off',
            },
            experimental: true,
        });
    });
});
