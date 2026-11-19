import { describe, expect, it, vi } from 'vitest';
import type { PluginApi } from '@happier-dev/plugin-sdk';

import type { BackgroundServiceProcessChannel } from './backgroundServiceProcessChannel';
import { channelBoundary } from './backgroundServiceProcessChannel.testkit';
import { assemblePluginRuntimeActivation } from '../../composition/activationAssembly';
import { resolveExecutablePluginRuntimeRegistry } from '../../resolveExecutablePluginRuntimeRegistry';
import { createPluginReloadController } from '../../reload/controller';
import { ingestCanonicalPluginManifest } from '@/plugins/manifest/ingest';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { createProductionPluginInvocationServiceOwners } from '../../invocation/services/production';
import { bindPluginRuntimeSourceAuthority } from '../../sourceAuthority';

const osBoundary = vi.hoisted(() => ({ spawn: vi.fn<() => Promise<BackgroundServiceProcessChannel>>() }));
// Replace the physical pipe/process boundary, retaining the real manager,
// framing, placement execution, bound services and background lifecycle.
vi.mock('./backgroundServiceProcessChannel', () => ({ spawnBackgroundServiceProcessChannel: osBoundary.spawn }));

describe('background service registry definitive disposal', () => {
    it.each(['activation lease', 'reload shutdown', 'retired registry lease'] as const)(
        'retries retained failed child custody through the same closed %s and runs plugin cleanup once', async (surface) => {
        const pluginId = 'acme.disposal-retry';
        const ingested = ingestCanonicalPluginManifest({
            schemaVersion: 2, id: pluginId, version: '1.0.0', displayName: 'Disposal retry',
            engines: { happier: '^0.3.0' }, runtime: { apiVersion: 1 }, entrypoints: { daemon: './daemon.mjs' },
            contributes: { backgroundServices: [{ id: 'index', placement: 'process', activation: 'demand' }] },
        }, { sourceProvenance: 'registryCustodied' });
        if (!ingested.ok) throw new Error('Expected valid process manifest');
        const custody = { kind: 'development' as const, registeredRootId: 'disposal-retry' };
        const boundary = channelBoundary();
        const failure = new Error('Child custody release unavailable');
        let allowRelease = false;
        osBoundary.spawn.mockClear();
        osBoundary.spawn.mockResolvedValue({ ...boundary.channel, async terminate() {
            if (!allowRelease) throw failure;
            await boundary.channel.terminate();
        } });
        let cleanups = 0;
        const services = createProductionPluginInvocationServiceOwners({ loggerSink: { write() {} } });
        const activation = await assemblePluginRuntimeActivation({
            scopedPluginIds: [pluginId], disposeInvocationServices: () => services.dispose(),
            activationParams: {
            generation: 1, forceActivation: true, invocationServices: services,
            admittedPluginSourceCustodiesByPluginId: new Map([[pluginId, custody]]),
            contributes: createResolvedContributionRegistry({ activationTargets: [{
                provenance: 'first_party', source: { kind: 'bundled' }, pluginId,
                manifestPath: '/virtual/plugin/happier.plugin.json', daemonEntryPath: '/virtual/plugin/daemon.mjs',
                sourceSpec: { kind: 'package', locator: '@happier-dev/disposal-retry', trustPolicy: 'local_trusted', installPolicy: 'copy' },
                activationEvents: [], manifest: ingested.manifest,
            }] }),
            resolveActivationSource: () => ({
                kind: 'bundled', moduleId: '@happier-dev/disposal-retry/daemon',
                sourceAuthority: bindPluginRuntimeSourceAuthority({ custody, resolvedRoot: '/virtual/plugin', observedRevision: 1 }),
                processEntry: { entryPath: '/virtual/plugin/daemon.mjs', rootPath: '/virtual/plugin', loadMode: 'source-ts' },
                load: async () => ({ activate(api: PluginApi) {
                    api.backgroundServices.register('index', async () => {});
                    return () => { cleanups += 1; };
                } }),
            }),
            },
        });
        const registry = activation.activatedRegistry;
        const executable = surface === 'activation lease' ? null : await resolveExecutablePluginRuntimeRegistry({
            contributes: createResolvedContributionRegistry({}), pluginIds: [],
            retainedActivationRegistryLeases: [activation.activationRegistryLease],
        });
        const controller = executable ? createPluginReloadController({ resolveRuntimeRegistry: async () => executable }) : null;
        const lease = await controller?.acquireRuntimeRegistry();
        if (surface === 'reload shutdown') await lease?.release();
        const dispose = () => controller ? controller.shutdown() : activation.activationRegistryLease.release();
        const handle = registry.demandBackgroundService({ pluginId, localId: 'index' });
        const cancelled = expect(handle.settlement).rejects.toMatchObject({ name: 'AbortError' });
        try {
            await vi.waitFor(() => expect(boundary.messages.some(({ kind }) => kind === 'run')).toBe(true));
            if (surface === 'retired registry lease') {
                await expect(executable!.dispose()).rejects.toBe(failure);
                const replacement = await resolveExecutablePluginRuntimeRegistry({
                    contributes: createResolvedContributionRegistry({}), pluginIds: [],
                });
                await controller!.adoptPreparedRuntimeRegistry({
                    registry: replacement, changedPluginIds: [pluginId], durableRevision: 1,
                    runningSessionDisposition: 'retainRunningSessions',
                });
                await expect(lease!.release()).rejects.toBe(failure);
                await expect(lease!.release()).rejects.toBe(failure);
            }
            await expect(dispose()).rejects.toBe(failure);
            expect(boundary.terminated).toBe(false);
            expect(cleanups).toBe(0);
            if (controller) {
                await expect(controller.acquireRuntimeRegistry()).rejects.toMatchObject({ code: 'plugin_runtime_shutdown' });
            } else {
                expect(() => activation.activationRegistryLease.retain()).toThrow();
            }
            allowRelease = true;
            await expect(dispose()).resolves.toBeUndefined();
            expect(boundary.terminated).toBe(true);
            expect(cleanups).toBe(1);
            expect(osBoundary.spawn).toHaveBeenCalledOnce();
            await dispose();
            expect(cleanups).toBe(1);
        } finally {
            allowRelease = true;
            await boundary.channel.terminate();
            await lease?.release().catch(() => undefined);
            await dispose().catch(() => undefined);
            await services.dispose();
            await cancelled;
        }
    });
});
