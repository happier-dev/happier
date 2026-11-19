import { describe, expect, it } from 'vitest';
import { DatabaseStatementResultV1Schema } from '@happier-dev/plugin-sdk/database';
import { decodePostgresqlObjectRowsV1, PostgresqlOperationError } from './index.js';

describe('restricted PostgreSQL object-row frames', () => {
    it('preserves provider values and aligns reordered keys without claiming native types or a complete result', () => {
        const value = decodePostgresqlObjectRowsV1([
            { empty: '', absent: null, enabled: true, amount: 12.5, document: { nested: null, exact: '9223372036854775807' }, list: [false, ''] },
            { list: [], document: {}, amount: 0, enabled: false, absent: 'null', empty: 'second' },
        ]);
        expect(value).toEqual({
            columns: ['empty', 'absent', 'enabled', 'amount', 'document', 'list'].map(name => ({ name, nativeType: 'unknown', semanticType: 'unknown' })),
            rows: [{ cells: [{ type: 'text', value: '' }, { type: 'null' }, { type: 'boolean', value: true }, { type: 'float', value: 12.5 },
                { type: 'json', value: '{"nested":null,"exact":"9223372036854775807"}' }, { type: 'json', value: '[false,""]' }] },
            { cells: [{ type: 'text', value: 'second' }, { type: 'text', value: 'null' }, { type: 'boolean', value: false }, { type: 'float', value: 0 },
                { type: 'json', value: '{}' }, { type: 'json', value: '[]' }] }],
            completeness: { complete: false, reason: 'transport_unproven' },
        });
        expect(DatabaseStatementResultV1Schema.parse(value)).toEqual(value);
    });

    it('keeps missing empty-result metadata and completeness explicitly unknown', () => {
        expect(decodePostgresqlObjectRowsV1([])).toEqual({ columns: [], rows: [], completeness: { complete: false, reason: 'transport_unproven' } });
    });

    it.each([
        [{ first: 1 }, { second: 2 }], [{ first: 1 }, { first: 2, extra: 3 }],
        [{ value: Number.POSITIVE_INFINITY }], [{ value: { nested: undefined } }],
        [null], [['not', 'an', 'object-row']], { rows: [] },
    ].map(response => ({ response })))('settles malformed provider frames with the existing typed provider error: $response', ({ response }) => {
        try { decodePostgresqlObjectRowsV1(response); throw new Error('Expected invalid provider response'); }
        catch (error) {
            expect(error).toBeInstanceOf(PostgresqlOperationError);
            if (!(error instanceof PostgresqlOperationError)) throw error;
            expect(error.failure).toEqual({ ok: false, status: 'failed', code: 'provider_response_invalid' });
        }
    });
});
