import { describe, expect, it, vi } from 'vitest';
import { normalizePluginAccountCollectionContractV1 } from '@happier-dev/protocol/plugins/data/collectionsV1';
import { PluginJsonSchemaV2Schema } from '@happier-dev/protocol/plugins/contributions/jsonSchema';

import { parseCollectionContractReadResult, prepareCollectionContractSchema } from './collectionContractSchema';

const contract = normalizePluginAccountCollectionContractV1({
    pluginId: 'example.contract-cost',
    contribution: {
        id: 'notes',
        schemaVersion: 1,
        schema: {
            type: 'object',
            properties: {
                id: { type: 'string', maxLength: 64 },
                kind: { anyOf: [{ const: 'open' }, { const: 'closed' }] },
            },
            required: ['id', 'kind'],
            additionalProperties: false,
        },
        rowIdField: 'id',
        serverReadable: ['kind'],
        indexes: [],
        uiQueries: [],
        relations: [],
        migrations: [],
        identityFields: [],
    },
});

describe('collection contract schema owner', () => {
    it('admits an answered contract schema once for its validator and stored reader', () => {
        // The contract read answer is plain JSON, as the HTTP owner delivers it.
        const answer = parseCollectionContractReadResult(JSON.parse(JSON.stringify({ access: 'writable', contract })));
        expect(answer).not.toBeNull();
        const admissions = vi.spyOn(PluginJsonSchemaV2Schema, 'safeParse');
        try {
            const prepared = prepareCollectionContractSchema(answer!.contract);
            expect(admissions).toHaveBeenCalledTimes(1);
            expect(prepared.validate({ id: 'row-1', kind: 'open' })).toBe(true);
            expect(prepared.validate({ id: 'row-1', kind: 'other' })).toBe(false);
            expect(prepared.storedReadSchema.safeParse({ id: 'row-1', kind: 'closed', retired: true }))
                .toEqual({ success: true, data: { id: 'row-1', kind: 'closed' } });
            expect(prepareCollectionContractSchema(answer!.contract)).toBe(prepared);
            expect(admissions).toHaveBeenCalledTimes(1);
        } finally {
            admissions.mockRestore();
        }
    });
});
