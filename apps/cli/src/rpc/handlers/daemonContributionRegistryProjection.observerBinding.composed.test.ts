import { afterEach, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { DaemonContributionRegistryProjectionDescribeResponseSchema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import type { RpcHandler, RpcHandlerRegistrar } from '@/api/rpc/types';
import * as persistence from '@/persistence';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { invalidateDaemonContributionRegistryProjectionCache, registerDaemonContributionRegistryProjectionHandler } from './daemonContributionRegistryProjection';

afterEach(() => {
    vi.restoreAllMocks();
    invalidateDaemonContributionRegistryProjectionCache();
});

it('publishes the real machine-services health Event observer assignment from its release-less runtime declaration', async () => {
    // Credential persistence is the system boundary; projection needs no ambient Account credential.
    vi.spyOn(persistence, 'readStoredCredentials').mockResolvedValue(null);
    const pluginId = 'happier.machine.services';
    const machineId = 'eadc2422-b42b-478d-97b1-af9b530d5f08';
    const serverIdentityId = 'srv_health_observer';
    const fixture = await createAdmittedPluginRuntimeFixture({ runtimeOptions: {
        pluginIds: [pluginId],
        resolveCurrentMachineId: () => machineId,
    } });
    try {
        const handlers = new Map<string, RpcHandler>();
        const registrar: RpcHandlerRegistrar = { registerHandler(method, handler) { handlers.set(method, handler); } };
        registerDaemonContributionRegistryProjectionHandler(registrar, {
            resolveRuntimeRegistry: async () => fixture.registry,
            resolveInstalledPackages: async () => [],
            resolvePluginProjectionExecutionOriginContext: async () => ({ machineId, serverIdentityId }),
        });
        const declaration = fixture.registry.readReleaseLessMaterializations?.().find(row => row.pluginId === pluginId);
        expect(declaration).toMatchObject({ version: '0.0.0', enabled: true, trustState: 'trusted' });
        const sourceCustody = fixture.registry.readPluginSourceCustody?.(pluginId);
        expect(sourceCustody).toBeDefined();
        const response = DaemonContributionRegistryProjectionDescribeResponseSchema.parse(await handlers.get(
            RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE,
        )!({ machineId, supportedEventObservationBindingVersions: [1] }));
        expect(response.automationEligibleEvents?.find(entry => entry.event.identity.localId === 'health-check-failed'))
            .toMatchObject({ event: { identity: { pluginId, localId: 'health-check-failed' }, sourceCustody },
                observationBinding: {
                    executionOrigin: { serverIdentityId, sourceRef: { machineId, pluginId, sourceCustody } },
                    materializationRef: { machineId, pluginId, materializationId: declaration?.materializationId },
                } });
    } finally {
        await fixture.dispose();
    }
});
