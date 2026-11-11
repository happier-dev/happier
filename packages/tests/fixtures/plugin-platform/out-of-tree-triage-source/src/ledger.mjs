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
 *
 * It serves finite spaces through one page and row owner:
 *
 *  - `acme/ledger`, the curated correctness space, whose raw rows include the
 *    independently malformed and merged ones the mapping has to survive; and
 *  - `acme/ledger-qa`, the declared 2,000-row space `qa/QA-PROTOCOL.md` QB-57's
 *    list and performance recipe needs a real source for; and
 *  - `acme/ledger-qa-deep` and `acme/ledger-qa-shallow`, QB-86's exact 500+3
 *    continuation lanes.
 *
 * They are the same provider seen through the same page geometry — there is no
 * second store, cache, or generator path — and which one a configured instance
 * reads is decided by ordinary source configuration, never by an environment
 * variable or a global mode.
 */

/** Fields this provider can order globally before selecting a page. */
export const LEDGER_SORT_COLUMNS = Object.freeze({ updated: 'updated_at', created: 'opened_at' });

export const LEDGER_SPACE_IDS = Object.freeze({
    curated: 'acme/ledger',
    qa: 'acme/ledger-qa',
    continuationDeep: 'acme/ledger-qa-deep',
    continuationShallow: 'acme/ledger-qa-shallow',
    empty: 'acme/ledger-qa-empty',
});

/** Every space this provider serves, in the order discovery reports them. */
export const LEDGER_SPACE_ID_LIST = Object.freeze(Object.values(LEDGER_SPACE_IDS));

/** Raw rows exactly as the fixture provider returns them, malformed ones included. */
const CURATED_ROWS = Object.freeze([
    Object.freeze({
        ref: 'CHG-17',
        type: 'change',
        headline: 'Consolidate the duplicated normalizer',
        detail: 'Removes the second owner and migrates its callers.',
        space: LEDGER_SPACE_IDS.curated,
        status: 'open',
        opened_at: 1_760_000_000_000,
        updated_at: 1_760_000_600_000,
        revision: 'b3f1c0a9d2e4',
        reviewers: ['viewer'],
        checks: { state: 'passing', label: 'All checks passing' },
        owner: 'r.okafor',
        url: 'https://ledger.invalid/acme/ledger/change/17',
        repository: Object.freeze({
            kind: 'custom',
            deployment: 'https://forge.example.test/Forge',
            repository: 'Team/Repo',
        }),
    }),
    // Malformed: the provider omitted the identity every mapping needs.
    Object.freeze({
        type: 'ticket',
        headline: 'Row with no provider identity',
        space: LEDGER_SPACE_IDS.curated,
        status: 'open',
    }),
    Object.freeze({
        ref: 'TCK-204',
        type: 'ticket',
        headline: 'Search returns stale rows after a rename',
        space: LEDGER_SPACE_IDS.curated,
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
        space: LEDGER_SPACE_IDS.curated,
        status: 'open',
    }),
    Object.freeze({
        ref: 'TCK-206',
        type: 'ticket',
        headline: 'Duplicate of TCK-204',
        space: LEDGER_SPACE_IDS.curated,
        status: 'merged_into',
        merged_into: 'TCK-204',
        opened_at: 1_759_100_000_000,
    }),
    Object.freeze({
        ref: 'CHG-18',
        type: 'change',
        headline: 'Bound the ledger page walk',
        space: LEDGER_SPACE_IDS.curated,
        status: 'closed',
        opened_at: 1_758_000_000_000,
        updated_at: 1_758_400_000_000,
        revision: 'c4e2b1f7a0d9',
        url: 'https://ledger.invalid/acme/ledger/change/18',
    }),
]);

/** The curated provider inventory is finite and already materialized. */
const CURATED_SORT_ORDERS = Object.fromEntries(Object.entries(LEDGER_SORT_COLUMNS).map(([field, column]) => [
    field, Object.fromEntries(['asc', 'desc'].map((direction) => [direction,
        CURATED_ROWS.map((_, index) => index).sort((left, right) => {
            const a = CURATED_ROWS[left][column];
            const b = CURATED_ROWS[right][column];
            if (a === undefined || b === undefined) {
                if (a !== b) return a === undefined ? 1 : -1;
            } else if (a !== b) {
                return (a - b) * (direction === 'asc' ? 1 : -1);
            }
            const aRef = CURATED_ROWS[left].ref ?? '';
            const bRef = CURATED_ROWS[right].ref ?? '';
            return aRef < bRef ? -1 : aRef > bRef ? 1 : left - right;
        }),
    ])),
]));

/** The provider row the fixture treats as retired for authoritative reads. */
export const LEDGER_RETIRED_REF = 'TCK-900';

/** The provider row whose authoritative read never settles cleanly. */
export const LEDGER_UNAVAILABLE_REF = 'TCK-901';

export const LEDGER_ROW_COUNT = CURATED_ROWS.length;

/** The declared size of the QA space (`qa/QA-PROTOCOL.md` QB-57). */
export const LEDGER_QA_ROW_COUNT = 2_000;

const QA_EPOCH_MS = 1_760_000_000_000;
const CONTINUATION_DEEP_ROW_COUNT = 500;
const QA_OWNERS = Object.freeze(['r.okafor', 'p.lindqvist', 'm.haddad', 's.nakamura']);
const QA_STATUSES = Object.freeze(['open', 'triaged', 'closed', 'resolved']);

/**
 * Builds one generated row from its space and index.
 *
 * The whole space is a pure function of the index, so a page read and an exact
 * authoritative read of the same entry cannot disagree, and neither one has to
 * materialize the space's inventory to answer. The workload is mixed on
 * purpose: both kinds, four provider states, two check outcomes, viewer
 * involvement on two different cadences, and a detail-only owner fact.
 */
function readGeneratedLedgerRow(space, rowCount, epochMs, index) {
    if (!Number.isInteger(index) || index < 0 || index >= rowCount) return null;
    const type = index % 2 === 0 ? 'change' : 'ticket';
    const openedAt = epochMs - index * 60_000;
    const row = {
        ref: `LGQ-${index}`,
        type,
        headline: `${type === 'change' ? 'Change' : 'Ticket'} ${index} in the Acme Ledger QA space`,
        space,
        status: QA_STATUSES[index % QA_STATUSES.length],
        opened_at: openedAt,
        updated_at: openedAt + 30_000,
        owner: QA_OWNERS[index % QA_OWNERS.length],
        url: `https://ledger.invalid/${space}/${type}/${index}`,
    };
    if (type === 'change') {
        row.revision = `qa${index.toString(16).padStart(12, '0')}`;
        row.checks = index % 3 === 0
            ? { state: 'passing', label: 'All checks passing' }
            : { state: 'failing', label: 'One check failing' };
    }
    if (index % 7 === 0) row.reviewers = ['viewer'];
    if (index % 5 === 0) row.assignees = ['viewer'];
    return Object.freeze(row);
}

/** Resolves a QA reference back to its index, or `-1` when it names no row. */
function readGeneratedLedgerRowIndex(rowCount, ref) {
    const parsed = /^LGQ-(\d+)$/u.exec(typeof ref === 'string' ? ref : '');
    if (parsed === null) return -1;
    const index = Number(parsed[1]);
    // `LGQ-007` is a different string from `LGQ-7`; only the canonical spelling
    // this provider emits resolves, so two refs never mean one entry.
    return `${index}` === parsed[1] && index < rowCount ? index : -1;
}

function generatedLedgerSpace(space, rowCount, epochMs = QA_EPOCH_MS) {
    return Object.freeze({
        rowCount,
        indexAtOffset: (offset, sort) => sort?.direction === 'asc' ? rowCount - offset - 1 : offset,
        readRow: (index) => readGeneratedLedgerRow(space, rowCount, epochMs, index),
        indexOfRef: (ref) => readGeneratedLedgerRowIndex(rowCount, ref),
    });
}

/**
 * The one row source per space. All spaces answer the same two questions —
 * "the row at this offset" and "the offset of this reference" — which is what
 * lets the page walk and the authoritative read share a single owner.
 */
const LEDGER_SPACES = Object.freeze({
    [LEDGER_SPACE_IDS.curated]: Object.freeze({
        rowCount: CURATED_ROWS.length,
        indexAtOffset: (offset, sort) => sort === undefined ? offset : CURATED_SORT_ORDERS[sort.field][sort.direction][offset],
        readRow: (index) => CURATED_ROWS[index] ?? null,
        indexOfRef: (ref) => CURATED_ROWS.findIndex((row) => row.ref === ref),
    }),
    [LEDGER_SPACE_IDS.qa]: generatedLedgerSpace(LEDGER_SPACE_IDS.qa, LEDGER_QA_ROW_COUNT),
    [LEDGER_SPACE_IDS.empty]: generatedLedgerSpace(LEDGER_SPACE_IDS.empty, 0),
    [LEDGER_SPACE_IDS.continuationDeep]: generatedLedgerSpace(LEDGER_SPACE_IDS.continuationDeep, CONTINUATION_DEEP_ROW_COUNT),
    // Every shallow row predates the oldest deep row: a global newest cut
    // would hide this connection, which is QB-86's named fairness falsifier.
    [LEDGER_SPACE_IDS.continuationShallow]: generatedLedgerSpace(
        LEDGER_SPACE_IDS.continuationShallow, 3, QA_EPOCH_MS - CONTINUATION_DEEP_ROW_COUNT * 60_000,
    ),
});

/** Whether this provider serves the named space at all. */
export function isLedgerSpace(space) {
    return typeof space === 'string' && Object.hasOwn(LEDGER_SPACES, space);
}

/**
 * Reads one bounded provider page.
 *
 * `offset` and `pageSize` are the provider's own geometry. The caller never
 * sees a next URL: the source owns continuation custody.
 */
export function readLedgerPage(space, offset, pageSize, sort) {
    if (!isLedgerSpace(space)) return Object.freeze({ rows: Object.freeze([]), nextOffset: null });
    const provider = LEDGER_SPACES[space];
    const end = Math.min(offset + pageSize, provider.rowCount);
    const rows = [];
    for (let index = offset; index < end; index += 1) {
        const row = provider.readRow(provider.indexAtOffset(index, sort));
        if (row !== null) rows.push(row);
    }
    return Object.freeze({
        rows: Object.freeze(rows),
        nextOffset: end < provider.rowCount ? end : null,
    });
}

/** Reads one exact provider row, or `null` when the space has none. */
export function readLedgerRow(space, ref) {
    if (!isLedgerSpace(space)) return null;
    const provider = LEDGER_SPACES[space];
    const index = provider.indexOfRef(ref);
    return index < 0 ? null : provider.readRow(index);
}

/**
 * The provider fields this source deliberately loads only for its detail
 * surface. The list projection carries the labelled fact without a value; only
 * a detail read resolves it.
 */
export function readLedgerDetailOnlyFacts(space, ref) {
    const row = readLedgerRow(space, ref);
    return row === null || typeof row.owner !== 'string'
        ? null
        : Object.freeze({ owner: row.owner });
}
