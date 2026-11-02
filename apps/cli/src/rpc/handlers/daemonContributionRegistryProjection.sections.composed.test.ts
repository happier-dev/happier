import { expect, it } from 'vitest';
import {
    DaemonProjectionDeferredSectionsResponseSchema,
    DaemonProjectionSectionBodyResponseSchema,
    DaemonContributionRegistryProjectionSectionsResponseSchema, reassembleDaemonProjectionSections,
} from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import {
    invalidateDaemonContributionRegistryProjectionCache,
    registerDaemonContributionRegistryProjectionHandler,
} from './daemonContributionRegistryProjection';

it.each(['generation', 'activation diagnostics', 'another handler', 'projection invalidation'] as const)(
    'finishes advertised projection sections when %s changes before the next page', async change => {
        const pluginId = 'acme.section-continuity';
        const fixture = await createAuthoredAdmittedPluginRuntimeFixture({ coldStart: true, plugins: [{
            manifest: createPluginManifestV2Fixture({ id: pluginId, contributes: { actions: [{
                id: 'probe', title: 'Probe', scopes: ['global'], surfaces: ['cli'],
                execution: { target: 'daemon' }, dangerLevel: 'safe', placementBindings: [],
            }] } }),
            files: { 'daemon.mjs': 'export function activate() { throw new Error("fixture activation unavailable"); }' },
        }] });
        let generation = fixture.registry.generation;
        const rpc = new RpcHandlerManager({ scopePrefix: 'section-machine', encryptionMode: 'plain', logger: () => {} });
        registerDaemonContributionRegistryProjectionHandler(rpc, {
            resolveRuntimeRegistry: async () => fixture.registry,
            resolveGeneration: async () => generation,
            resolveInstalledPackages: async () => [],
            resolveServerFeaturesSnapshot: () => undefined,
        });
        const request = { machineId: 'section-machine', deferredSections: true, supportedSectionFrameVersions: [2] };
        const read = (extra: object = {}) => rpc.invokeLocal(
            RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE, { ...request, ...extra });
        try {
            invalidateDaemonContributionRegistryProjectionCache();
            const manifest = DaemonProjectionDeferredSectionsResponseSchema.parse(await read());
            const pageRequest = { sectionFrameVersion: 2,
                sectionRead: { digest: manifest.sections.base!, offset: 0 } };
            const original = DaemonProjectionSectionBodyResponseSchema.parse(await read(pageRequest));
            if (change === 'activation diagnostics') {
                await fixture.registry.activateContributionsOnDemand([{ pluginId, family: 'actions', localId: 'probe' }]);
                expect(fixture.registry.targetActivationFacts).toEqual(expect.arrayContaining([
                    expect.objectContaining({ pluginId, status: 'unavailable' }),
                ]));
            } else {
                generation += 1;
                if (change === 'projection invalidation') {
                    invalidateDaemonContributionRegistryProjectionCache();
                }
                if (change === 'another handler') {
                    const peer = new RpcHandlerManager({ scopePrefix: 'peer-machine', encryptionMode: 'plain', logger: () => {} });
                    registerDaemonContributionRegistryProjectionHandler(peer, {
                        resolveRuntimeRegistry: async () => fixture.registry,
                        resolveGeneration: async () => generation + 1,
                        resolveInstalledPackages: async () => [],
                        resolveServerFeaturesSnapshot: () => undefined,
                    });
                    DaemonProjectionDeferredSectionsResponseSchema.parse(await peer.invokeLocal(
                        RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE,
                        { ...request, machineId: 'peer-machine' }));
                }
            }
            expect(DaemonProjectionSectionBodyResponseSchema.parse(await read(pageRequest))).toEqual(original);
            const current = DaemonProjectionDeferredSectionsResponseSchema.parse(await read());
            expect(current.projectionDigest).not.toBe(manifest.projectionDigest);
            expect(DaemonProjectionSectionBodyResponseSchema.safeParse(await read({ sectionFrameVersion: 2,
                sectionRead: { digest: current.sections.base!, offset: 0 } })).success).toBe(true);
        } finally {
            invalidateDaemonContributionRegistryProjectionCache();
            await fixture.dispose();
        }
    },
);
