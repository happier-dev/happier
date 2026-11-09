import { PluginManifestV2Schema } from '@happier-dev/protocol';
import { PluginCollectionGetRequestV1Schema, PluginCollectionQueryRequestV1Schema } from '@happier-dev/protocol/plugins/data/collectionsV1';
import { createPluginAvailabilityOperations } from '@/app/plugins/availability/operations';
import { materializePluginCollectionContractsFromManifestTx } from '@/app/plugins/data/collections/contracts';
import { mutatePluginCollection } from '@/app/plugins/data/collections/mutation';
import { getPluginCollection, queryPluginCollection } from '@/app/plugins/data/collections/uiQuery';
import { markAccountChanged } from '@/app/changes/markAccountChanged';
import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { createLightSqliteHarness } from './lightSqliteHarness';

/** Disposable real Data persistence/publication for cross-app invalidation contracts. */
export async function createPluginCollectionInvalidationServer(manifestInput: unknown) {
    const sqlite = await createLightSqliteHarness({ tempDirPrefix: 'happier-collection-invalidation-' });
    try {
        const manifest = PluginManifestV2Schema.parse(manifestInput);
        const account = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' } });
        await inTx(tx => materializePluginCollectionContractsFromManifestTx({ tx, manifest }));
        await createPluginAvailabilityOperations().claimCollectionWriters({ accountId: account.id, input: { manifest } });
        const authentication = createPresentUserSessionAccessAuthentication();
        return {
            async post(path: string, body: string) {
                const request: unknown = JSON.parse(body);
                if (path.endsWith('/get')) return await getPluginCollection({ accountId: account.id, request: PluginCollectionGetRequestV1Schema.parse(request) });
                if (path.endsWith('/query')) return await queryPluginCollection({ accountId: account.id, request: PluginCollectionQueryRequestV1Schema.parse(request) });
                if (path.endsWith('/mutate')) return await mutatePluginCollection({ accountId: account.id, request, authentication });
                throw new Error(`Unexpected Data path ${path}`);
            },
            async changes() {
                return (await db.accountChange.findMany({ where: { accountId: account.id, kind: 'pluginDomain' },
                    select: { kind: true, entityId: true, hint: true, cursor: true, changedAt: true }, orderBy: { cursor: 'asc' } }))
                    .map(row => ({ ...row, changedAt: row.changedAt.getTime() }));
            },
            async full(collectionId: string) {
                const contract = await db.pluginCollectionContract.findFirstOrThrow({ where: { pluginId: manifest.id, collectionId } });
                await inTx(tx => markAccountChanged(tx, { accountId: account.id, kind: 'pluginDomain',
                    entityId: `pluginDomain/${manifest.id}/data-collection/${collectionId}`,
                    hint: { pluginDomain: 'dataCollection', pluginId: manifest.id, collectionId,
                        contractDigest: contract.contractDigest, revision: 1, full: true } }));
            },
            close: () => sqlite.close(),
        };
    } catch (error) { await sqlite.close(); throw error; }
}
