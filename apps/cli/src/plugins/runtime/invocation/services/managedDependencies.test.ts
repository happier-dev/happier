import { describe, expect, it, vi } from 'vitest';

import type {
    PluginHostAccessRequestV2,
    PluginManagedDependencyContributionV2,
    PluginSourceCustodyV1,
} from '@happier-dev/protocol';
import { resolveInstallablesRegistry, type InstallableDependencyDescriptor } from '@happier-dev/protocol/installables';
import { PluginError } from '@happier-dev/plugin-sdk';
import type { RuntimeInstallableAdapter } from '@/packagedRuntime/installables/registry';
import {
    resolveExecutableManagedDependenciesRegistry,
} from '@/plugins/projection/registry/managedDependencyExecutables';
import type { ResolvedInstallableContribution } from '@/plugins/projection/registry/types';
import {
    createAgentSessionRunnerFactoryBinding,
} from '@/plugins/runtime/runner/agentSessionRunnerFactoryBinding';

import { createStablePluginManagedDependenciesHost } from './managedDependencies';
import { createV2ManagedDependencySourceModel } from './managedDependencySourceModel';

function descriptor(
    key: string,
    source: InstallableDependencyDescriptor['source'] = { kind: 'github_release_binary', repo: 'acme/tool' },
): InstallableDependencyDescriptor {
    return {
        id: key,
        key,
        kind: 'dep',
        capabilityId: `dep.${key}`,
        version: '1',
        capabilityGates: [],
        permissionGates: [],
        redaction: 'none',
        hidden: false,
        display: { name: key },
        description: `${key} dependency`,
        source,
        binary: { commands: [key], systemFirst: true, managedFallback: true },
        defaultPolicy: { autoInstallWhenNeeded: true, autoUpdateMode: 'notify' },
        consent: { install: 'not_required', update: 'not_required' },
        stability: { experimental: false, supported: true },
    };
}

function adapter(key: string, overrides: Partial<RuntimeInstallableAdapter> = {}): RuntimeInstallableAdapter {
    return {
        key,
        capabilityId: `dep.${key}`,
        detectLaunchResolution: async () => ({
            availability: { ok: true },
            canAutoInstall: false,
            canBackgroundAutoUpdate: false,
        }),
        resolveLaunchCommand: async () => ({
            ok: true,
            command: `/managed/${key}`,
            args: ['host-default'],
            source: 'managed',
        }),
        installOrUpgrade: async () => ({ ok: true, logPath: '/redacted/install.log' }),
        runBackgroundAutoUpdateCheck: async () => {},
        ...overrides,
    };
}

function hostFor(
    descriptors: readonly InstallableDependencyDescriptor[],
    resolveAdapter: (key: string) => Promise<RuntimeInstallableAdapter>,
    removeManagedInstall = vi.fn(async () => {}),
) {
    return createStablePluginManagedDependenciesHost({
        installablesRegistry: resolveInstallablesRegistry({
            externalPlugins: descriptors.map((value) => ({
                owner: { provenance: 'external_plugin', ownerId: `owner:${value.key}`, pluginId: 'acme.plugin' },
                descriptor: value,
            })),
        }),
        getSettings: () => ({ machineId: 'machine-1' }),
        resolveAdapter: async (key) => await resolveAdapter(key),
        removeManagedInstall,
    });
}

function v2Contribution(
    pluginId: string,
    id: string,
    sources: PluginManagedDependencyContributionV2['sources'],
): ResolvedInstallableContribution {
    return {
        provenance: 'external', source: { kind: 'path' }, pluginId,
        manifestPath: `/plugins/${pluginId}/.happier-plugin/plugin.json`, daemonEntryPath: null,
        sourceSpec: { kind: 'path', locator: `/plugins/${pluginId}`, trustPolicy: 'local_trusted', installPolicy: 'link' },
        definition: { id, title: `${pluginId} ${id}`, sources, executable: id },
    };
}

function managedPypiSource(
    installId: `dep.${string}`,
): Extract<PluginManagedDependencyContributionV2['sources'][number], { kind: 'managedPypiWheelAsset' }> {
    return {
        kind: 'managedPypiWheelAsset',
        installId,
        distribution: 'acme-tool',
        versionSpecifier: '>=1,<3',
        assetPathByPlatform: { 'linux-x64': 'acme/bin/tool' },
        executable: true,
        installConsent: 'host_managed_required',
        autoUpdateMode: 'notify',
    };
}

function pinnedArchiveSource(
    installId: `dep.${string}`,
    facts: Readonly<{ version: string; sha256: string }>,
): Extract<PluginManagedDependencyContributionV2['sources'][number], { kind: 'pinnedArchive' }> {
    return {
        kind: 'pinnedArchive',
        installId,
        version: facts.version,
        assetsByPlatform: {
            'linux-x64': {
                archiveUrl: `https://dl.example.test/${installId}-${facts.version}.zip`,
                sha256: facts.sha256,
                executableSubpath: 'agy_acp_server.par',
            },
        },
    };
}

function v2Host(params: Readonly<{
    contributions: readonly ResolvedInstallableContribution[];
    resolveSourceAdapter: NonNullable<Parameters<typeof createStablePluginManagedDependenciesHost>[0]['resolveSourceAdapter']>;
    removeManagedSource?: NonNullable<Parameters<typeof createStablePluginManagedDependenciesHost>[0]['removeManagedSource']>;
    legacyDescriptors?: readonly InstallableDependencyDescriptor[];
    sourceCustodiesByPluginId?: ReadonlyMap<string, PluginSourceCustodyV1>;
    isCurrent?: () => boolean;
}>) {
    const legacyContributions = (params.legacyDescriptors ?? []).map((value) => ({
        provenance: 'external' as const,
        source: { kind: 'path' as const },
        pluginId: 'acme.plugin',
        manifestPath: '/plugins/acme.plugin/.happier-plugin/plugin.json',
        daemonEntryPath: null,
        sourceSpec: {
            kind: 'path' as const,
            locator: '/plugins/acme.plugin',
            trustPolicy: 'local_trusted' as const,
            installPolicy: 'link' as const,
        },
        definition: value,
    })) satisfies readonly ResolvedInstallableContribution[];
    const sourceModel = createV2ManagedDependencySourceModel({
        platform: 'linux', architecture: 'x64',
        contributions: params.contributions,
    });
    return createStablePluginManagedDependenciesHost({
        installablesRegistry: resolveExecutableManagedDependenciesRegistry(
            [...params.contributions, ...legacyContributions],
            { platform: 'linux', architecture: 'x64' },
        ),
        sourceModel,
        ...(params.isCurrent ? { isCurrent: params.isCurrent } : {}),
        ...(params.sourceCustodiesByPluginId
            ? {
                sourceCustodiesByPluginId:
                    params.sourceCustodiesByPluginId,
            }
            : {}),
        getSettings: () => ({}),
        resolveAdapter: async () => { throw new Error('legacy adapter must not be used'); },
        resolveSourceAdapter: params.resolveSourceAdapter,
        removeManagedInstall: async () => {},
        removeManagedSource: params.removeManagedSource ?? (async () => {}),
    });
}

function retainedRunnerInputs(params: Readonly<{
    pluginId: string;
    immutableGenerationId: string;
    executableIds: readonly (
        | string
        | Readonly<{ pluginId: string; localId: string }>
    )[];
}>) {
    const binding = createAgentSessionRunnerFactoryBinding({
        v: 1,
        pluginId: params.pluginId,
        pluginVersion: '1.0.0',
        agentId: 'runner',
        localAgentId: 'runner',
        sourceCustody: {
            kind: 'managed',
            immutableGenerationId: params.immutableGenerationId,
            installSource: 'localPath',
        },
        locator: {
            module: './runtime.mjs',
            export: 'createRuntime',
            runtimeApiVersion: 1,
        },
        normalizedModulePath: 'runtime.mjs',
        loadMode: 'immutable-js',
    });
    const hostAccessRequests: readonly Readonly<{
        request: PluginHostAccessRequestV2;
        required: boolean;
    }>[] = [{
            required: true,
            request: {
                id: 'runner-process',
                capability: 'process',
                reason: 'Run exact managed dependencies',
                scope: {
                    executables: params.executableIds.map((id) => ({
                        kind: 'managedDependency' as const,
                        id,
                    })),
                },
            },
        }];
    return Object.freeze({ binding, hostAccessRequests });
}

describe('ready-only preflight executable resolution', () => {
    it('reports an unavailable declared dependency without installing it', async () => {
        const install = vi.fn(async () => ({ ok: true as const, logPath: '/redacted/install.log' }));
        const host = hostFor([descriptor('native-acp')], async () => adapter('native-acp', {
            resolveLaunchCommand: async () => ({ ok: false, errorMessage: 'Not installed', canAutoInstall: true }),
            detectLaunchResolution: async () => ({ availability: { ok: false, errorMessage: 'Not installed' }, canAutoInstall: true, canBackgroundAutoUpdate: false }),
            installOrUpgrade: install,
        }));
        await expect(host.resolveExecutable({ kind: 'managedDependency', id: 'native-acp' }, 'acme.plugin', { requireReady: true }))
            .rejects.toMatchObject({ code: 'plugin_managed_dependency_executable_unavailable' });
        expect(install).not.toHaveBeenCalled();
    });
});

describe('stable plugin managed dependencies host', () => {
    it('retains bundled dependencies from the runner snapshot across a daemon snapshot change', () => {
        const daemonCustody = {
            kind: 'bundled_first_party' as const,
            packagedRuntime: { kind: 'pinned_runner_snapshot' as const, snapshotId: 'daemon-b' },
        };
        const runnerCustody = {
            kind: 'bundled_first_party' as const,
            packagedRuntime: { kind: 'pinned_runner_snapshot' as const, snapshotId: 'runner-a' },
        };
        const contribution = {
            ...v2Contribution('happier.agent.fixture', 'tool', [{
                kind: 'system' as const,
                executableNames: ['tool'],
            }]),
            provenance: 'first_party' as const,
            source: { kind: 'bundled' as const },
            sourceSpec: {
                kind: 'bundled' as const,
                locator: 'happier.agent.fixture',
                trustPolicy: 'local_trusted' as const,
                installPolicy: 'link' as const,
            },
        } satisfies ResolvedInstallableContribution;
        const host = v2Host({
            contributions: [contribution],
            resolveSourceAdapter: async () => adapter('unused'),
            sourceCustodiesByPluginId: new Map([
                ['happier.agent.fixture', daemonCustody],
            ]),
        });
        const inputs = retainedRunnerInputs({
            pluginId: 'happier.agent.fixture',
            immutableGenerationId: 'unused',
            executableIds: [{ pluginId: 'happier.agent.fixture', localId: 'tool' }],
        });
        const retention = host.snapshotRunnerRetention(
            { ...inputs.binding, sourceCustody: runnerCustody },
            inputs.hostAccessRequests,
        );
        expect(retention.sourceCustodies).toEqual([runnerCustody]);
        expect(retention.sourceCandidates).toEqual([{
            qualifiedDependencyId: 'happier.agent.fixture/tool',
            sourceCustody: runnerCustody,
            manifestAuthority: 'bundled_first_party',
        }]);
    });

    it('authoritatively ensures a missing managed executable at launch and coalesces concurrent launch ensures', async () => {
        let installed = false;
        let releaseInstall!: () => void;
        const installGate = new Promise<void>((resolve) => { releaseInstall = resolve; });
        const installOrUpgrade = vi.fn(async () => {
            await installGate;
            installed = true;
            return { ok: true as const, logPath: '/redacted/install.log' };
        });
        const managedAdapter = adapter('tool', {
            detectLaunchResolution: async () => ({
                availability: installed ? { ok: true as const } : { ok: false as const, errorMessage: 'not installed' },
                canAutoInstall: true, canBackgroundAutoUpdate: false,
            }),
            resolveLaunchCommand: async () => installed
                ? { ok: true as const, command: '/managed/tool', args: ['--asset-default'], source: 'managed' as const }
                : { ok: false as const, errorMessage: 'not installed', canAutoInstall: true },
            installOrUpgrade,
        });
        const host = v2Host({
            contributions: [v2Contribution('acme.plugin', 'tool', [{
                kind: 'pinnedArchive',
                installId: 'dep.acme.tool',
                version: '1.0.0',
                assetsByPlatform: {
                    'linux-x64': {
                        archiveUrl: 'https://downloads.example.test/tool-1.0.0.zip',
                        sha256: 'a'.repeat(64),
                        executableSubpath: 'tool',
                    },
                },
            }])],
            resolveSourceAdapter: async () => managedAdapter,
        });
        const first = host.resolveExecutable({ kind: 'managedDependency', id: 'tool' }, 'acme.plugin');
        const second = host.resolveExecutable({ kind: 'managedDependency', id: 'tool' }, 'acme.plugin');
        await vi.waitFor(() => expect(installOrUpgrade).toHaveBeenCalledTimes(1));
        releaseInstall();
        const leases = await Promise.all([first, second]);
        expect(leases.map((lease) => [lease.command, lease.args])).toEqual([
            ['/managed/tool', ['--asset-default']], ['/managed/tool', ['--asset-default']],
        ]);
        expect(installOrUpgrade).toHaveBeenCalledTimes(1);
        leases.forEach((lease) => lease.release());
    });

    it('pins only exact G-approved dependencies using committed immutable owner generations, never process-local ordinal aliases', () => {
        const daemonA = v2Host({
            contributions: [
                v2Contribution('acme.dependency', 'managed-tool', [
                    { kind: 'system', executableNames: ['managed-tool'] },
                    managedPypiSource('dep.acme.managed-tool'),
                ]),
                v2Contribution('acme.unrelated', 'unrelated-tool', [
                    managedPypiSource('dep.acme.unrelated-tool'),
                ]),
            ],
            resolveSourceAdapter: async () => adapter('unused'),
            sourceCustodiesByPluginId: new Map([
                ['acme.dependency', {
                    kind: 'managed',
                    immutableGenerationId: 'immutable-dependency-g',
                    installSource: 'localPath',
                }],
                ['acme.unrelated', {
                    kind: 'managed',
                    immutableGenerationId: 'immutable-unrelated-a',
                    installSource: 'localPath',
                }],
            ]),
        });
        const retainedG = retainedRunnerInputs({
            pluginId: 'acme.agent',
            immutableGenerationId: 'immutable-agent-g',
            executableIds: [{
                pluginId: 'acme.dependency',
                localId: 'managed-tool',
            }],
        });

        expect(daemonA.snapshotRunnerRetention(
            retainedG.binding,
            retainedG.hostAccessRequests,
        )).toEqual({
            v: 1,
            sourceCustodies: [{
                kind: 'managed',
                immutableGenerationId: 'immutable-dependency-g',
                installSource: 'localPath',
            }],
            qualifiedDependencyIds: ['acme.dependency/managed-tool'],
            sourceCandidates: [{
                qualifiedDependencyId:
                    'acme.dependency/managed-tool',
                sourceCustody: {
                    kind: 'managed',
                    immutableGenerationId: 'immutable-dependency-g',
                    installSource: 'localPath',
                },
                manifestAuthority: 'external',
            }],
        });

        const daemonB = v2Host({
            // Both daemons independently use the process-local source-model
            // ordinal `registry:occurrenceId-v2`; only immutable H may cross
            // the marker boundary.
            contributions: [v2Contribution(
                'acme.dependency',
                'managed-tool',
                [managedPypiSource('dep.acme.managed-tool-h')],
            )],
            resolveSourceAdapter: async () => adapter('unused'),
            sourceCustodiesByPluginId: new Map([
                ['acme.dependency', {
                    kind: 'managed',
                    immutableGenerationId: 'immutable-dependency-h',
                    installSource: 'localPath',
                }],
            ]),
        });
        const retainedH = retainedRunnerInputs({
            pluginId: 'acme.agent',
            immutableGenerationId: 'immutable-agent-h',
            executableIds: [{
                pluginId: 'acme.dependency',
                localId: 'managed-tool',
            }],
        });
        expect(daemonB.snapshotRunnerRetention(
            retainedH.binding,
            retainedH.hostAccessRequests,
        )).toEqual({
            v: 1,
            sourceCustodies: [{
                kind: 'managed',
                immutableGenerationId: 'immutable-dependency-h',
                installSource: 'localPath',
            }],
            qualifiedDependencyIds: ['acme.dependency/managed-tool'],
            sourceCandidates: [{
                qualifiedDependencyId:
                    'acme.dependency/managed-tool',
                sourceCustody: {
                    kind: 'managed',
                    immutableGenerationId: 'immutable-dependency-h',
                    installSource: 'localPath',
                },
                manifestAuthority: 'external',
            }],
        });
    });

    it('blocks destructive removal and source-occurrenceId retirement while an exact live runner retains them', async () => {
        let retained = {
            v: 1 as const,
            sourceCustodies: [{
                kind: 'managed' as const,
                immutableGenerationId: 'immutable-plugin-g',
                installSource: 'localPath' as const,
            }],
            qualifiedDependencyIds: ['acme.plugin/tool'],
        };
        const removeManagedSource = vi.fn(async () => {});
        const contributions = [
            v2Contribution('acme.plugin', 'tool', [
                managedPypiSource('dep.acme.tool'),
            ]),
        ];
        const sourceModel = createV2ManagedDependencySourceModel({
            platform: 'linux',
            architecture: 'x64',
            contributions,
        });
        const host = createStablePluginManagedDependenciesHost({
            installablesRegistry: resolveExecutableManagedDependenciesRegistry(
                contributions,
                { platform: 'linux', architecture: 'x64' },
            ),
            sourceModel,
            sourceCustodiesByPluginId: new Map([
                ['acme.plugin', {
                    kind: 'managed',
                    immutableGenerationId: 'immutable-plugin-g',
                    installSource: 'localPath',
                }],
            ]),
            getSettings: () => ({}),
            resolveAdapter: async () => {
                throw new Error('legacy adapter must not be used');
            },
            resolveSourceAdapter: async () => adapter('tool'),
            removeManagedInstall: async () => {},
            removeManagedSource,
            readLiveRunnerRetention: async () => retained,
        });

        await expect(
            host.bind('acme.plugin').remove('tool'),
        ).rejects.toMatchObject({
            code: 'plugin_managed_dependency_in_use',
        });
        await expect(
            host.retireGeneration('registry:occurrenceId-v2'),
        ).rejects.toMatchObject({
            code: 'plugin_managed_dependency_in_use',
        });
        expect(removeManagedSource).not.toHaveBeenCalled();

        retained = {
            v: 1,
            sourceCustodies: [],
            qualifiedDependencyIds: [],
        };
        await expect(
            host.bind('acme.plugin').remove('tool'),
        ).resolves.toBeUndefined();
        await expect(
            host.retireGeneration('registry:occurrenceId-v2'),
        ).resolves.toBeUndefined();
        expect(removeManagedSource).toHaveBeenCalledOnce();
    });

    it('reserves runner retention before durable marker publication can race destructive work', async () => {
        const removeManagedSource = vi.fn(async () => {});
        const host = v2Host({
            contributions: [
                v2Contribution('acme.plugin', 'tool', [
                    managedPypiSource('dep.acme.tool'),
                ]),
            ],
            resolveSourceAdapter: async () => adapter('tool'),
            removeManagedSource,
            sourceCustodiesByPluginId: new Map([
                ['acme.plugin', {
                    kind: 'managed',
                    immutableGenerationId: 'immutable-agent-g',
                    installSource: 'localPath',
                }],
            ]),
        });
        const retained = retainedRunnerInputs({
            pluginId: 'acme.plugin',
            immutableGenerationId: 'immutable-agent-g',
            executableIds: ['tool'],
        });
        const reservation = host.reserveRunnerRetention(
            retained.binding,
            retained.hostAccessRequests,
        );

        await expect(
            host.bind('acme.plugin').remove('tool'),
        ).rejects.toMatchObject({
            code: 'plugin_managed_dependency_in_use',
        });
        await expect(
            host.retireGeneration('registry:occurrenceId-v2'),
        ).rejects.toMatchObject({
            code: 'plugin_managed_dependency_in_use',
        });
        reservation.release();

        await expect(
            host.bind('acme.plugin').remove('tool'),
        ).resolves.toBeUndefined();
        expect(removeManagedSource).toHaveBeenCalledOnce();
    });

    it('preserves an exact production source rejection when no declared source is executable', async () => {
        const host = v2Host({
            contributions: [v2Contribution('acme.plugin', 'tool', [
                { kind: 'system', executableNames: ['tool'] },
            ])],
            resolveSourceAdapter: async () => {
                throw new PluginError({
                    code: 'plugin_managed_dependency_architecture_unsupported',
                    message: 'Unsupported architecture',
                });
            },
        });

        await expect(host.bind('acme.plugin').status('tool')).resolves.toEqual({
            state: 'unsupported',
            id: 'tool',
            code: 'plugin_managed_dependency_architecture_unsupported',
        });
        await expect(host.resolveExecutable(
            { kind: 'managedDependency', id: 'tool' },
            'acme.plugin',
        )).rejects.toMatchObject({
            code: 'plugin_managed_dependency_architecture_unsupported',
        });
    });

    it('consumes V2 sources directly without adding them to the legacy installables registry', async () => {
        const sourceModel = createV2ManagedDependencySourceModel({
            platform: 'linux',
            architecture: 'x64',
            contributions: [{
                provenance: 'external', source: { kind: 'path' }, pluginId: 'acme.plugin',
                manifestPath: '/plugins/acme/.happier-plugin/plugin.json', daemonEntryPath: null,
                sourceSpec: { kind: 'path', locator: '/plugins/acme', trustPolicy: 'local_trusted', installPolicy: 'link' },
                definition: { id: 'tool', title: 'Tool', sources: [{ kind: 'system', executableNames: ['tool'] }], executable: 'tool' },
            }],
        });
        const emptyLegacyRegistry = resolveInstallablesRegistry({});
        const resolveSourceAdapter = vi.fn(async () => adapter('tool', {
            resolveLaunchCommand: async () => ({ ok: true, command: '/usr/bin/tool', args: [], source: 'system' }),
        }));
        const host = createStablePluginManagedDependenciesHost({
            installablesRegistry: emptyLegacyRegistry,
            sourceModel,
            getSettings: () => ({}),
            resolveAdapter: async () => { throw new Error('legacy adapter must not be used'); },
            resolveSourceAdapter,
            removeManagedInstall: async () => {},
            removeManagedSource: async () => {},
        });

        expect(emptyLegacyRegistry.descriptors).toEqual([]);
        await expect(host.bind('acme.plugin').status('tool')).resolves.toMatchObject({
            state: 'ready', id: 'tool', sourceId: 'acme.plugin/tool#0',
        });
        const resolved = await host.resolveExecutable({ kind: 'managedDependency', id: 'tool' }, 'acme.plugin');
        expect(resolved.command).toBe('/usr/bin/tool');
        expect(resolveSourceAdapter).toHaveBeenCalledWith(expect.objectContaining({
            dependency: expect.objectContaining({ qualifiedId: 'acme.plugin/tool' }),
            source: expect.objectContaining({ sourceId: 'acme.plugin/tool#0', kind: 'system' }),
        }));
        resolved.release();
    });

    it('falls back from a missing system source to the first declared managed source', async () => {
        const contributions: readonly ResolvedInstallableContribution[] = [{
            provenance: 'external', source: { kind: 'path' }, pluginId: 'acme.plugin',
            manifestPath: '/plugins/acme/.happier-plugin/plugin.json', daemonEntryPath: null,
            sourceSpec: { kind: 'path', locator: '/plugins/acme', trustPolicy: 'local_trusted', installPolicy: 'link' },
            definition: {
                id: 'tool', title: 'Tool', executable: 'tool',
                sources: [
                    managedPypiSource('dep.acme.tool'),
                    { kind: 'system', executableNames: ['tool'] },
                ],
            },
        }];
        const sourceModel = createV2ManagedDependencySourceModel({
            platform: 'linux', architecture: 'x64',
            contributions,
        });
        const resolveSourceAdapter = vi.fn(async ({ source }: Parameters<NonNullable<Parameters<typeof createStablePluginManagedDependenciesHost>[0]['resolveSourceAdapter']>>[0]) => (
            source.kind === 'system'
                ? adapter('system-tool', {
                    detectLaunchResolution: async () => ({
                        availability: { ok: false, errorMessage: 'not installed' },
                        canAutoInstall: false,
                        canBackgroundAutoUpdate: false,
                    }),
                    resolveLaunchCommand: async () => ({ ok: false, errorMessage: 'not installed', canAutoInstall: false }),
                })
                : adapter('managed-tool', {
                    resolveLaunchCommand: async () => ({ ok: true, command: '/managed/tool', args: [], source: 'managed' }),
                })
        ));
        const host = createStablePluginManagedDependenciesHost({
            installablesRegistry: resolveExecutableManagedDependenciesRegistry(
                contributions,
                { platform: 'linux', architecture: 'x64' },
            ), sourceModel, getSettings: () => ({}),
            resolveAdapter: async () => { throw new Error('legacy adapter must not be used'); },
            resolveSourceAdapter,
            removeManagedInstall: async () => {}, removeManagedSource: async () => {},
        });

        await expect(host.bind('acme.plugin').status('tool')).resolves.toMatchObject({
            state: 'ready', sourceId: 'acme.plugin/tool#0',
        });
        const executable = await host.resolveExecutable({ kind: 'managedDependency', id: 'tool' }, 'acme.plugin');
        expect(executable.command).toBe('/managed/tool');
        expect(resolveSourceAdapter.mock.calls.map(([input]) => input.source.kind)).toEqual([
            'system', 'managedPypiWheelAsset', 'system', 'managedPypiWheelAsset',
        ]);
        expect(resolveSourceAdapter.mock.calls
            .map(([input]) => input)
            .filter(({ source }) => source.kind === 'managedPypiWheelAsset'),
        ).toEqual(expect.arrayContaining([
            expect.objectContaining({
                sourceInstallable: expect.objectContaining({
                    key: 'dep.acme.tool',
                    source: expect.objectContaining({
                        kind: 'managed_pypi_wheel_asset',
                    }),
                }),
            }),
        ]));
        executable.release();
    });

    it('requires host-managed consent before a V2 PyPI source can install or update', async () => {
        const installOrUpgrade = vi.fn(async () => ({ ok: true as const, logPath: '/redacted/install.log' }));
        const host = v2Host({
            contributions: [v2Contribution('acme.plugin', 'tool', [
                managedPypiSource('dep.acme.tool'),
            ])],
            resolveSourceAdapter: async () => adapter('managed-tool', {
                detectLaunchResolution: async () => ({
                    availability: { ok: false, errorMessage: 'not installed' },
                    canAutoInstall: true,
                    canBackgroundAutoUpdate: false,
                }),
                resolveLaunchCommand: async () => ({
                    ok: false,
                    errorMessage: 'not installed',
                    canAutoInstall: true,
                }),
                installOrUpgrade,
            }),
        });

        await expect(host.bind('acme.plugin').ensure('tool')).rejects.toMatchObject({
            code: 'plugin_managed_dependency_consent_required',
        });
        await expect(host.bind('acme.plugin').update('tool')).rejects.toMatchObject({
            code: 'plugin_managed_dependency_consent_required',
        });
        expect(installOrUpgrade).not.toHaveBeenCalled();
    });

    it('keeps a losing external V2 wheel source out of status, mutation, removal, and executable resolution', async () => {
        const installId = 'dep.antigravity.localharness';
        const sharedDefinition = Object.freeze({
            id: 'localharness',
            title: 'Antigravity localharness',
            description: 'Shared descriptor facts must not grant shared ownership.',
            sources: [Object.freeze({
                ...managedPypiSource(installId),
                distribution: 'google-antigravity',
                assetPathByPlatform: {
                    'linux-x64': 'google/antigravity/bin/localharness',
                },
                compatibilityProbe: 'antigravity-localharness-v1',
            })],
            executable: 'localharness',
        }) satisfies PluginManagedDependencyContributionV2;
        const bundled = Object.freeze({
            ...v2Contribution('happier.antigravity', 'localharness', [
                ...sharedDefinition.sources,
            ]),
            provenance: 'first_party' as const,
            source: Object.freeze({ kind: 'bundled' as const }),
            sourceSpec: Object.freeze({
                kind: 'bundled' as const,
                locator: 'happier.antigravity',
                trustPolicy: 'local_trusted' as const,
                installPolicy: 'link' as const,
            }),
            definition: sharedDefinition,
        }) satisfies ResolvedInstallableContribution;
        const external = Object.freeze({
            ...v2Contribution('acme.collision', 'localharness', [
                ...sharedDefinition.sources,
            ]),
            definition: sharedDefinition,
        }) satisfies ResolvedInstallableContribution;
        const contributions = [bundled, external];
        const installablesRegistry = resolveExecutableManagedDependenciesRegistry(
            contributions,
            { platform: 'linux', architecture: 'x64' },
        );
        const sourceModel = createV2ManagedDependencySourceModel({
            platform: 'linux',
            architecture: 'x64',
            contributions,
        });
        const installOrUpgrade = vi.fn(async () => ({
            ok: true as const,
            logPath: '/redacted/collision.log',
        }));
        const resolveSourceAdapter = vi.fn(async () => adapter('collision', {
            installOrUpgrade,
        }));
        const removeManagedSource = vi.fn(async () => {});
        const host = createStablePluginManagedDependenciesHost({
            installablesRegistry,
            sourceModel,
            sourceCustodiesByPluginId: new Map([
                ['happier.antigravity', {
                    kind: 'managed',
                    immutableGenerationId: 'immutable-bundled-winner-g',
                    installSource: 'localPath',
                }],
                ['acme.collision', {
                    kind: 'managed',
                    immutableGenerationId: 'immutable-external-loser-g',
                    installSource: 'localPath',
                }],
            ]),
            getSettings: () => ({}),
            resolveAdapter: async () => {
                throw new Error('legacy adapter must not be used');
            },
            resolveSourceAdapter,
            removeManagedInstall: async () => {},
            removeManagedSource,
        });
        const service = host.bind('acme.collision');

        expect(installablesRegistry.descriptorsByKey[installId]?.owner.pluginId)
            .toBe('happier.antigravity');
        const retained = retainedRunnerInputs({
            pluginId: 'acme.agent',
            immutableGenerationId: 'immutable-agent-g',
            executableIds: [{
                pluginId: 'acme.collision',
                localId: 'localharness',
            }],
        });
        expect(host.snapshotRunnerRetention(
            retained.binding,
            retained.hostAccessRequests,
        )).toEqual({
            v: 1,
            sourceCustodies: [{
                kind: 'managed',
                immutableGenerationId: 'immutable-bundled-winner-g',
                installSource: 'localPath',
            }, {
                kind: 'managed',
                immutableGenerationId: 'immutable-external-loser-g',
                installSource: 'localPath',
            }],
            qualifiedDependencyIds: [
                'acme.collision/localharness',
            ],
            sourceCandidates: [{
                qualifiedDependencyId:
                    'acme.collision/localharness',
                sourceCustody: {
                    kind: 'managed',
                    immutableGenerationId: 'immutable-external-loser-g',
                    installSource: 'localPath',
                },
                manifestAuthority: 'external',
            }, {
                qualifiedDependencyId:
                    'happier.antigravity/localharness',
                sourceCustody: {
                    kind: 'managed',
                    immutableGenerationId: 'immutable-bundled-winner-g',
                    installSource: 'localPath',
                },
                manifestAuthority: 'bundled_first_party',
            }],
        });
        await expect(service.status('localharness')).resolves.toEqual({
            state: 'unsupported',
            id: 'localharness',
            code: 'plugin_managed_dependency_source_conflict',
        });
        await expect(service.update('localharness')).rejects.toMatchObject({
            code: 'plugin_managed_dependency_source_conflict',
        });
        await expect(service.remove('localharness')).rejects.toMatchObject({
            code: 'plugin_managed_dependency_source_conflict',
        });
        await expect(host.resolveExecutable(
            { kind: 'managedDependency', id: 'localharness' },
            'acme.collision',
        )).rejects.toMatchObject({
            code: 'plugin_managed_dependency_source_conflict',
        });
        expect(resolveSourceAdapter).not.toHaveBeenCalled();
        expect(installOrUpgrade).not.toHaveBeenCalled();
        expect(removeManagedSource).not.toHaveBeenCalled();
    });

    it('keeps a losing external V2 pinned-archive source off the shared install identity the canonical winner owns', async () => {
        const installId = 'dep.antigravity.agy-acp-server';
        const bundled = Object.freeze({
            ...v2Contribution('happier.agent.antigravity', 'agy-acp-server', [
                pinnedArchiveSource(installId, { version: '1.1.1', sha256: 'a'.repeat(64) }),
            ]),
            provenance: 'first_party' as const,
            source: Object.freeze({ kind: 'bundled' as const }),
            sourceSpec: Object.freeze({
                kind: 'bundled' as const,
                locator: 'happier.agent.antigravity',
                trustPolicy: 'local_trusted' as const,
                installPolicy: 'link' as const,
            }),
        }) satisfies ResolvedInstallableContribution;
        // The loser claims the same global install identity with different
        // immutable artifact facts, so installing it would overwrite the bytes
        // the winner published under that identity.
        const external = v2Contribution('acme.collision', 'agy-acp-server', [
            pinnedArchiveSource(installId, { version: '9.9.9', sha256: 'b'.repeat(64) }),
        ]);
        const contributions = [bundled, external];
        const installablesRegistry = resolveExecutableManagedDependenciesRegistry(
            contributions,
            { platform: 'linux', architecture: 'x64' },
        );
        // One install root per install identity, exactly as the pinned-archive
        // installer keys `<happyHome>/tools/<installId>/current`.
        const sharedInstallRoot = new Map<string, Readonly<{ version: string; installedBy: string }>>();
        const installsByPluginId = new Map<string, number>();
        const resolveSourceAdapter = vi.fn(async (
            { dependency, source }: Parameters<NonNullable<
                Parameters<typeof createStablePluginManagedDependenciesHost>[0]['resolveSourceAdapter']
            >>[0],
        ) => {
            const pluginId = dependency.identity.pluginId;
            const declaration = source.declaration;
            if (declaration.kind !== 'pinnedArchive') throw new Error('unexpected source kind');
            const version = declaration.version;
            const installed = () => sharedInstallRoot.get(installId)?.version === version;
            return adapter('pinned', {
                detectLaunchResolution: async () => ({
                    availability: installed()
                        ? { ok: true }
                        : { ok: false, errorMessage: 'not installed' },
                    canAutoInstall: true,
                    canBackgroundAutoUpdate: false,
                }),
                resolveLaunchCommand: async () => installed()
                    ? { ok: true, command: `/tools/${installId}/current/agy_acp_server.par`, args: [], source: 'managed' }
                    : { ok: false, errorMessage: 'not installed', canAutoInstall: true },
                installOrUpgrade: async () => {
                    installsByPluginId.set(pluginId, (installsByPluginId.get(pluginId) ?? 0) + 1);
                    sharedInstallRoot.set(installId, { version, installedBy: pluginId });
                    return { ok: true, logPath: null };
                },
            });
        });
        const removeManagedSource = vi.fn(async ({ dependency }: Readonly<{
            dependency: { qualifiedId: string };
        }>) => {
            installsByPluginId.set(
                `remove:${dependency.qualifiedId}`,
                (installsByPluginId.get(`remove:${dependency.qualifiedId}`) ?? 0) + 1,
            );
            sharedInstallRoot.delete(installId);
        });
        const host = createStablePluginManagedDependenciesHost({
            installablesRegistry,
            sourceModel: createV2ManagedDependencySourceModel({
                platform: 'linux',
                architecture: 'x64',
                contributions,
            }),
            getSettings: () => ({}),
            resolveAdapter: async () => {
                throw new Error('legacy adapter must not be used');
            },
            resolveSourceAdapter,
            removeManagedInstall: async () => {},
            removeManagedSource,
        });
        const loser = host.bind('acme.collision');
        const winner = host.bind('happier.agent.antigravity');

        expect(installablesRegistry.descriptorsByKey[installId]?.owner.pluginId)
            .toBe('happier.agent.antigravity');
        await expect(loser.status('agy-acp-server')).resolves.toEqual({
            state: 'unsupported',
            id: 'agy-acp-server',
            code: 'plugin_managed_dependency_source_conflict',
        });
        await expect(loser.ensure('agy-acp-server')).rejects.toMatchObject({
            code: 'plugin_managed_dependency_source_conflict',
        });
        await expect(loser.update('agy-acp-server')).rejects.toMatchObject({
            code: 'plugin_managed_dependency_source_conflict',
        });
        await expect(loser.remove('agy-acp-server')).rejects.toMatchObject({
            code: 'plugin_managed_dependency_source_conflict',
        });
        await expect(host.resolveExecutable(
            { kind: 'managedDependency', id: 'agy-acp-server' },
            'acme.collision',
        )).rejects.toMatchObject({
            code: 'plugin_managed_dependency_source_conflict',
        });
        expect(installsByPluginId.get('acme.collision')).toBeUndefined();
        expect(removeManagedSource).not.toHaveBeenCalled();
        expect(resolveSourceAdapter.mock.calls.map(([input]) => input.dependency.identity.pluginId))
            .not.toContain('acme.collision');

        // The canonical winner still owns the full lifecycle on that identity.
        await expect(winner.status('agy-acp-server')).resolves.toMatchObject({
            state: 'missing',
            id: 'agy-acp-server',
            supported: true,
        });
        await expect(winner.ensure('agy-acp-server')).resolves.toMatchObject({
            state: 'ready',
            id: 'agy-acp-server',
            sourceId: 'happier.agent.antigravity/agy-acp-server#0',
        });
        expect(sharedInstallRoot.get(installId)).toEqual({
            version: '1.1.1',
            installedBy: 'happier.agent.antigravity',
        });
        const lease = await host.resolveExecutable(
            { kind: 'managedDependency', id: 'agy-acp-server' },
            'happier.agent.antigravity',
        );
        expect(lease.command).toBe(`/tools/${installId}/current/agy_acp_server.par`);
        lease.release();
        await expect(winner.remove('agy-acp-server')).resolves.toBeUndefined();
        expect(removeManagedSource).toHaveBeenCalledOnce();
        expect(installsByPluginId.get('remove:happier.agent.antigravity/agy-acp-server')).toBe(1);
        expect(sharedInstallRoot.has(installId)).toBe(false);
    });

    it('exposes one V2 lifecycle identity for a projected wheel and rejects its installId alias while the local id is leased', async () => {
        const installId = 'dep.acme.tool';
        const contribution = v2Contribution('acme.plugin', 'tool', [
            managedPypiSource(installId),
        ]);
        const sourceModel = createV2ManagedDependencySourceModel({
            platform: 'linux',
            architecture: 'x64',
            contributions: [contribution],
        });
        const removeManagedInstall = vi.fn(async () => {});
        const removeManagedSource = vi.fn(async () => {});
        const host = createStablePluginManagedDependenciesHost({
            installablesRegistry: resolveExecutableManagedDependenciesRegistry(
                [contribution],
                { platform: 'linux', architecture: 'x64' },
            ),
            sourceModel,
            getSettings: () => ({}),
            resolveAdapter: async () => adapter('legacy-alias'),
            resolveSourceAdapter: async () => adapter('v2-owner'),
            removeManagedInstall,
            removeManagedSource,
        });
        const service = host.bind('acme.plugin');
        const lease = await host.resolveExecutable(
            { kind: 'managedDependency', id: 'tool' },
            'acme.plugin',
        );

        await expect(service.status(installId)).resolves.toEqual({
            state: 'unsupported',
            id: installId,
            code: 'plugin_managed_dependency_undeclared',
        });
        await expect(service.remove(installId)).rejects.toMatchObject({
            code: 'plugin_managed_dependency_undeclared',
        });
        await expect(host.resolveExecutable(
            { kind: 'managedDependency', id: installId },
            'acme.plugin',
        )).rejects.toMatchObject({
            code: 'plugin_managed_dependency_undeclared',
        });
        expect(removeManagedInstall).not.toHaveBeenCalled();
        expect(removeManagedSource).not.toHaveBeenCalled();

        lease.release();
        await service.remove('tool');
        expect(removeManagedSource).toHaveBeenCalledOnce();
        expect(removeManagedInstall).not.toHaveBeenCalled();
    });

    it('reports the first declared manual fallback when executable sources are missing', async () => {
        const host = v2Host({
            contributions: [v2Contribution('acme.plugin', 'tool', [
                { kind: 'vendorRecipe', recipeId: 'vendor.tool' },
                { kind: 'system', executableNames: ['tool'] },
                { kind: 'manual', instructions: 'Install Tool manually' },
            ])],
            resolveSourceAdapter: async () => adapter('system-tool', {
                detectLaunchResolution: async () => ({
                    availability: { ok: false, errorMessage: 'not installed' },
                    canAutoInstall: false,
                    canBackgroundAutoUpdate: false,
                }),
                resolveLaunchCommand: async () => ({ ok: false, errorMessage: 'not installed', canAutoInstall: false }),
            }),
        });

        await expect(host.bind('acme.plugin').status('tool')).resolves.toEqual({
            state: 'unsupported', id: 'tool', code: 'plugin_managed_dependency_vendor_recipe_required',
        });

        const unsupportedHost = v2Host({
            contributions: [v2Contribution('acme.plugin', 'tool', [
                { kind: 'system', executableNames: ['tool'] },
                { kind: 'vendorRecipe', recipeId: 'vendor.tool' },
            ])],
            resolveSourceAdapter: async () => { throw new Error('system adapter unavailable'); },
        });
        await expect(unsupportedHost.bind('acme.plugin').status('tool')).resolves.toEqual({
            state: 'unsupported', id: 'tool', code: 'plugin_managed_dependency_vendor_recipe_required',
        });
    });

    it('updates and reports the installed managed source rather than the first missing fallback', async () => {
        let installedVersion = '1.0.0';
        const missingInstall = vi.fn(async () => ({ ok: true as const, logPath: '/redacted/missing.log' }));
        const installedSourceUpgrade = vi.fn(async () => {
            installedVersion = '2.0.0';
            return { ok: true as const, logPath: '/redacted/installed.log' };
        });
        const host = v2Host({
            contributions: [v2Contribution('acme.plugin', 'tool', [
                managedPypiSource('dep.acme.missing'),
                managedPypiSource('dep.acme.installed'),
            ])],
            resolveSourceAdapter: async ({ source }) => source.declaration.kind === 'managedPypiWheelAsset'
                && source.declaration.installId === 'dep.acme.missing'
                ? adapter('missing-tool', {
                    detectLaunchResolution: async () => ({
                        availability: { ok: false, errorMessage: 'not installed' },
                        canAutoInstall: true,
                        canBackgroundAutoUpdate: false,
                    }),
                    resolveLaunchCommand: async () => ({ ok: false, errorMessage: 'not installed', canAutoInstall: true }),
                    installOrUpgrade: missingInstall,
                })
                : adapter('installed-tool', {
                    detectCapabilityStatus: async () => installedVersion === '1.0.0'
                        ? { installedVersion, availableVersion: '2.0.0' }
                        : { installedVersion },
                    installOrUpgrade: installedSourceUpgrade,
                }),
        });

        await expect(host.bind('acme.plugin').update('tool')).resolves.toMatchObject({
            state: 'ready', version: '2.0.0', sourceId: 'acme.plugin/tool#1',
        });
        expect(missingInstall).not.toHaveBeenCalled();
        expect(installedSourceUpgrade).toHaveBeenCalledTimes(1);
    });

    it('removes the installed managed source rather than the first missing fallback', async () => {
        const removedSourceIds: string[] = [];
        const installedAdapter = adapter('installed-tool');
        const removedAdapters: RuntimeInstallableAdapter[] = [];
        const host = v2Host({
            contributions: [v2Contribution('acme.plugin', 'tool', [
                managedPypiSource('dep.acme.missing'),
                managedPypiSource('dep.acme.installed'),
            ])],
            resolveSourceAdapter: async ({ source }) => source.declaration.kind === 'managedPypiWheelAsset'
                && source.declaration.installId === 'dep.acme.missing'
                ? adapter('missing-tool', {
                    detectLaunchResolution: async () => ({
                        availability: { ok: false, errorMessage: 'not installed' },
                        canAutoInstall: true,
                        canBackgroundAutoUpdate: false,
                    }),
                    resolveLaunchCommand: async () => ({ ok: false, errorMessage: 'not installed', canAutoInstall: true }),
                })
                : installedAdapter,
            removeManagedSource: async ({ source, adapter: selectedAdapter }) => {
                removedSourceIds.push(source.sourceId);
                removedAdapters.push(selectedAdapter);
            },
        });

        await host.bind('acme.plugin').remove('tool');
        expect(removedSourceIds).toEqual(['acme.plugin/tool#1']);
        expect(removedAdapters).toEqual([installedAdapter]);
    });

    it('continues system-first executable resolution after an adapter throws', async () => {
        const host = v2Host({
            contributions: [v2Contribution('acme.plugin', 'tool', [
                { kind: 'system', executableNames: ['tool'] },
                managedPypiSource('dep.acme.tool'),
            ])],
            resolveSourceAdapter: async ({ source }) => source.kind === 'system'
                ? adapter('system-tool', {
                    resolveLaunchCommand: async () => { throw new Error('unsafe system probe detail'); },
                })
                : adapter('managed-tool', {
                    resolveLaunchCommand: async () => ({ ok: true, command: '/managed/tool', args: [], source: 'managed' }),
                }),
        });

        const executable = await host.resolveExecutable({ kind: 'managedDependency', id: 'tool' }, 'acme.plugin');
        expect(executable.command).toBe('/managed/tool');
        executable.release();
    });

    it('retires the direct V2 model only after executable leases are released', async () => {
        const sourceModel = createV2ManagedDependencySourceModel({
            platform: 'linux', architecture: 'x64',
            contributions: [{
                provenance: 'external', source: { kind: 'path' }, pluginId: 'acme.plugin',
                manifestPath: '/plugins/acme/.happier-plugin/plugin.json', daemonEntryPath: null,
                sourceSpec: { kind: 'path', locator: '/plugins/acme', trustPolicy: 'local_trusted', installPolicy: 'link' },
                definition: { id: 'tool', title: 'Tool', sources: [{ kind: 'system', executableNames: ['tool'] }], executable: 'tool' },
            }],
        });
        const host = createStablePluginManagedDependenciesHost({
            installablesRegistry: resolveInstallablesRegistry({}), sourceModel, getSettings: () => ({}),
            resolveAdapter: async () => { throw new Error('legacy adapter must not be used'); },
            resolveSourceAdapter: async () => adapter('tool'),
            removeManagedInstall: async () => {}, removeManagedSource: async () => {},
        });
        const lease = await host.resolveExecutable({ kind: 'managedDependency', id: 'tool' }, 'acme.plugin');

        await expect(host.retireGeneration('registry:occurrenceId-v2')).rejects.toMatchObject({ code: 'plugin_managed_dependency_in_use' });
        lease.release();
        await expect(host.retireGeneration('registry:occurrenceId-v2')).resolves.toBeUndefined();
        await expect(host.bind('acme.plugin').status('tool')).resolves.toEqual({
            state: 'unsupported', id: 'tool', code: 'plugin_managed_dependency_generation_retired',
        });
    });

    it('fences the current-registry service surface when its publishing owner retires', async () => {
        let current = true;
        const host = v2Host({
            contributions: [v2Contribution('acme.plugin', 'tool', [
                { kind: 'system', executableNames: ['tool'] },
            ])],
            resolveSourceAdapter: async () => adapter('tool'),
            isCurrent: () => current,
        });

        await expect(host.bind('acme.plugin').status('tool')).resolves.toMatchObject({
            state: 'ready',
            id: 'tool',
        });
        current = false;
        await expect(host.bind('acme.plugin').status('tool')).resolves.toEqual({
            state: 'unsupported',
            id: 'tool',
            code: 'plugin_managed_dependency_generation_retired',
        });
    });

    it('retires its direct source model without comparing a registry-wide identity', async () => {
        const sourceModel = createV2ManagedDependencySourceModel({
            platform: 'linux', architecture: 'x64', contributions: [],
        });
        const host = createStablePluginManagedDependenciesHost({
            installablesRegistry: resolveInstallablesRegistry({}), sourceModel, getSettings: () => ({}),
            resolveAdapter: async () => { throw new Error('legacy adapter must not be used'); },
            removeManagedInstall: async () => {},
        });

        await expect(host.retireGeneration('registry:retire-this-instance')).resolves.toBeUndefined();
    });

    it('uses one descriptor and source-preference owner for status and executable resolution', async () => {
        const seenPreferences: string[] = [];
        const host = hostFor([descriptor('tool')], async () => adapter('tool', {
            resolveLaunchCommand: async (params) => {
                seenPreferences.push(params?.sourcePreference ?? 'absent');
                return { ok: true, command: '/managed/tool', args: ['host-default'], source: 'managed' };
            },
        }));
        const service = host.bind('acme.plugin');

        await expect(service.status('tool')).resolves.toEqual({
            state: 'ready',
            id: 'tool',
            version: 'unknown',
            sourceId: 'managed',
            executable: { kind: 'managedDependency', id: 'tool' },
        });
        const resolved = await host.resolveExecutable({ kind: 'managedDependency', id: 'tool' }, 'acme.plugin');

        expect(resolved).toMatchObject({ command: '/managed/tool', args: ['host-default'] });
        expect(seenPreferences).toEqual(['system-first', 'system-first']);
        resolved.release();
    });

    it('reports every manual and unsupported source explicitly without invoking an adapter', async () => {
        const resolveAdapter = vi.fn(async () => adapter('unused'));
        const host = hostFor([
            descriptor('manual', { kind: 'manual_only', instructionsKey: 'setup.manual' }),
            descriptor('vendor', { kind: 'vendor_recipe', recipeId: 'vendor.tool', commandsPreview: ['vendor installer'] }),
            descriptor('package', { kind: 'managed_package', packageName: '@acme/tool', packageManager: 'managed_js_runtime' }),
            descriptor('runtime', { kind: 'first_party_runtime', componentId: 'happier-memory-runtime' }),
        ], resolveAdapter);
        const service = host.bind('acme.plugin');

        await expect(service.status('manual')).resolves.toEqual({ state: 'unsupported', id: 'manual', code: 'plugin_managed_dependency_manual_required' });
        await expect(service.status('vendor')).resolves.toEqual({ state: 'unsupported', id: 'vendor', code: 'plugin_managed_dependency_vendor_recipe_required' });
        await expect(service.status('package')).resolves.toEqual({ state: 'unsupported', id: 'package', code: 'plugin_managed_dependency_source_unsupported' });
        await expect(service.status('runtime')).resolves.toEqual({ state: 'unsupported', id: 'runtime', code: 'plugin_managed_dependency_source_unsupported' });
        await expect(host.resolveExecutable({ kind: 'managedDependency', id: 'manual' }, 'acme.plugin'))
            .rejects.toMatchObject({ code: 'plugin_managed_dependency_manual_required' });
        expect(resolveAdapter).not.toHaveBeenCalled();
    });

    it('single-flights ensure while caller cancellation detaches without cancelling shared installation', async () => {
        let finishInstall!: () => void;
        const install = vi.fn(() => new Promise<Readonly<{ ok: true; logPath: string }>>((resolve) => {
            finishInstall = () => resolve({ ok: true, logPath: '/redacted/install.log' });
        }));
        let installed = false;
        const host = hostFor([descriptor('tool')], async () => adapter('tool', {
            detectLaunchResolution: async () => ({
                availability: installed ? { ok: true } : { ok: false, errorMessage: 'missing' },
                canAutoInstall: true,
                canBackgroundAutoUpdate: false,
            }),
            installOrUpgrade: async () => {
                const result = await install();
                installed = true;
                return result;
            },
        }));
        const service = host.bind('acme.plugin');
        const cancelled = new AbortController();
        const first = service.ensure('tool', { signal: cancelled.signal });
        const second = service.ensure('tool');
        await vi.waitFor(() => expect(install).toHaveBeenCalledTimes(1));
        cancelled.abort();
        await expect(first).rejects.toMatchObject({ code: 'plugin_managed_dependency_aborted' });
        finishInstall();
        await expect(second).resolves.toMatchObject({ state: 'ready', sourceId: 'managed' });
        expect(install).toHaveBeenCalledTimes(1);
    });

    it('does not bind status or mutation work for an already-aborted caller', async () => {
        const detectLaunchResolution = vi.fn(async () => ({
            availability: { ok: false as const, errorMessage: 'missing' },
            canAutoInstall: true,
            canBackgroundAutoUpdate: false,
        }));
        const installOrUpgrade = vi.fn(async () => ({ ok: true as const, logPath: '/redacted/install.log' }));
        const host = hostFor([descriptor('tool')], async () => adapter('tool', {
            detectLaunchResolution,
            installOrUpgrade,
        }));
        const service = host.bind('acme.plugin');
        const cancelled = new AbortController();
        cancelled.abort();

        await expect(service.status('tool', { signal: cancelled.signal }))
            .rejects.toMatchObject({ code: 'plugin_managed_dependency_aborted' });
        await expect(service.ensure('tool', { signal: cancelled.signal }))
            .rejects.toMatchObject({ code: 'plugin_managed_dependency_aborted' });
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(detectLaunchResolution).not.toHaveBeenCalled();
        expect(installOrUpgrade).not.toHaveBeenCalled();
    });

    it('normalizes adapter mutation and removal failures without leaking boundary details', async () => {
        const mutationHost = hostFor([descriptor('tool')], async () => adapter('tool', {
            detectLaunchResolution: async () => ({
                availability: { ok: false, errorMessage: 'missing' },
                canAutoInstall: true,
                canBackgroundAutoUpdate: false,
            }),
            installOrUpgrade: async () => { throw new Error('credential=super-secret'); },
        }));
        const removalHost = hostFor(
            [descriptor('tool')],
            async () => adapter('tool'),
            vi.fn(async () => { throw new Error('path=/private/plugin-home'); }),
        );

        await expect(mutationHost.bind('acme.plugin').ensure('tool')).rejects.toMatchObject({
            code: 'plugin_managed_dependency_install_failed',
            message: expect.not.stringContaining('super-secret'),
        });
        await expect(removalHost.bind('acme.plugin').remove('tool')).rejects.toMatchObject({
            code: 'plugin_managed_dependency_remove_failed',
            message: expect.not.stringContaining('/private/plugin-home'),
        });
    });

    it('refuses removal while an executable lease is active and removes only after release', async () => {
        const removeManagedInstall = vi.fn(async () => {});
        const host = hostFor([descriptor('tool')], async () => adapter('tool'), removeManagedInstall);
        const service = host.bind('acme.plugin');
        const executable = await host.resolveExecutable({ kind: 'managedDependency', id: 'tool' }, 'acme.plugin');

        await expect(service.remove('tool')).rejects.toMatchObject({ code: 'plugin_managed_dependency_in_use' });
        expect(removeManagedInstall).not.toHaveBeenCalled();
        executable.release();
        await service.remove('tool');
        expect(removeManagedInstall).toHaveBeenCalledWith(expect.objectContaining({ descriptor: expect.objectContaining({ key: 'tool' }) }));
    });

    it('reserves an executable lease before asynchronous resolution can race removal', async () => {
        let finishResolution!: () => void;
        const resolution = new Promise<void>((resolve) => {
            finishResolution = resolve;
        });
        const removeManagedInstall = vi.fn(async () => {});
        const host = hostFor([descriptor('tool')], async () => adapter('tool', {
            resolveLaunchCommand: async () => {
                await resolution;
                return { ok: true, command: '/managed/tool', args: [], source: 'managed' };
            },
        }), removeManagedInstall);
        const service = host.bind('acme.plugin');

        const resolving = host.resolveExecutable({ kind: 'managedDependency', id: 'tool' }, 'acme.plugin');
        await vi.waitFor(() => expect(removeManagedInstall).not.toHaveBeenCalled());
        await expect(service.remove('tool')).rejects.toMatchObject({ code: 'plugin_managed_dependency_in_use' });
        finishResolution();
        const executable = await resolving;
        executable.release();

        expect(removeManagedInstall).not.toHaveBeenCalled();
    });

    it('single-flights concurrent removals of the same managed install', async () => {
        let finishRemoval!: () => void;
        const removal = new Promise<void>((resolve) => {
            finishRemoval = resolve;
        });
        const removeManagedInstall = vi.fn(async () => await removal);
        const host = hostFor([descriptor('tool')], async () => adapter('tool'), removeManagedInstall);
        const service = host.bind('acme.plugin');

        const first = service.remove('tool');
        const second = service.remove('tool');
        await vi.waitFor(() => expect(removeManagedInstall).toHaveBeenCalledTimes(1));
        finishRemoval();

        await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
        expect(removeManagedInstall).toHaveBeenCalledTimes(1);
    });

    it('keeps status and removal single-flights owned after the first caller aborts', async () => {
        let finishDetection!: () => void;
        const detection = new Promise<void>((resolve) => {
            finishDetection = resolve;
        });
        let finishRemoval!: () => void;
        const removal = new Promise<void>((resolve) => {
            finishRemoval = resolve;
        });
        const detectLaunchResolution = vi.fn(async () => {
            await detection;
            return {
                availability: { ok: true as const },
                canAutoInstall: false,
                canBackgroundAutoUpdate: false,
            };
        });
        const removeManagedInstall = vi.fn(async () => await removal);
        const host = hostFor([descriptor('tool')], async () => adapter('tool', {
            detectLaunchResolution,
        }), removeManagedInstall);
        const service = host.bind('acme.plugin');

        const statusAbort = new AbortController();
        const firstStatus = service.status('tool', { signal: statusAbort.signal });
        const secondStatus = service.status('tool');
        await vi.waitFor(() => expect(detectLaunchResolution).toHaveBeenCalledTimes(1));
        statusAbort.abort();
        await expect(firstStatus).rejects.toMatchObject({ code: 'plugin_managed_dependency_aborted' });
        const thirdStatus = service.status('tool');
        expect(detectLaunchResolution).toHaveBeenCalledTimes(1);
        finishDetection();
        await expect(Promise.all([secondStatus, thirdStatus])).resolves.toHaveLength(2);
        expect(detectLaunchResolution).toHaveBeenCalledTimes(1);

        const removalAbort = new AbortController();
        const firstRemoval = service.remove('tool', { signal: removalAbort.signal });
        const secondRemoval = service.remove('tool');
        await vi.waitFor(() => expect(removeManagedInstall).toHaveBeenCalledTimes(1));
        removalAbort.abort();
        await expect(firstRemoval).rejects.toMatchObject({ code: 'plugin_managed_dependency_aborted' });
        const thirdRemoval = service.remove('tool');
        expect(removeManagedInstall).toHaveBeenCalledTimes(1);
        finishRemoval();
        await expect(Promise.all([secondRemoval, thirdRemoval])).resolves.toEqual([undefined, undefined]);
        expect(removeManagedInstall).toHaveBeenCalledTimes(1);
    });

    it('does not let an ensure single-flight swallow a concurrent explicit update', async () => {
        let installed = false;
        const installOrUpgrade = vi.fn(async () => {
            installed = true;
            return { ok: true as const, logPath: '/redacted/install.log' };
        });
        const host = hostFor([descriptor('tool')], async () => adapter('tool', {
            detectCapabilityStatus: async () => installed
                ? { installedVersion: '2.0.0' }
                : { installedVersion: '1.0.0', availableVersion: '2.0.0' },
            installOrUpgrade,
        }));
        const service = host.bind('acme.plugin');

        const [ensured, updated] = await Promise.all([
            service.ensure('tool'),
            service.update('tool'),
        ]);

        expect(ensured).toMatchObject({ state: 'ready', version: '1.0.0' });
        expect(updated).toMatchObject({ state: 'ready', version: '2.0.0' });
        expect(installOrUpgrade).toHaveBeenCalledTimes(1);
    });

    it('does not report an update as ready when post-install detection still reports the old version', async () => {
        const installOrUpgrade = vi.fn(async () => ({ ok: true as const, logPath: '/redacted/install.log' }));
        const host = hostFor([descriptor('tool')], async () => adapter('tool', {
            detectCapabilityStatus: async () => ({ installedVersion: '1.0.0', availableVersion: '2.0.0' }),
            installOrUpgrade,
        }));

        await expect(host.bind('acme.plugin').update('tool')).rejects.toMatchObject({
            code: 'plugin_managed_dependency_update_unverified',
        });
        expect(installOrUpgrade).toHaveBeenCalledTimes(1);
    });

    it('rejects executable substitution across plugin ownership boundaries', async () => {
        const host = hostFor([descriptor('tool')], async () => adapter('tool'));

        await expect(host.resolveExecutable({
            kind: 'managedDependency',
            id: { pluginId: 'other.plugin', localId: 'tool' },
        }, 'acme.plugin')).rejects.toMatchObject({ code: 'plugin_managed_dependency_undeclared' });
    });

    it('isolates the same local dependency id across plugins and rejects legacy/V2 ownership collisions', async () => {
        const host = v2Host({
            contributions: [
                v2Contribution('acme.one', 'tool', [{ kind: 'system', executableNames: ['one'] }]),
                v2Contribution('acme.two', 'tool', [{ kind: 'system', executableNames: ['two'] }]),
            ],
            resolveSourceAdapter: async ({ dependency }) => adapter(dependency.identity.pluginId, {
                resolveLaunchCommand: async () => ({
                    ok: true,
                    command: `/usr/bin/${dependency.identity.pluginId}`,
                    args: [],
                    source: 'system',
                }),
            }),
        });

        await expect(host.bind('acme.one').status('tool')).resolves.toMatchObject({ sourceId: 'acme.one/tool#0' });
        await expect(host.bind('acme.two').status('tool')).resolves.toMatchObject({ sourceId: 'acme.two/tool#0' });

        expect(() => v2Host({
            contributions: [v2Contribution('acme.plugin', 'tool', [{ kind: 'system', executableNames: ['tool'] }])],
            legacyDescriptors: [descriptor('tool')],
            resolveSourceAdapter: async () => adapter('tool'),
        })).toThrowError(expect.objectContaining({ code: 'plugin_managed_dependency_identity_conflict' }));
    });
    it('keeps one owner for a projected pinned-archive dependency and pins its immutable source occurrenceId', () => {
        const host = v2Host({
            contributions: [v2Contribution('acme.dependency', 'pinned-tool', [{
                kind: 'pinnedArchive',
                installId: 'dep.acme.pinned-tool',
                version: '4.5.6',
                archiveExtractionLimits: {
                    maxArchiveBytes: 1024,
                    maxFileBytes: 2048,
                    maxExpandedBytes: 4096,
                    timeoutMs: 10_000,
                },
                assetsByPlatform: {
                    'linux-x64': {
                        archiveUrl: 'https://downloads.example.test/pinned-tool-4.5.6-linux-x64.zip',
                        sha256: 'c'.repeat(64),
                        executableSubpath: 'bin/pinned-tool',
                    },
                },
            }])],
            // The projected installables descriptor must not become a second legacy owner:
            // the legacy resolver throws if anything routes through it.
            resolveSourceAdapter: async () => adapter('pinned-tool'),
            sourceCustodiesByPluginId: new Map([
                ['acme.dependency', {
                    kind: 'managed',
                    immutableGenerationId: 'immutable-dependency-p',
                    installSource: 'localPath',
                }],
            ]),
        });
        const retained = retainedRunnerInputs({
            pluginId: 'acme.agent',
            immutableGenerationId: 'immutable-agent-p',
            executableIds: [{ pluginId: 'acme.dependency', localId: 'pinned-tool' }],
        });

        expect(host.snapshotRunnerRetention(
            retained.binding,
            retained.hostAccessRequests,
        )).toEqual({
            v: 1,
            sourceCustodies: [{
                kind: 'managed',
                immutableGenerationId: 'immutable-dependency-p',
                installSource: 'localPath',
            }],
            qualifiedDependencyIds: ['acme.dependency/pinned-tool'],
            sourceCandidates: [{
                qualifiedDependencyId: 'acme.dependency/pinned-tool',
                sourceCustody: {
                    kind: 'managed',
                    immutableGenerationId: 'immutable-dependency-p',
                    installSource: 'localPath',
                },
                manifestAuthority: 'external',
            }],
        });
    });
});
