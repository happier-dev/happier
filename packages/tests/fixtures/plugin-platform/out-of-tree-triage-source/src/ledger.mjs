/**
 * The fixture provider.
 *
 * An outside author's Triage source reads a provider that returns raw rows of
 * its own shape, some of which are independently malformed. Nothing here knows
 * about Happier: these are deliberately provider-native DTOs, so the mapping in
 * `map.mjs` is real work rather than a rename.
 *
 * Reads are deterministic and in-memory. The genuine system boundary a real
 * source would mock is HTTP; this fixture has none, so no mock exists either.
 */

/** Raw rows exactly as the fixture provider returns them, malformed ones included. */
const LEDGER_ROWS = Object.freeze([
    Object.freeze({
        ref: 'CHG-17',
        type: 'change',
        headline: 'Consolidate the duplicated normalizer',
        detail: 'Removes the second owner and migrates its callers.',
        space: 'acme/ledger',
        status: 'open',
        opened_at: 1_760_000_000_000,
        updated_at: 1_760_000_600_000,
        revision: 'b3f1c0a9d2e4',
        reviewers: ['viewer'],
        checks: { state: 'passing', label: 'All checks passing' },
        owner: 'r.okafor',
        url: 'https://ledger.invalid/acme/ledger/change/17',
    }),
    // Malformed: the provider omitted the identity every mapping needs.
    Object.freeze({
        type: 'ticket',
        headline: 'Row with no provider identity',
        space: 'acme/ledger',
        status: 'open',
    }),
    Object.freeze({
        ref: 'TCK-204',
        type: 'ticket',
        headline: 'Search returns stale rows after a rename',
        space: 'acme/ledger',
        status: 'triaged',
        opened_at: 1_759_000_000_000,
        updated_at: 1_759_500_000_000,
        assignees: ['viewer'],
        owner: 'p.lindqvist',
        url: 'https://ledger.invalid/acme/ledger/ticket/204',
    }),
    // Malformed: `headline` is the provider's own required display field and is
    // not a string, so this row has no projectable title.
    Object.freeze({
        ref: 'TCK-205',
        type: 'ticket',
        headline: { text: 'structured headline the contract does not carry' },
        space: 'acme/ledger',
        status: 'open',
    }),
    Object.freeze({
        ref: 'TCK-206',
        type: 'ticket',
        headline: 'Duplicate of TCK-204',
        space: 'acme/ledger',
        status: 'merged_into',
        merged_into: 'TCK-204',
        opened_at: 1_759_100_000_000,
    }),
    Object.freeze({
        ref: 'CHG-18',
        type: 'change',
        headline: 'Bound the ledger page walk',
        space: 'acme/ledger',
        status: 'closed',
        opened_at: 1_758_000_000_000,
        updated_at: 1_758_400_000_000,
        revision: 'c4e2b1f7a0d9',
        url: 'https://ledger.invalid/acme/ledger/change/18',
    }),
]);

/** The provider row the fixture treats as retired for authoritative reads. */
export const LEDGER_RETIRED_REF = 'TCK-900';

/** The provider row whose authoritative read never settles cleanly. */
export const LEDGER_UNAVAILABLE_REF = 'TCK-901';

export const LEDGER_ROW_COUNT = LEDGER_ROWS.length;

/**
 * Reads one bounded provider page.
 *
 * `offset` and `pageSize` are the provider's own geometry. The caller never
 * sees a next URL: the source owns continuation custody.
 */
export function readLedgerPage(offset, pageSize) {
    const rows = LEDGER_ROWS.slice(offset, offset + pageSize);
    return Object.freeze({
        rows,
        nextOffset: offset + rows.length < LEDGER_ROWS.length ? offset + rows.length : null,
    });
}

/** Reads one exact provider row, or `null` when the provider has none. */
export function readLedgerRow(ref) {
    return LEDGER_ROWS.find((row) => row.ref === ref) ?? null;
}

/**
 * The provider fields this source deliberately loads only for its detail
 * surface. The list projection carries the labelled fact without a value; only
 * a detail read resolves it.
 */
export function readLedgerDetailOnlyFacts(ref) {
    const row = readLedgerRow(ref);
    return row === null || typeof row.owner !== 'string'
        ? null
        : Object.freeze({ owner: row.owner });
}
