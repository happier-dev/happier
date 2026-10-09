import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ManagedResourceDependencyV1Schema, ManagedResourceDispositionV1Schema } from '@happier-dev/protocol/machines/managed/managedDependencyV1';
import { reloadConfiguration } from '@/configuration';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { createPluginStateStore } from '@/plugins/store/state.testkit';
import type { PluginChangeRequestResult } from '@/plugins/daemon/changeContract';
import { createCliCapabilitiesService } from './capabilities';

const daemonControl = vi.hoisted(() => ({
    requestDaemonPluginChange: vi.fn<typeof import('@/daemon/controlClient').requestDaemonPluginChange>(),
    decideDaemonPluginChange: vi.fn<typeof import('@/daemon/controlClient').decideDaemonPluginChange>(),
}));
const confirm = vi.hoisted(() => vi.fn(async () => false));

// Only daemon HTTP/process startup and terminal interaction cross a system boundary.
// Capability dispatch, the user-change client, registry and schemas remain real.
vi.mock('@/daemon/controlClient', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/daemon/controlClient')>(),
    ...daemonControl,
}));
vi.mock('@/daemon/ensureDaemon', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/daemon/ensureDaemon')>(),
    ensureDaemonRunningForSessionCommand: vi.fn(async () => undefined),
}));
vi.mock('@/terminal/prompts/promptConfirmYesNo', () => ({ promptConfirmYesNo: confirm }));

const pluginId = 'acme.example';
const resource = ManagedResourceDependencyV1Schema.parse({
    managedId: 'managed-review', homeId: 'home', custodianAccountId: 'account', intentRevision: 8,
    controller: { machineId: 'controller', installationId: 'installation' },
    provider: { pluginId, localId: 'cloud' }, allocation: 'may-exist',
    recovery: { reference: 'native-8', reason: 'credential_missing', consoleUrl: 'https://provider.example/native-8' },
});

describe('plugin removal capability', () => {
    let happyHomeDir: string;
    let envScope: ReturnType<typeof createEnvKeyScope>;

    beforeEach(async () => {
        daemonControl.requestDaemonPluginChange.mockReset();
        daemonControl.requestDaemonPluginChange.mockResolvedValue({
            kind: 'committed', pluginId, desiredGeneration: null, appliedGeneration: null, pendingSurfaces: [],
        });
        daemonControl.decideDaemonPluginChange.mockReset();
        confirm.mockClear();
        happyHomeDir = await createTempDir('happier-cli-capabilities-removal-');
        envScope = createEnvKeyScope(['HAPPIER_HOME_DIR']);
        envScope.patch({ HAPPIER_HOME_DIR: happyHomeDir });
        reloadConfiguration();
        await createPluginStateStore({ happyHomeDir }).write({
            t: 'happier_plugin_state_v1', schemaVersion: 1,
            plugins: { [pluginId]: {
                source: { kind: 'path', locator: happyHomeDir, resolvedPath: happyHomeDir,
                    manifestPath: join(happyHomeDir, '.happier-plugin', 'plugin.json'), trustPolicy: 'local_trusted', installPolicy: 'link' },
                compatibility: { status: 'compatible', diagnostics: [] },
                install: { mode: 'link', manifestVersion: '1.0.0' }, state: { enabled: true },
            } },
        });
    });

    afterEach(async () => {
        envScope.restore();
        reloadConfiguration();
        await removeTempDir(happyHomeDir);
    });

    it.each(['disable', 'uninstall'] as const)('preserves the exact managed-resource review and reviewed retry for %s', async (method) => {
        const service = await createCliCapabilitiesService({ readPluginCatalog: async () => [] });
        const review = { kind: 'managedResourcesReviewRequired' as const, pluginId, resources: [resource] };
        daemonControl.requestDaemonPluginChange.mockResolvedValueOnce(review);
        await expect(service.invoke({ id: 'tool.plugins', method, params: { pluginId } }))
            .resolves.toEqual({ ok: true, result: { action: method, pluginId, change: review } });
        expect((await createPluginStateStore({ happyHomeDir }).read()).plugins[pluginId]?.state.enabled).toBe(true);

        const disposition = ManagedResourceDispositionV1Schema.parse({
            managedId: resource.managedId, expectedIntentRevision: resource.intentRevision,
            expectedAllocation: resource.allocation, expectedRecovery: resource.recovery, responsibility: 'manual',
        });
        const committed = { kind: 'committed' as const, pluginId, desiredGeneration: null,
            appliedGeneration: null, pendingSurfaces: [] };
        daemonControl.requestDaemonPluginChange.mockResolvedValueOnce(committed);
        await expect(service.invoke({ id: 'tool.plugins', method,
            params: { pluginId, managedResourceDispositions: [disposition] } }))
            .resolves.toMatchObject({ ok: true, result: { action: method, pluginId, change: committed } });
        expect(daemonControl.requestDaemonPluginChange).toHaveBeenLastCalledWith({
            kind: method, pluginId, managedResourceDispositions: [disposition],
        });
        expect(confirm).not.toHaveBeenCalled();
        expect(daemonControl.decideDaemonPluginChange).not.toHaveBeenCalled();
    });

    it.each(['disable', 'uninstall'] as const)('refuses malformed managed-resource dispositions before %s', async (method) => {
        const service = await createCliCapabilitiesService({ readPluginCatalog: async () => [] });
        await expect(service.invoke({ id: 'tool.plugins', method,
            params: { pluginId, managedResourceDispositions: [{ managedId: resource.managedId, responsibility: 'manual' }] } }))
            .resolves.toMatchObject({ ok: false, error: { code: 'invalid-request' } });
        expect(daemonControl.requestDaemonPluginChange).not.toHaveBeenCalled();
    });

    it.each([
        { kind: 'dataRemovalPartial', pluginId, completed: ['uninstall'], pending: ['daemonStorage', 'secrets'], causeCode: 'storage_unavailable' },
        { kind: 'outcomeUnknown', pluginId },
        { kind: 'conflict', pluginId },
    ] satisfies readonly PluginChangeRequestResult[])('preserves the typed $kind removal outcome without claiming commitment', async (change) => {
        const service = await createCliCapabilitiesService({ readPluginCatalog: async () => [] });
        daemonControl.requestDaemonPluginChange.mockResolvedValueOnce(change);
        await expect(service.invoke({ id: 'tool.plugins', method: 'uninstall', params: { pluginId } }))
            .resolves.toEqual({ ok: true, result: { action: 'uninstall', pluginId, change } });
    });
});
