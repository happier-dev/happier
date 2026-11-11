import assert from 'node:assert/strict';
import test from 'node:test';

import { LEDGER_SPACE_ID_LIST, isLedgerSpace, readLedgerPage, readLedgerRow } from '../src/ledger.mjs';

const DEEP_SPACE = 'acme/ledger-qa-deep';
const SHALLOW_SPACE = 'acme/ledger-qa-shallow';

test('QB-63: a configured empty space is discoverable and settles complete without rows', () => {
    const space = 'acme/ledger-qa-empty';
    assert.ok(LEDGER_SPACE_ID_LIST.includes(space));
    assert.equal(isLedgerSpace(space), true);
    assert.deepEqual(readLedgerPage(space, 0, 37), { rows: [], nextOffset: null });
    assert.equal(readLedgerRow(space, 'LGQ-0'), null);
});

function walk(space, pageSize) {
    const rows = [];
    const offsets = new Set();
    let offset = 0;
    do {
        assert.equal(offsets.has(offset), false, 'the provider repeated a page offset');
        offsets.add(offset);
        const page = readLedgerPage(space, offset, pageSize);
        assert.ok(page.rows.length <= pageSize);
        rows.push(...page.rows);
        offset = page.nextOffset;
    } while (offset !== null);
    return rows;
}

for (const [space, count] of [[DEEP_SPACE, 500], [SHALLOW_SPACE, 3]]) {
    test(`QB-86: ${space} exhausts exactly ${count} rows and resolves those same rows authoritatively`, () => {
        const rows = walk(space, 37);
        assert.equal(rows.length, count);
        assert.equal(new Set(rows.map((row) => row.ref)).size, count);
        for (const row of rows) {
            assert.equal(row.space, space);
            assert.deepEqual(readLedgerRow(space, row.ref), row);
        }
        assert.equal(readLedgerRow(space, `LGQ-${count}`), null);
        assert.equal(readLedgerRow(space, 'LGQ-00'), null);
        assert.deepEqual(readLedgerPage(space, count, 37), { rows: [], nextOffset: null });
    });
}

test('QB-86: the shallow lane is older than every deep-lane row, so a global newest cut would hide it', () => {
    const deep = walk(DEEP_SPACE, 37);
    const shallow = walk(SHALLOW_SPACE, 37);
    assert.equal(deep.length, 500);
    assert.equal(shallow.length, 3);
    assert.ok(Math.max(...shallow.map((row) => row.updated_at)) < Math.min(...deep.map((row) => row.updated_at)));
});

test('the existing curated and 2,000-row QA spaces retain their provider contents', () => {
    const curated = walk('acme/ledger', 37);
    assert.equal(curated.length, 6);
    assert.equal(readLedgerRow('acme/ledger', 'CHG-17').headline, 'Consolidate the duplicated normalizer');
    const qa = walk('acme/ledger-qa', 37);
    assert.equal(qa.length, 2_000);
    assert.deepEqual(qa[0], readLedgerRow('acme/ledger-qa', 'LGQ-0'));
    assert.deepEqual(qa.at(-1), readLedgerRow('acme/ledger-qa', 'LGQ-1999'));
    assert.equal(readLedgerRow('acme/ledger-qa', 'LGQ-2000'), null);
});

for (const field of ['updated', 'created']) {
    test(`FIELD-SORT-1111: provider orders ${field} before bounding pages`, () => {
        const sort = { field, direction: 'asc' };
        const first = readLedgerPage(SHALLOW_SPACE, 0, 2, sort);
        const second = readLedgerPage(SHALLOW_SPACE, first.nextOffset, 2, sort);
        assert.deepEqual(first.rows.map((row) => row.ref), ['LGQ-2', 'LGQ-1']);
        assert.deepEqual(second.rows.map((row) => row.ref), ['LGQ-0']);
        assert.equal(second.nextOffset, null);
        const descending = readLedgerPage(SHALLOW_SPACE, 0, 2, { field, direction: 'desc' });
        assert.deepEqual(descending.rows.map((row) => row.ref), ['LGQ-0', 'LGQ-1']);
    });
}
