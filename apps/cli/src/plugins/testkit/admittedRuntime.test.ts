import { describe, expect, it, vi } from 'vitest';

import { loadInstalledPlugins } from '@/plugins/discovery/load/installed';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import * as contributionResolution from '@/plugins/projection/registry/resolvePluginContributions';
import { projectLoadedPluginContributes } from '@/plugins/projection/registry/fullProjection';
import { createPluginReloadController } from '@/plugins/runtime/reload/controller';
import { createAdmittedPluginRuntimeFixture, createAuthoredAdmittedPluginRuntimeFixture, retireAdmittedPluginRuntimeRegistry } from './admittedRuntime';
import { createPluginManifestV2Fixture } from './manifestV2Fixture';
import { definePlugin, type PluginDaemonDatabaseDefinition } from '@happier-dev/plugin-sdk';
import { DEFAULT_PLUGIN_DAEMON_DATABASE_LIMITS_POLICY } from '@/plugins/runtime/context/daemonDatabaseLimitsPolicy';

const isolatedPluginId = 'acme.isolated-runtime';
const isolatedPlugin = (version: string) => ({
    manifest: createPluginManifestV2Fixture({ id: isolatedPluginId, version }),
    files: { 'daemon.mjs': 'export function activate() {}' },
});

async function resolveIsolatedContributes(happyHomeDir: string) {
    const loadResult = await loadInstalledPlugins({ happyHomeDir });
    expect(loadResult.loadedPlugins.map(plugin => plugin.pluginId)).toEqual([isolatedPluginId]);
    return createResolvedContributionRegistry(projectLoadedPluginContributes({
        loadResult,
        provenance: 'external',
    }));
}

describe('admitted runtime fixture controller lifetime', () => {
    it('prepares authored daemon databases and preserves records across background service replacement', async () => {
        const starts = [0, 1].map(() => Promise.withResolvers<readonly Readonly<Record<string, unknown>>[]>());
        let activation = 0;
        // The real background owner reports startup failures asynchronously.
        for (const started of starts) void started.promise.catch(() => undefined);
        const database: PluginDaemonDatabaseDefinition = {
            migrations: [{ version: 1, id: 'records', async up(tx) {
                await tx.execute('CREATE TABLE records (id TEXT PRIMARY KEY, at INTEGER NOT NULL)');
            } }],
            incumbentQueryFixture: { id: 'records-readable', async run(tx) {
                await tx.query('SELECT id FROM records');
            } },
            retention: [{ table: 'records', timeColumn: 'at' }],
        };
        const plugin = definePlugin({ id: isolatedPluginId, version: '1.0.0', entrypoints: { daemon: './daemon.mjs' },
            daemonDatabases: { index: database },
            backgroundServices: [{ declaration: { id: 'writer', title: 'Write records', placement: 'daemon', activation: 'continuous' },
                async runner(context) {
                    const started = starts[activation++];
                    try {
                        const store = await context.services.storage.daemon.database('index', { ...database, signal: context.signal });
                        await store.execute('INSERT INTO records(id,at) VALUES(?,?)', [`ready-${activation}`, activation]);
                        started.resolve(await store.query('SELECT id FROM records ORDER BY id'));
                        await new Promise<void>(resolve => {
                            if (context.signal.aborted) resolve();
                            else context.signal.addEventListener('abort', () => resolve(), { once: true });
                        });
                    } catch (error) { started.reject(error); throw error; }
                } }],
        });
        let fixture: Awaited<ReturnType<typeof createAuthoredAdmittedPluginRuntimeFixture>> | undefined;
        let replacement: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>> | undefined;
        vi.stubEnv('HAPPIER_CLI_SUBPROCESS_PREFER_TSX', '1');
        try {
            fixture = await createAuthoredAdmittedPluginRuntimeFixture({
                plugins: [{ manifest: plugin.manifest, files: { 'daemon.mjs': 'export function activate() {}' },
                    instantiateCommittedModule: () => plugin }],
                resolveContributes: resolveIsolatedContributes,
                runtimeOptions: { daemonDatabaseLimits: DEFAULT_PLUGIN_DAEMON_DATABASE_LIMITS_POLICY },
            });
            await expect(starts[0].promise).resolves.toEqual([{ id: 'ready-1' }]);
            replacement = await createAdmittedPluginRuntimeFixture({
                happyHomeDir: fixture.happyHomeDir,
                controller: fixture.controller,
                runtimeOptions: {
                    contributes: fixture.registry.contributes,
                    pluginIds: [isolatedPluginId],
                    generationAuthority: fixture.committed,
                    preparedActivationGraphsByPluginId: fixture.preparedActivationGraphsByPluginId,
                    daemonDatabaseLimits: DEFAULT_PLUGIN_DAEMON_DATABASE_LIMITS_POLICY,
                },
            });
            await expect(starts[1].promise).resolves.toEqual([{ id: 'ready-1' }, { id: 'ready-2' }]);
        } finally {
            try {
                await replacement?.dispose();
                await fixture?.dispose();
            } finally { vi.unstubAllEnvs(); }
        }
    });

    it('keeps an isolated resolver authoritative across replacement and retirement', async () => {
        // Observe real default resolution without replacing internal logic.
        const defaultResolution = vi.spyOn(contributionResolution, 'resolvePluginContributes');
        const controller = createPluginReloadController();
        let first: Awaited<ReturnType<typeof createAuthoredAdmittedPluginRuntimeFixture>> | undefined;
        let replacement: typeof first;
        try {
            first = await createAuthoredAdmittedPluginRuntimeFixture({
                controller,
                plugins: [isolatedPlugin('1.0.0')],
                resolveContributes: resolveIsolatedContributes,
            });
            expect(first.registry.contributes.activationTargets.map(target => target.pluginId)).toEqual([isolatedPluginId]);
            replacement = await createAuthoredAdmittedPluginRuntimeFixture({
                happyHomeDir: first.happyHomeDir,
                controller,
                plugins: [{ ...isolatedPlugin('2.0.0'), replaceExisting: true }],
                resolveContributes: resolveIsolatedContributes,
            });
            expect(replacement.registry.contributes.activationTargets).toMatchObject([{ pluginId: isolatedPluginId, manifest: { version: '2.0.0' } }]);
            await replacement.dispose();
            expect(controller.isRuntimeRegistryCurrent(replacement.registry)).toBe(false);
            expect(controller.getState().activeRegistry?.contributes.activationTargets).toEqual([]);
            expect(defaultResolution).not.toHaveBeenCalled();
        } finally {
            try {
                await replacement?.dispose();
                await first?.dispose();
            } finally {
                await controller.shutdown();
                defaultResolution.mockRestore();
            }
        }
    });

    it('detects a retirement miswired without the isolated generation authority', async () => {
        const defaultResolution = vi.spyOn(contributionResolution, 'resolvePluginContributes');
        const controller = createPluginReloadController();
        let fixture: Awaited<ReturnType<typeof createAuthoredAdmittedPluginRuntimeFixture>> | undefined;
        try {
            fixture = await createAuthoredAdmittedPluginRuntimeFixture({
                controller,
                plugins: [isolatedPlugin('1.0.0')],
                resolveContributes: resolveIsolatedContributes,
            });
            expect(defaultResolution).not.toHaveBeenCalled();
            await retireAdmittedPluginRuntimeRegistry({
                controller, registry: fixture.registry, happyHomeDir: fixture.happyHomeDir,
            });
            expect(defaultResolution).toHaveBeenCalled();
        } finally {
            try {
                await fixture?.dispose();
            } finally {
                await controller.shutdown();
                defaultResolution.mockRestore();
            }
        }
    });

    it('releases each fixture without shutting down its caller-owned controller', async () => {
        const controller = createPluginReloadController();
        const runtimeOptions = { pluginIds: [], contributes: createResolvedContributionRegistry({}) };
        try {
            const first = await createAdmittedPluginRuntimeFixture({ controller, runtimeOptions });
            await first.dispose();
            expect(controller.isRuntimeRegistryCurrent(first.registry)).toBe(false);

            const second = await createAdmittedPluginRuntimeFixture({ controller, runtimeOptions });
            try {
                expect(controller.isRuntimeRegistryCurrent(second.registry)).toBe(true);
            } finally {
                await second.dispose();
            }
        } finally {
            await controller.shutdown();
        }
    });
});
