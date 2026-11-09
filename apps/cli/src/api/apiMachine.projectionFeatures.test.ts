import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { FeaturesResponseSchema } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { ApiClient } from './api';
import { RpcHandlerManager } from './rpc/RpcHandlerManager';
import { configuration } from '@/configuration';
import { createServerFeaturesSnapshotStore } from '@/features/serverFeaturesSnapshotStore';
import * as persistence from '@/persistence';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';

describe('machine projection reads the incumbent daemon feature snapshot', () => {
    let fixture: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>>;
    beforeAll(async () => {
        // Credential persistence is an OS boundary; no ambient Account enters the fixture.
        const credentials = vi.spyOn(persistence, 'readStoredCredentials').mockResolvedValue(null);
        try {
            fixture = await createAdmittedPluginRuntimeFixture({
                happyHomeDir: configuration.happyHomeDir,
                controller: pluginReloadController,
                runtimeOptions: { contributes: createResolvedContributionRegistry({}), pluginIds: [] },
            });
        } finally { credentials.mockRestore(); }
    });
    afterAll(async () => { await fixture?.dispose(); });

    it('does not multiply feature acquisition/reconciliation by manifest and section pages', async () => {
        let featureFetches = 0;
        let authenticatedReconciliations = 0;
        const store = createServerFeaturesSnapshotStore({
            // The feature HTTP acquisition is the genuine system boundary.
            fetchSnapshot: async () => {
                featureFetches += 1;
                return { status: 'ready', provenance: 'authenticated', features: FeaturesResponseSchema.parse({ features: {} }) };
            },
            onAuthenticatedReady: () => { authenticatedReconciliations += 1; },
        });
        await store.refresh();
        const api = await ApiClient.create({ token: 'fixture-token', encryption: { type: 'legacy', secret: new Uint8Array(32) } });
        api.setServerFeaturesSnapshotProvider(store.getSnapshot, store.refresh);
        const machine = await api.machineSyncClient({
            id: 'projection-feature-machine', encryptionMode: 'plain', metadata: null,
            metadataVersion: 0, daemonState: null, daemonStateVersion: 0,
        }, undefined, { resolveServerFeaturesSnapshot: store.refresh });
        // Observe the existing private transport owner, not a second test-only dispatch path.
        const rpc: unknown = Reflect.get(machine, 'rpcHandlerManager');
        expect(rpc).toBeInstanceOf(RpcHandlerManager);
        if (!(rpc instanceof RpcHandlerManager)) throw new Error('Missing machine RPC owner');
        const request = { machineId: 'projection-feature-machine', deferredSections: true };
        const manifest = await rpc.invokeLocal(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE, request);
        expect(manifest).toMatchObject({ protocolVersion: 1, deferredSections: true });
        const sections: unknown = Reflect.get(manifest as object, 'sections');
        if (!sections || typeof sections !== 'object') throw new Error('Missing deferred sections');
        const digest: unknown = Reflect.get(sections, 'base');
        expect(typeof digest).toBe('string');
        const page = await rpc.invokeLocal(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE,
            { ...request, sectionRead: { digest, offset: 0 } });
        expect(page).toMatchObject({ digest, offset: 0 });
        expect({ featureFetches, authenticatedReconciliations }).toEqual({ featureFetches: 1, authenticatedReconciliations: 1 });
        // Fresh acquisition remains available to its lifecycle owner, not a per-page obligation.
        await store.refresh();
        expect({ featureFetches, authenticatedReconciliations }).toEqual({ featureFetches: 2, authenticatedReconciliations: 2 });
        // A cold/retired provider is still authoritative: do not fetch around its absence.
        api.setServerFeaturesSnapshotProvider(() => undefined, store.refresh);
        await expect(rpc.invokeLocal(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE, request))
            .resolves.toMatchObject({ protocolVersion: 1, deferredSections: true });
        expect({ featureFetches, authenticatedReconciliations }).toEqual({ featureFetches: 2, authenticatedReconciliations: 2 });
    });
});
