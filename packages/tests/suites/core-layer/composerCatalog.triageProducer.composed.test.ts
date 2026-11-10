import { describe, expect, it } from 'vitest';
import { PLUGIN_MANIFEST } from '@happier-dev/plugins-triage/manifest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import type { RpcHandler, RpcHandlerRegistrar } from '../../../../apps/cli/src/api/rpc/types';
import { createAdmittedPluginRuntimeFixture } from '../../../../apps/cli/src/plugins/testkit/admittedRuntime';
import { createActionSettingsProvider } from '../../../../apps/cli/src/settings/actionsSettingsProvider';
import { parseDaemonContributionRegistryProjectionDescribeResponse } from '../../../../apps/ui/sources/sync/api/daemon/daemonContributionRegistryProjectionProtocol';

import { registerDaemonContributionRegistryProjectionHandler } from '../../../../apps/cli/src/rpc/handlers/daemonContributionRegistryProjection';

describe('Composer catalog through admitted bundled runtime and UI ingress', () => {
    it('preserves the real Triage attachment picker and its current target points', async () => {
        const pluginId = PLUGIN_MANIFEST.id;
        const attachment = PLUGIN_MANIFEST.contributes.composerAttachments.find(entry => entry.id === 'entry');
        if (!attachment?.picker) throw new Error('Current Triage declaration has no entry attachment picker');

        const fixture = await createAdmittedPluginRuntimeFixture({
            runtimeOptions: {
                pluginIds: [pluginId],
                // This projection has no Account work; never acquire ambient credentials.
                scopedActionRuntime: { credentials: null, actionsSettingsProvider: createActionSettingsProvider() },
                resolveCurrentMachineExecutionOriginContext: async () => ({
                    serverIdentityId: 'srv_composer_catalog', machineId: 'machine-composer-catalog',
                }),
            },
        });
        try {
            const occurrenceId = fixture.registry.readPluginOccurrenceId?.(pluginId);
            expect(occurrenceId).toBeTruthy();
            expect(fixture.registry.contributes.composerAttachments.find(entry => entry.pluginId === pluginId
                && entry.definition.id === attachment.id)?.definition.picker).toEqual(attachment.picker);
            const points = fixture.registry.contributes.pluginContributionPoints
                .filter(point => point.pluginId === pluginId)
                .map(point => ({ pointId: point.definition.id,
                    protocols: point.definition.protocols.map(protocol => ({ id: protocol.id, version: protocol.version })) }));
            expect(points.length).toBeGreaterThan(0);

            const handlers = new Map<string, RpcHandler>();
            const registrar: RpcHandlerRegistrar = {
                registerHandler(method, handler) { handlers.set(method, handler); },
            };
            registerDaemonContributionRegistryProjectionHandler(registrar, {
                resolveGeneration: async () => fixture.registry.generation,
                resolveRuntimeRegistry: async () => fixture.registry,
                resolveInstalledPackages: async () => [],
                resolvePluginProjectionExecutionOriginContext: async () => ({
                    serverIdentityId: 'srv_composer_catalog', machineId: 'machine-composer-catalog',
                }),
            });
            const describeProjection = handlers.get(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE);
            if (!describeProjection) throw new Error('Registered daemon describe handler is missing');
            const raw = await describeProjection({ machineId: 'machine-composer-catalog' });
            const response = parseDaemonContributionRegistryProjectionDescribeResponse(raw);
            expect(response).not.toBeNull();
            const picker = response?.composerSurfaceCatalog?.find(entry => entry.contribution.pluginId === pluginId
                && entry.contribution.localId === attachment.id && entry.role === 'attachmentPicker');

            expect(picker).toMatchObject({
                contribution: { pluginId, localId: attachment.id },
                occurrenceId,
                projectionGeneration: fixture.registry.generation,
                role: 'attachmentPicker',
                contributorTargetedContributions: { target: {
                    pluginId, occurrenceId, sourceCustody: fixture.registry.readPluginSourceCustody?.(pluginId),
                } },
            });
            const projectedPoints = picker?.contributorTargetedContributions.points.map(point => ({
                pointId: point.pointId,
                protocols: point.protocols.map(protocol => protocol.protocol),
            }));
            expect(projectedPoints).toHaveLength(points.length);
            expect(projectedPoints).toEqual(expect.arrayContaining(points));
        } finally {
            await fixture.dispose();
        }
    });
});
