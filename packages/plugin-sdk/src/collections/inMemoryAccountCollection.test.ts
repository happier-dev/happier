import { describe, expect, it } from 'vitest';
import { derivePluginCollectionIdentityTagV1 } from '@happier-dev/protocol/crypto/accountScopedCipher';

import { createInMemoryAccountCollection } from '@happier-dev/plugin-sdk/collections';
import type { PluginAccountCollectionDefinition } from '../collections.js';

const definition = {
    id: 'records', schemaVersion: 1, rowIdField: 'id', identityFields: ['id'],
    schema: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' } }, required: ['id', 'title'], additionalProperties: false },
    serverReadable: ['title'], indexes: [{ id: 'by-title', fields: [{ field: 'title', direction: 'asc' }] }],
    uiQueries: [], relations: [],
} satisfies PluginAccountCollectionDefinition;

describe('in-memory Account Collection boundary', () => {
    it('delegates declared identity to the supplied boundary without needing Account keys', async () => {
        const options = { definition, pluginId: 'example.records',
            identityTag: async (request: Readonly<{ field: string; components: readonly string[] }>) =>
                `external:${request.field}:${request.components.join('/')}` };
        const { collection } = createInMemoryAccountCollection(options);
        await expect(collection.identityTag({ field: 'id', components: ['opaque'] })).resolves.toBe('external:id:opaque');
        await expect(collection.identityTag({ field: 'title', components: ['opaque'] }))
            .rejects.toMatchObject({ code: 'plugin_collection_invalid_value' });
    });

    it('binds default plaintext identity to the supplied plugin and declared Collection', async () => {
        const { collection } = createInMemoryAccountCollection({ definition, pluginId: 'example.records' });
        await expect(collection.identityTag({ field: 'id', components: ['opaque'] })).resolves.toBe(
            derivePluginCollectionIdentityTagV1({ accountEncryptionMode: 'plain', material: null,
                pluginId: 'example.records', collectionId: definition.id, field: 'id', components: ['opaque'] }),
        );
    });

    it('retains revision conflicts, ordered queries and tombstone resurrection through the public boundary', async () => {
        const { collection } = createInMemoryAccountCollection({ definition, pluginId: 'example.records' });
        const first = await collection.put({ id: 'a', title: 'Zulu' }, { expectedRevision: 'absent' });
        await collection.put({ id: 'b', title: 'Alpha' }, { expectedRevision: 'absent' });
        expect((await collection.query({ index: 'by-title', order: 'asc' })).rows.map(row => row.rowId)).toEqual(['b', 'a']);
        const deleted = await collection.delete('a', { expectedRevision: first.revision });
        await expect(collection.get('a')).resolves.toBeNull();
        await expect(collection.put({ id: 'a', title: 'Again' }, { expectedRevision: 'absent' }))
            .rejects.toMatchObject({ code: 'plugin_collection_conflict' });
        await expect(collection.put({ id: 'a', title: 'Again' }, { expectedRevision: deleted.revision }))
            .resolves.toMatchObject({ rowId: 'a', revision: deleted.revision + 1 });
    });
});
