import { describe, expect, it } from 'vitest';
import { normalizePluginAccountCollectionContractsV1 } from '@happier-dev/protocol/plugins/data/collectionsV1';
import { PluginPortableReleaseManifestV1Schema, PluginAvailabilityActionHttpPathsV1 } from '@happier-dev/protocol/plugins/availability';
import { createPluginAccountAvailabilityReaderStore } from '@/sync/domains/plugins/availability/reader';
import { createActivePluginAccountAvailabilityProjectionHydrator } from './pluginAvailabilityProjection';
import { createPluginAccountCollectionContractBootstrap } from './ensureActivePluginAccountCollectionContract';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';

describe('bundled Account Collection contract bootstrap', () => {
    it('claims the admitted bundled declaration and refreshes canonical facts before admitting cold concurrent readers', async () => {
        const scope = { serverId: 'srv-a', accountId: 'account-a' };
        let current = true;
        const accountLifetime = { scope, isCurrent: () => current, onRetire: () => ({ dispose: () => {} }) };
        let hydrationLifetime = accountLifetime;
        const manifest = PluginPortableReleaseManifestV1Schema.parse({
            schemaVersion: 2, id: 'acme.notes', version: '1.0.0', displayName: 'Notes', runtime: { apiVersion: 1 },
            contributes: { accountCollections: [{ id: 'notes', schemaVersion: 1,
                schema: { type: 'object', properties: { id: { type: 'string', maxLength: 256 } }, required: ['id'], additionalProperties: false },
                rowIdField: 'id', indexes: [], uiQueries: [], relations: [], serverReadable: ['id'], readableSchemaVersions: [1] }] },
        });
        const contracts = normalizePluginAccountCollectionContractsV1({ pluginId: manifest.id, contributions: manifest.contributes.accountCollections });
        const { pluginId, collectionId, schemaVersion, contractDigest } = contracts[0]!;
        const ref = { pluginId, collectionId, schemaVersion, contractDigest };
        const store = createPluginAccountAvailabilityReaderStore({ hostBundledUi: [{ pluginId: manifest.id,
            pluginVersion: manifest.version, packageName: '@happier-dev/plugins-notes', displayName: 'Notes',
            normalizedManifest: manifest, artifactGraphs: [], entriesById: {}, collectionContracts: [ref] }] });
        store.replace({ scope, snapshot: { availabilityCursor: 0, intentReads: [], materializations: [], snapshots: [] } });
        expect(store.bind(scope).readCurrentCollectionContract({ pluginId, collectionId, ref })).toMatchObject({ kind: 'unavailable' });
        let claimed = false;
        let claimCount = 0;
        let listCount = 0;
        let exactCount = 0;
        let claimGate: Promise<void> | null = null;
        const response = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
        const request = async (path: string, init?: RequestInit) => {
            if (path === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.collectionWriters.claim']) {
                expect(JSON.parse(String(init?.body))).toEqual({ manifest });
                claimCount += 1;
                if (claimGate) await claimGate;
                claimed = true;
                return response({ intent: { pluginId, desiredVersion: null, enabled: true, offlineUiHosting: 'disabled', writableCollections: [ref], revision: '1' } });
            }
            if (path === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.materializations.read']) {
                return response({ availabilityCursor: 1, snapshots: [], inventoryComplete: true, releases: [] });
            }
            const intentRead = { availabilityCursor: 1, hostingCapability: { enabled: false },
                    intent: { pluginId, desiredVersion: null, enabled: true, offlineUiHosting: 'disabled', writableCollections: [ref], revision: '1' },
                    release: null, uiArtifacts: [], packageAssets: [] };
            const named = (JSON.parse(String(init?.body ?? '{}')) as { pluginIds?: string[] }).pluginIds;
            if (named) {
                // The exact named read of the claimed plugin.
                exactCount += 1;
                return response({ availabilityCursor: 1, pluginIds: [pluginId], failedPluginIds: [],
                    intentReads: named.map(id => ({ pluginId: id, response: intentRead })) });
            }
            listCount += 1;
            return response({ availabilityCursor: 1, pluginIds: claimed ? [pluginId] : [], failedPluginIds: [],
                intentReads: claimed ? [{ pluginId, response: intentRead }] : [] });
        };
        const hydrator = createActivePluginAccountAvailabilityProjectionHydrator({ captureLifetime: () => hydrationLifetime,
            getServerSnapshot: () => ({ serverId: scope.serverId, generation: 1 }), captureRequestAuthority: async () => ({ request }) });
        const firstLoad = await hydrator.refresh();
        if (firstLoad) store.replace(firstLoad);
        const ensure = createPluginAccountCollectionContractBootstrap({ captureRequestAuthority: async () => ({ request }),
            refreshAvailability: async (namedPluginId?: string) => {
                if (namedPluginId) hydrator.requestPlugins([namedPluginId]);
                else hydrator.requireFullRefresh();
                const refreshed = await hydrator.refresh({ canMergePlugins: () => store.getSnapshot()?.intentCensusIncomplete !== true });
                if (refreshed) store.replace(refreshed);
            } });
        const input = { pluginId, ref, accountLifetime, readAvailability: () => store.bind(scope) };
        expect(await Promise.all([ensure({ pluginId, collectionId, accountLifetime,
            readAvailability: input.readAvailability }), ensure(input)])).toEqual([true, true]);
        expect(claimCount).toBe(1);
        // One page census, then one exact read shared by the concurrent Collection readers.
        expect({ listCount, exactCount }).toEqual({ listCount: 1, exactCount: 1 });
        expect(store.bind(scope).readCurrentCollectionContract({ pluginId, collectionId, ref })).toMatchObject({ kind: 'available' });
        store.clear();
        store.replace({ scope, snapshot: { availabilityCursor: 2, intentReads: [], materializations: [], snapshots: [] } });
        const gate = createDeferred<void>();
        claimGate = gate.promise;
        const controller = new AbortController();
        const cancelled = ensure({ ...input, signal: controller.signal });
        const retained = ensure(input);
        controller.abort();
        expect(await cancelled).toBe(false);
        gate.resolve();
        expect(await retained).toBe(true);
        expect(claimCount).toBe(2);
        store.clear();
        store.replace({ scope, snapshot: { availabilityCursor: 3, intentReads: [], materializations: [], snapshots: [] } });
        const replacementGate = createDeferred<void>();
        claimGate = replacementGate.promise;
        const retired = ensure(input);
        current = false;
        hydrationLifetime = { ...accountLifetime, isCurrent: () => true };
        const successor = ensure({ ...input, accountLifetime: hydrationLifetime });
        replacementGate.resolve();
        expect(await Promise.all([retired, successor])).toEqual([false, true]);
        expect(await ensure(input)).toBe(false);
    });
});
