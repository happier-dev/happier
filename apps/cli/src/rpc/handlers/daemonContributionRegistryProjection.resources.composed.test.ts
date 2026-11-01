import { expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { resolveExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { logger } from '@/ui/logger';
import { registerDaemonContributionRegistryProjectionHandler } from './daemonContributionRegistryProjection';

it('keeps declared reads across retained activation replacement and identifies an undeclared ref without its payload', async () => {
    const pluginId = 'acme.resource-continuity';
    const fixture = await createAuthoredAdmittedPluginRuntimeFixture({ plugins: [{
        manifest: createPluginManifestV2Fixture({ id: pluginId, contributes: { resources: [{
            id: 'status', kind: 'asset', path: 'status.txt', contentType: 'text/plain',
        }] } }),
        files: { 'daemon.mjs': 'export function activate() {}', 'status.txt': 'private resource contents' },
    }] });
    let registry = fixture.registry;
    let successor: Awaited<ReturnType<typeof resolveExecutablePluginRuntimeRegistry>> | undefined;
    // File logging is an OS boundary; keep the actual RPC, admission and Resource owners.
    const diagnostics = vi.spyOn(logger, 'infoFile').mockImplementation(() => {});
    const rpc = new RpcHandlerManager({ scopePrefix: 'resource-machine', encryptionMode: 'plain', logger: () => {} });
    registerDaemonContributionRegistryProjectionHandler(rpc, {
        resolveRuntimeRegistry: async () => registry,
        resolveGeneration: async () => registry.generation,
        resolveInstalledPackages: async () => [],
    });
    const occurrenceId = fixture.registry.readPluginOccurrenceId?.(pluginId);
    if (!occurrenceId) throw new Error('Missing admitted Resource occurrence');
    const read = (localId: string, expectedCallerOccurrenceId = occurrenceId) => rpc.invokeLocal(
        RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_READ, {
            machineId: 'resource-machine', callerPluginId: pluginId, expectedCallerOccurrenceId,
            resource: { pluginId, localId },
        });
    try {
        const original = await read('status');
        expect(original).toMatchObject({ ok: true, bytesBase64: Buffer.from('private resource contents').toString('base64') });
        const component = fixture.registry.retainPluginActivationComponent?.(pluginId);
        if (!component) throw new Error('Missing retained Resource activation');
        successor = await resolveExecutablePluginRuntimeRegistry({
            happyHomeDir: fixture.happyHomeDir, contributes: fixture.registry.contributes,
            generationAuthority: fixture.committed, generation: fixture.registry.generation + 1,
            pluginIds: [pluginId], retainedActivationRegistryLeases: [component],
        });
        registry = successor;
        await fixture.registry.dispose();
        expect(await read('status')).toEqual(original);
        expect(await read('status', 'replaced-occurrence')).toMatchObject({
            ok: false, code: 'plugin_occurrence_stale', reason: 'stale_occurrence',
        });
        expect(await read('no-longer-declared')).toMatchObject({
            ok: false, code: 'plugin_resource_not_found', reason: 'not_found',
        });
        const refusals = diagnostics.mock.calls.filter(([message]) => message === '[PLUGIN RESOURCE] Read refused');
        expect(refusals).toContainEqual(['[PLUGIN RESOURCE] Read refused', {
            callerPluginId: pluginId, resourcePluginId: pluginId, resourceId: 'no-longer-declared',
            expectedCallerOccurrenceId: occurrenceId, generation: successor.generation,
            code: 'plugin_resource_not_found', reason: 'not_found',
        }]);
        expect(JSON.stringify(refusals)).not.toContain('private resource contents');
    } finally {
        diagnostics.mockRestore();
        await successor?.dispose();
        await fixture.dispose();
    }
});
