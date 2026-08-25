import {
    MAX_TRIAGE_ROW_FACTS_V1,
    MAX_TRIAGE_ROW_FACT_VALUE_UTF8_BYTES_V1,
    MAX_TRIAGE_TEXT_UTF8_BYTES_V1,
    TRIAGE_SINGLE_LINE_STRING_PATTERN_V1,
    TriageSourceEntrySnapshotV1Schema,
} from '@happier-dev/triage-protocol/v1';
import { describe, expect, it } from 'vitest';

import crudIssueRead from '../../api/__fixtures__/crudIssueRead.json' with { type: 'json' };
import page1 from '../../api/__fixtures__/queryIssuesPage1.json' with { type: 'json' };
import {
    parsePosthogIssueCrudRead,
    parsePosthogIssueRow,
    type PosthogIssueRow,
} from '../../api/types/issues.js';
import { normalizePosthogApiOrigin, type PosthogApiOrigin } from '../../connect/origin.js';
import { buildPosthogEntryLocator, type PosthogEntryLocator } from '../identity.js';
import { utf8ByteLength, type PosthogProjectionBounds } from './bounds.js';
import { buildPosthogEntrySnapshot, buildPosthogScopeLabel } from './entrySnapshot.js';
import { POSTHOG_FACT_PRIORITY, projectPosthogFacts } from './facts.js';
import { buildPosthogPresentObservation } from './observation.js';
import { mapPosthogIssueState } from './state.js';

const SINGLE_LINE_V1 = new RegExp(TRIAGE_SINGLE_LINE_STRING_PATTERN_V1, 'u');

/** Exactly what production projects with, so a parse here is the real admission check. */
const PUBLISHED_BOUNDS: PosthogProjectionBounds = {
    textUtf8Bytes: MAX_TRIAGE_TEXT_UTF8_BYTES_V1,
    factValueUtf8Bytes: MAX_TRIAGE_ROW_FACT_VALUE_UTF8_BYTES_V1,
    maxFacts: MAX_TRIAGE_ROW_FACTS_V1 - 1,
};

/**
 * Deliberately looser than the published ceilings, and derived from them so it stays
 * that way.
 *
 * These checks exercise priority order, count selection, and Unicode-safe truncation.
 * If the shared ceiling itself bound first they would prove the ceiling instead of the
 * behavior, so the harness sits above it — but as a multiple of the published symbols,
 * never as its own numbers. A literal here would be a second ledger for a limit
 * `@happier-dev/triage-protocol` already owns, and it would silently start binding the
 * moment that limit moved. `PUBLISHED_BOUNDS` above remains the real admission check.
 */
const LOOSE_BOUNDS: PosthogProjectionBounds = {
    textUtf8Bytes: MAX_TRIAGE_TEXT_UTF8_BYTES_V1 * 8,
    factValueUtf8Bytes: MAX_TRIAGE_ROW_FACT_VALUE_UTF8_BYTES_V1 * 8,
    maxFacts: POSTHOG_FACT_PRIORITY.length,
};

function requireOrigin(raw: string): PosthogApiOrigin {
    const resolved = normalizePosthogApiOrigin(raw);
    if (!resolved.ok) throw new Error('fixture origin must normalize');
    return resolved.origin;
}

const ORIGIN = requireOrigin('https://eu.posthog.com');
const TEAM_UUID = '00000000-0000-4000-8000-0000000000d1';

function fixtureRows(): readonly PosthogIssueRow[] {
    return (page1.results as readonly unknown[]).map((raw) => {
        const row = parsePosthogIssueRow(raw);
        if (row === null) throw new Error('recorded fixture rows must parse');
        return row;
    });
}

function locatorFor(row: PosthogIssueRow): PosthogEntryLocator {
    const locator = buildPosthogEntryLocator(ORIGIN, TEAM_UUID, row.id);
    if (!locator.ok) throw new Error('fixture row must produce a locator');
    return locator.value;
}

function snapshotFor(
    row: PosthogIssueRow,
    overrides?: Readonly<{
        displayName?: string;
        crud?: ReturnType<typeof parsePosthogIssueCrudRead>;
        bounds?: PosthogProjectionBounds;
    }>,
) {
    const crud = overrides?.crud;
    return buildPosthogEntrySnapshot({
        locator: locatorFor(row),
        row,
        scope: {
            teamRouteId: 4821,
            ...(overrides?.displayName === undefined ? {} : { displayName: overrides.displayName }),
        },
        ...(crud === undefined || crud === null ? {} : { crud }),
        untitledLabel: 'Untitled issue',
        bounds: overrides?.bounds ?? LOOSE_BOUNDS,
    });
}

describe('mapPosthogIssueState', () => {
    it('maps each native state and keeps the provider label visible', () => {
        expect(mapPosthogIssueState('active'))
            .toEqual({ presentation: 'active', nativeLabel: 'active' });
        expect(mapPosthogIssueState('resolved'))
            .toEqual({ presentation: 'resolved', nativeLabel: 'resolved' });
        expect(mapPosthogIssueState('archived'))
            .toEqual({ presentation: 'closed', nativeLabel: 'archived' });
    });

    it('maps pending_release and any unrecognized value to the shared neutral arm', () => {
        expect(mapPosthogIssueState('pending_release'))
            .toEqual({ presentation: 'unknown', nativeLabel: 'pending_release' });
        expect(mapPosthogIssueState('custom_future_state'))
            .toEqual({ presentation: 'unknown', nativeLabel: 'custom_future_state' });
        expect(mapPosthogIssueState('all'))
            .toEqual({ presentation: 'unknown', nativeLabel: 'all' });
    });

    it('retains suppressed rather than laundering it into a generic ignored state', () => {
        const mapped = mapPosthogIssueState('suppressed');

        expect(mapped.presentation).toBe('suppressed');
        expect(mapped.nativeLabel).toBe('suppressed');
        expect(JSON.stringify(mapped)).not.toContain('ignore');
    });
});
describe('projectPosthogFacts', () => {
    it('keeps occurrences exact within the ingested window and the other counts approximate', () => {
        const [first] = fixtureRows();
        if (first === undefined) throw new Error('fixture must have a first row');

        const { facts } = projectPosthogFacts(first, LOOSE_BOUNDS);
        const byId = new Map(facts.map((fact) => [fact.id, fact]));

        expect(byId.get('occurrences')).toEqual({
            id: 'occurrences',
            kind: 'count',
            value: 1842,
            approximate: false,
            scope: 'configuredWindowIngested',
        });
        expect(byId.get('users')).toMatchObject({ value: 311, approximate: true });
        expect(byId.get('sessions')).toMatchObject({ value: 402, approximate: true });
    });

    it('does not claim an all-time or end-user-event count', () => {
        const [first] = fixtureRows();
        if (first === undefined) throw new Error('fixture must have a first row');

        const serialized = JSON.stringify(projectPosthogFacts(first, LOOSE_BOUNDS));

        expect(serialized).not.toContain('allTime');
        expect(serialized).not.toContain('total');
    });

    it('omits a count the provider did not send instead of substituting zero', () => {
        const rows = fixtureRows();
        const withoutAggregations: PosthogIssueRow = {
            ...(rows[0] as PosthogIssueRow),
            aggregations: null,
        };

        const ids = projectPosthogFacts(withoutAggregations, LOOSE_BOUNDS).facts
            .map((fact) => fact.id);

        expect(ids).not.toContain('occurrences');
        expect(ids).not.toContain('users');
        expect(ids).not.toContain('sessions');
    });

    it('drops the lowest-priority facts first when the shared count limit binds', () => {
        const [first] = fixtureRows();
        if (first === undefined) throw new Error('fixture must have a first row');

        const { facts, truncated } = projectPosthogFacts(first, { ...LOOSE_BOUNDS, maxFacts: 3 });

        // This scan row has no detail enrichment, so priority is applied among the
        // candidates actually present rather than requiring detail-only facts.
        expect(facts.map((fact) => fact.id)).toEqual(['occurrences', 'lastSeen', 'users']);
        expect(truncated).toBe(true);
    });
});

describe('buildPosthogEntrySnapshot', () => {
    it('never puts severity on a scan row and takes it from the CRUD plane on detail', () => {
        const [first] = fixtureRows();
        if (first === undefined) throw new Error('fixture must have a first row');

        expect(snapshotFor(first).severity).toBeUndefined();
        expect(snapshotFor(first, { crud: parsePosthogIssueCrudRead(crudIssueRead) }).severity)
            .toBe('high');
    });

    it('labels the environment from its display name and falls back to the Team route id', () => {
        expect(buildPosthogScopeLabel(
            { displayName: 'Storefront production', teamRouteId: 4821 },
            LOOSE_BOUNDS,
        )).toEqual({ value: 'Storefront production', truncated: false });
        expect(buildPosthogScopeLabel({ teamRouteId: 4821 }, LOOSE_BOUNDS))
            .toEqual({ value: 'Environment 4821', truncated: false });
        // A parent project id (4820 in the recorded fixture) is never the fallback.
        expect(buildPosthogScopeLabel({ teamRouteId: 4821 }, LOOSE_BOUNDS).value)
            .not.toContain('4820');
    });

    it('falls back name to description to a localized untitled label', () => {
        const rows = fixtureRows();
        const named = rows[0] as PosthogIssueRow;
        const unnamed = rows[2] as PosthogIssueRow;
        const blank: PosthogIssueRow = { ...named, name: null, description: null };

        expect(snapshotFor(named).title).toBe('TypeError');
        expect(snapshotFor(unnamed).title).toBe('unhandled promise rejection');
        expect(snapshotFor(blank).title).toBe('Untitled issue');
    });

    it('does not repeat the description when it was already used as the title', () => {
        const rows = fixtureRows();
        const unnamed = rows[2] as PosthogIssueRow;

        expect(snapshotFor(unnamed).description).toBeUndefined();
        expect(snapshotFor(rows[0] as PosthogIssueRow).description)
            .toBe("Cannot read properties of undefined (reading 'id')");
    });

    it('omits a malformed timestamp rather than fabricating one', () => {
        const rows = fixtureRows();
        const stripped = { ...(rows[0] as PosthogIssueRow) } as {
            firstSeenMs?: number;
            lastSeenMs?: number;
        };
        delete stripped.firstSeenMs;
        delete stripped.lastSeenMs;

        const ids = snapshotFor(stripped as PosthogIssueRow).facts.map((fact) => fact.id);

        expect(ids).not.toContain('firstSeen');
        expect(ids).not.toContain('lastSeen');
    });

    it('marks an ordinary complete issue as untruncated', () => {
        const [first] = fixtureRows();
        if (first === undefined) throw new Error('fixture must have a first row');

        expect(snapshotFor(first, { displayName: 'Storefront production' }).projectionTruncated)
            .toBe(false);
    });
});

describe('buildPosthogEntrySnapshot with a pathological but provider-valid issue', () => {
    // Every field is oversized yet schema-valid. PostHog does not reject such an issue
    // and neither may this source.
    const pathological: PosthogIssueRow = {
        id: '00000000-0000-4000-8000-0000000000ff',
        // Astral-plane characters so a naive byte slice would split a code point.
        name: '🧨'.repeat(5_000),
        description: 'é'.repeat(50_000),
        nativeStatus: 'suppressed',
        firstSeenMs: Date.parse('2026-07-01T00:00:00.000Z'),
        lastSeenMs: Date.parse('2026-08-14T00:00:00.000Z'),
        library: 'l'.repeat(40_000),
        source: 's'.repeat(40_000),
        assignee: null,
        aggregations: { occurrences: 9_999_999, users: 12_345, sessions: 23_456 },
    };

    it('keeps the issue visible and bounds it instead of rejecting the whole entity', () => {
        const snapshot = snapshotFor(pathological, { displayName: 'x'.repeat(50_000) });

        expect(snapshot.locator.entryId).toBe('00000000-0000-4000-8000-0000000000ff');
        expect(snapshot.title.length).toBeGreaterThan(0);
        expect(utf8ByteLength(snapshot.title)).toBeLessThanOrEqual(LOOSE_BOUNDS.textUtf8Bytes);
        expect(utf8ByteLength(snapshot.description ?? ''))
            .toBeLessThanOrEqual(LOOSE_BOUNDS.textUtf8Bytes);
        expect(utf8ByteLength(snapshot.scopeLabel))
            .toBeLessThanOrEqual(LOOSE_BOUNDS.textUtf8Bytes);
        for (const fact of snapshot.facts) {
            if (fact.kind === 'text') {
                expect(utf8ByteLength(fact.value))
                    .toBeLessThanOrEqual(LOOSE_BOUNDS.factValueUtf8Bytes);
            }
        }
        expect(snapshot.projectionTruncated).toBe(true);
    });

    it('truncates on whole code points so no surrogate pair is split', () => {
        const snapshot = snapshotFor(pathological);

        expect(snapshot.title).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u);
        expect(snapshot.title.startsWith('🧨')).toBe(true);
        expect(Array.from(snapshot.title).every((point) => point === '🧨')).toBe(true);
    });

    it('never truncates or substitutes identity or destructive native state', () => {
        const snapshot = snapshotFor(pathological);

        expect(snapshot.state).toEqual({ presentation: 'suppressed', nativeLabel: 'suppressed' });
        expect(snapshot.locator.collisionScope)
            .toBe(`posthog:https://eu.posthog.com:${TEAM_UUID}`);
    });

    it('keeps every fact it can, in the stable priority order', () => {
        const snapshot = snapshotFor(pathological);

        expect(snapshot.facts.map((fact) => fact.id)).toEqual([
            'occurrences',
            'lastSeen',
            'users',
            'sessions',
            'source',
            'library',
            'firstSeen',
        ]);
    });
});

describe('single-line display projection', () => {
    it('publishes a multi-line error-issue name as one line instead of rejecting its page', () => {
        // A PostHog exception name carries the thrown message, which routinely spans
        // lines. The strict target rejects a control-bearing result ATOMICALLY, so one
        // such row would discard every other issue on the same scan page.
        const row = { ...fixtureRows()[0], name: 'TypeError: x is undefined\n  at load' };
        const snapshot = snapshotFor(row, { bounds: PUBLISHED_BOUNDS });

        expect(snapshot.title).toBe('TypeError: x is undefined at load');
        // Collapsing a control run loses no content, so it must not be charged as
        // truncation: the flag stays whatever the unmodified fixture row produced.
        expect(snapshot.projectionTruncated).toBe(
            snapshotFor(fixtureRows()[0], { bounds: PUBLISHED_BOUNDS }).projectionTruncated,
        );
        expect(() => TriageSourceEntrySnapshotV1Schema.parse(
            buildPosthogPresentObservation({ snapshot }).snapshot,
        )).not.toThrow();
    });

    it('publishes a multi-line description as a one-line summary', () => {
        const row = {
            ...fixtureRows()[0],
            name: 'Short name',
            description: 'first frame\n\tsecond frame',
        };
        const snapshot = snapshotFor(row);

        expect(snapshot.description).toBe('first frame second frame');
        expect(SINGLE_LINE_V1.test(snapshot.description ?? '')).toBe(true);
    });

    it('publishes a control-bearing environment name as a one-line scope label', () => {
        const snapshot = snapshotFor(fixtureRows()[0], { displayName: 'EU\tproduction' });

        expect(snapshot.scopeLabel).toBe('EU production');
        expect(SINGLE_LINE_V1.test(snapshot.scopeLabel)).toBe(true);
    });
    it('publishes an unrecognized native status as one bounded line', () => {
        // PostHog declares `status` as a bare string, so an unrecognized value is
        // expected. It reaches `state.nativeLabel`, a single-line byte-bounded V1
        // string, and the target rejects a control-bearing result ATOMICALLY.
        const row = { ...fixtureRows()[0], nativeStatus: 'pending\nrelease' };
        const snapshot = snapshotFor(row, { bounds: PUBLISHED_BOUNDS });
        const published = buildPosthogPresentObservation({ snapshot }).snapshot;

        expect(published.state)
            .toEqual({ presentation: 'unknown', nativeLabel: 'pending release' });
        expect(() => TriageSourceEntrySnapshotV1Schema.parse(published)).not.toThrow();
    });
});
