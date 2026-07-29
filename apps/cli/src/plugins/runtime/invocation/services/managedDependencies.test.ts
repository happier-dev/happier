import { describe, expect, it, vi } from 'vitest';

import type { PluginManagedDependencyContributionV2 } from '@happier-dev/protocol';
import { resolveInstallablesRegistry, type InstallableDependencyDescriptor } from '@happier-dev/protocol/installables';
import { PluginError } from '@happier-dev/plugin-sdk';
import type { RuntimeInstallableAdapter } from '@/packagedRuntime/installables/registry';
import type { ResolvedInstallableContribution } from '@/plugins/projection/registry/types';

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
        manifestPath: `/plugins/${pluginId}/.happier-plugin/plugin.json`, manifestDigest: `sha256:${pluginId}`, daemonEntryPath: null,
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

function v2Host(params: Readonly<{
    contributions: readonly ResolvedInstallableContribution[];
    resolveSourceAdapter: NonNullable<Parameters<typeof createStablePluginManagedDependenciesHost>[0]['resolveSourceAdapter']>;
    removeManagedSource?: NonNullable<Parameters<typeof createStablePluginManagedDependenciesHost>[0]['removeManagedSource']>;
    legacyDescriptors?: readonly InstallableDependencyDescriptor[];
}>) {
    const sourceModel = createV2ManagedDependencySourceModel({
        generationId: 'registry:generation-v2', platform: 'linux', architecture: 'x64',
        contributions: params.contributions,
    });
    return createStablePluginManagedDependenciesHost({
        installablesRegistry: resolveInstallablesRegistry({
            externalPlugins: (params.legacyDescriptors ?? []).map((value) => ({
                owner: { provenance: 'external_plugin', ownerId: `owner:${value.key}`, pluginId: 'acme.plugin' },
                descriptor: value,
            })),
        }),
        sourceModel,
        getSettings: () => ({}),
        resolveAdapter: async () => { throw new Error('legacy adapter must not be used'); },
        resolveSourceAdapter: params.resolveSourceAdapter,
        removeManagedInstall: async () => {},
        removeManagedSource: params.removeManagedSource ?? (async () => {}),
    });
}

describe('stable plugin managed dependencies host', () => {
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
            generationId: 'registry:generation-v2',
            platform: 'linux',
            architecture: 'x64',
            contributions: [{
                provenance: 'external', source: { kind: 'path' }, pluginId: 'acme.plugin',
                manifestPath: '/plugins/acme/.happier-plugin/plugin.json', manifestDigest: 'sha256:acme', daemonEntryPath: null,
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
        const sourceModel = createV2ManagedDependencySourceModel({
            generationId: 'registry:generation-v2', platform: 'linux', architecture: 'x64',
            contributions: [{
                provenance: 'external', source: { kind: 'path' }, pluginId: 'acme.plugin',
                manifestPath: '/plugins/acme/.happier-plugin/plugin.json', manifestDigest: 'sha256:acme', daemonEntryPath: null,
                sourceSpec: { kind: 'path', locator: '/plugins/acme', trustPolicy: 'local_trusted', installPolicy: 'link' },
                definition: {
                    id: 'tool', title: 'Tool', executable: 'tool',
                    sources: [
                        managedPypiSource('dep.acme.tool'),
                        { kind: 'system', executableNames: ['tool'] },
                    ],
                },
            }],
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
            installablesRegistry: resolveInstallablesRegistry({}), sourceModel, getSettings: () => ({}),
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

    it('retires the V2 generation only after executable leases are released', async () => {
        const sourceModel = createV2ManagedDependencySourceModel({
            generationId: 'registry:generation-v2', platform: 'linux', architecture: 'x64',
            contributions: [{
                provenance: 'external', source: { kind: 'path' }, pluginId: 'acme.plugin',
                manifestPath: '/plugins/acme/.happier-plugin/plugin.json', manifestDigest: 'sha256:acme', daemonEntryPath: null,
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

        await expect(host.retireGeneration('registry:generation-v2')).rejects.toMatchObject({ code: 'plugin_managed_dependency_in_use' });
        lease.release();
        await expect(host.retireGeneration('registry:generation-v2')).resolves.toBeUndefined();
        await expect(host.bind('acme.plugin').status('tool')).resolves.toEqual({
            state: 'unsupported', id: 'tool', code: 'plugin_managed_dependency_generation_retired',
        });
    });

    it('rejects retirement requests for a different registry generation', async () => {
        const sourceModel = createV2ManagedDependencySourceModel({
            generationId: 'registry:generation-v2', platform: 'linux', architecture: 'x64', contributions: [],
        });
        const host = createStablePluginManagedDependenciesHost({
            installablesRegistry: resolveInstallablesRegistry({}), sourceModel, getSettings: () => ({}),
            resolveAdapter: async () => { throw new Error('legacy adapter must not be used'); },
            removeManagedInstall: async () => {},
        });

        await expect(host.retireGeneration('registry:wrong-generation')).rejects.toMatchObject({
            code: 'plugin_managed_dependency_generation_mismatch',
        });
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
        ], resolveAdapter);
        const service = host.bind('acme.plugin');

        await expect(service.status('manual')).resolves.toEqual({ state: 'unsupported', id: 'manual', code: 'plugin_managed_dependency_manual_required' });
        await expect(service.status('vendor')).resolves.toEqual({ state: 'unsupported', id: 'vendor', code: 'plugin_managed_dependency_vendor_recipe_required' });
        await expect(service.status('package')).resolves.toEqual({ state: 'unsupported', id: 'package', code: 'plugin_managed_dependency_source_unsupported' });
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
});
