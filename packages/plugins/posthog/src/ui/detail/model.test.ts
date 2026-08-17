import { describe, expect, it } from 'vitest';

import {
    MAX_TRIAGE_ROW_FACTS_V1,
    MAX_TRIAGE_ROW_FACT_VALUE_UTF8_BYTES_V1,
    MAX_TRIAGE_TEXT_UTF8_BYTES_V1,
    TriageDetailSurfaceInputV1Schema,
    TriageSourceObservationV1Schema,
    type TriageDetailSurfaceInputV1,
    type TriageSourceObservationV1,
} from '@happier-dev/triage-protocol/v1';

import crudIssueRead from '../../api/__fixtures__/crudIssueRead.json' with { type: 'json' };
import page1 from '../../api/__fixtures__/queryIssuesPage1.json' with { type: 'json' };
import {
    parsePosthogIssueCrudRead,
    parsePosthogIssueRow,
    type PosthogIssueRow,
} from '../../api/types/issues.js';
import { normalizePosthogApiOrigin, type PosthogApiOrigin } from '../../connect/origin.js';
import {
    POSTHOG_PLUGIN_ID,
    POSTHOG_SOURCE_CONTRIBUTION_ID,
} from '../../posthogContracts.js';
import { buildPosthogEntryLocator } from '../../source/identity.js';
import { buildPosthogEntrySnapshot } from '../../source/map/entrySnapshot.js';
import { buildPosthogPresentObservation } from '../../source/map/observation.js';
import {
    buildPosthogDetailGetRequest,
    projectPosthogDetailSurface,
} from './model.js';

/**
 * The exact bounds the bound operations project with. Restating them as literals here
 * would let a published bound shrink without this fixture noticing, and the shrunk
 * value is precisely what the detail input's closed schema rejects.
 */
const SHARED_BOUNDS = {
    textUtf8Bytes: MAX_TRIAGE_TEXT_UTF8_BYTES_V1,
    factValueUtf8Bytes: MAX_TRIAGE_ROW_FACT_VALUE_UTF8_BYTES_V1,
    maxFacts: MAX_TRIAGE_ROW_FACTS_V1 - 1,
};
const TEAM_UUID = '00000000-0000-4000-8000-0000000000d1';

function requireOrigin(raw: string): PosthogApiOrigin {
    const resolved = normalizePosthogApiOrigin(raw);
    if (!resolved.ok) throw new Error('fixture origin must normalize');
    return resolved.origin;
}

const ORIGIN = requireOrigin('https://eu.posthog.com');

function firstFixtureRow(): PosthogIssueRow {
    const raw = (page1.results as readonly unknown[])[0];
    const row = parsePosthogIssueRow(raw);
    if (row === null) throw new Error('recorded fixture row must parse');
    return row;
}

/** One real PostHog present observation, produced by this package's own mapper. */
function posthogObservation(
    overrides?: Readonly<{ row?: PosthogIssueRow; withSeverity?: boolean }>,
): Extract<TriageSourceObservationV1, Readonly<{ kind: 'present' }>> {
    const row = overrides?.row ?? firstFixtureRow();
    const locator = buildPosthogEntryLocator(ORIGIN, TEAM_UUID, row.id);
    if (!locator.ok) throw new Error('fixture row must produce a locator');
    return buildPosthogPresentObservation({
        snapshot: buildPosthogEntrySnapshot({
            locator: locator.value,
            row,
            scope: { displayName: 'Storefront production', teamRouteId: 4821 },
            ...(overrides?.withSeverity === false
                ? {}
                : { crud: parsePosthogIssueCrudRead(crudIssueRead) }),
            untitledLabel: 'Untitled issue',
            bounds: SHARED_BOUNDS,
        }),
        ...(row.lastSeenMs === undefined ? {} : { sourceUpdatedAtMs: row.lastSeenMs }),
    });
}

const CONFIGURED_INSTANCE = Object.freeze({
    v: 1,
    instance: Object.freeze({
        source: Object.freeze({
            pluginId: POSTHOG_PLUGIN_ID,
            localId: POSTHOG_SOURCE_CONTRIBUTION_ID,
        }),
        sourceInstanceId: '2f1c9c4e-8c1f-4a53-9c2a-4c9a7b1d3e05',
    }),
    binding: Object.freeze({
        purpose: 'posthog-api',
        account: Object.freeze({
            service: Object.freeze({ pluginId: POSTHOG_PLUGIN_ID, localId: 'posthog-api' }),
            accountId: 'account-1',
        }),
    }),
    localInstanceKey: `posthog-org:${ORIGIN as string}:00000000-0000-4000-8000-0000000000c1`,
    configuration: Object.freeze({ v: 1, token: 'posthog-configuration-token-v1' }),
});

function detailInput(
    observation = posthogObservation(),
    linkedSessions: readonly unknown[] = [],
): TriageDetailSurfaceInputV1 {
    return TriageDetailSurfaceInputV1Schema.parse({
        v: 1,
        instance: CONFIGURED_INSTANCE,
        observation: {
            entryRef: {
                source: {
                    pluginId: POSTHOG_PLUGIN_ID,
                    localId: POSTHOG_SOURCE_CONTRIBUTION_ID,
                },
                ...observation.localRef,
            },
            observedAtMs: 1_760_000_900_000,
            locator: observation.locator,
            snapshot: observation.snapshot,
            viewer: observation.viewer,
            ...(observation.sourceUpdatedAtMs === undefined
                ? {}
                : { sourceUpdatedAtMs: observation.sourceUpdatedAtMs }),
        },
        linkedSessions,
    });
}

describe('buildPosthogDetailGetRequest', () => {
    it('addresses the exact mounted entry through the exact mounted instance', () => {
        const input = detailInput();

        const request = buildPosthogDetailGetRequest(input);

        expect(request).toEqual({
            kind: 'ready',
            input: {
                v: 1,
                instance: input.instance,
                localRef: {
                    kindId: input.observation.entryRef.kindId,
                    collisionScope: input.observation.entryRef.collisionScope,
                    entryId: input.observation.entryRef.entryId,
                },
                // The applied observation already carries the locator the aggregate
                // routed with. Dropping it would make the live read re-derive a location
                // this mount already knows.
                lastKnownLocator: input.observation.locator,
            },
        });
        // The qualified source identity is address, not payload: `get` carries a local ref.
        expect(request).not.toHaveProperty('input.localRef.source');
    });

    it('refuses a mount whose entry belongs to another source or kind', () => {
        const foreignSource = detailInput();
        const foreign = {
            ...foreignSource,
            observation: {
                ...foreignSource.observation,
                entryRef: {
                    ...foreignSource.observation.entryRef,
                    source: { pluginId: 'happier.other', localId: 'other-forge' },
                },
            },
        };
        const foreignKind = {
            ...foreignSource,
            observation: {
                ...foreignSource.observation,
                entryRef: { ...foreignSource.observation.entryRef, kindId: 'pull-request' },
            },
        };

        expect(buildPosthogDetailGetRequest(foreign)).toEqual({
            kind: 'refused',
            reason: 'foreignSource',
        });
        expect(buildPosthogDetailGetRequest(foreignKind)).toEqual({
            kind: 'refused',
            reason: 'foreignKind',
        });
    });
});

describe('projectPosthogDetailSurface', () => {
    it('renders the applied observation before any live read and never the shared chrome', () => {
        const model = projectPosthogDetailSurface(detailInput(), null);

        expect(model.read).toEqual({ kind: 'applied' });
        expect(model.body.origin).toBe('applied');
        expect(model.body.appliedObservedAtMs).toBe(1_760_000_900_000);
        // The aggregate detail shell owns title, state, scope, attention and Sessions.
        for (const owned of ['title', 'scopeLabel', 'state', 'attention', 'linkedSessions']) {
            expect(model.body).not.toHaveProperty(owned);
        }
        expect(model).not.toHaveProperty('title');
    });

    it('names the bounded ingested window on the occurrence count and never calls it a total', () => {
        const model = projectPosthogDetailSurface(detailInput(), null);
        const occurrences = model.body.fields.find((field) => field.id === 'posthog/occurrences');

        if (occurrences?.kind !== 'number') throw new Error('occurrences must be a number field');
        expect(occurrences.approximate).toBe(false);
        expect(occurrences.disclosure).toMatch(/ingest/iu);
        expect(occurrences.disclosure).not.toMatch(/total|every exception/iu);

        const users = model.body.fields.find((field) => field.id === 'posthog/users');
        if (users?.kind !== 'number') throw new Error('users must be a number field');
        expect(users.approximate).toBe(true);
        expect(users.disclosure).toBeNull();
    });

    it('reports a deferred detail-plane fact as pending rather than as an empty value', () => {
        const model = projectPosthogDetailSurface(detailInput(), null);
        const severity = model.body.fields.find((field) => field.id === 'posthog/severity');

        expect(severity?.kind).toBe('pending');
    });

    it('replaces the applied body with the live materialization for the same exact entry', () => {
        const applied = detailInput();
        const liveRow: PosthogIssueRow = {
            ...firstFixtureRow(),
            aggregations: { occurrences: 9_182, users: 77, sessions: 61 },
        };
        const live = TriageSourceObservationV1Schema.parse(
            posthogObservation({ row: liveRow }),
        );

        const model = projectPosthogDetailSurface(applied, live);

        expect(model.read).toEqual({ kind: 'materialized' });
        expect(model.body.origin).toBe('live');
        const occurrences = model.body.fields.find((field) => field.id === 'posthog/occurrences');
        if (occurrences?.kind !== 'number') throw new Error('occurrences must be a number field');
        expect(occurrences.value).toBe(9_182);
        // The applied target clock is a fact about the mount, not about the live read.
        expect(model.body.appliedObservedAtMs).toBe(1_760_000_900_000);
    });

    it('discloses a native state the live read disagrees with, and stays silent when it agrees', () => {
        const applied = detailInput();
        const resolvedRow: PosthogIssueRow = { ...firstFixtureRow(), nativeStatus: 'resolved' };
        const changed = TriageSourceObservationV1Schema.parse(
            posthogObservation({ row: resolvedRow }),
        );
        const unchanged = TriageSourceObservationV1Schema.parse(posthogObservation());

        expect(projectPosthogDetailSurface(applied, changed).nativeStateNow)
            .toEqual({ presentation: 'resolved', nativeLabel: 'resolved' });
        expect(projectPosthogDetailSurface(applied, unchanged).nativeStateNow).toBeNull();
        expect(projectPosthogDetailSurface(applied, null).nativeStateNow).toBeNull();
    });

    it('refuses a live result that names a different entry instead of following it', () => {
        const applied = detailInput();
        const otherRow: PosthogIssueRow = {
            ...firstFixtureRow(),
            id: '00000000-0000-4000-8000-0000000000ee',
        };
        const live = TriageSourceObservationV1Schema.parse(posthogObservation({ row: otherRow }));

        const model = projectPosthogDetailSurface(applied, live);

        expect(model.read).toEqual({ kind: 'refused', reason: 'localRefMismatch' });
        // A refused live read never blanks the body the mount already had.
        expect(model.body.origin).toBe('applied');
        expect(model.body.fields.length).toBeGreaterThan(0);
    });

    it('keeps the applied body visible when the live read is unresolved', () => {
        const applied = detailInput();
        const live = TriageSourceObservationV1Schema.parse({
            kind: 'unresolved',
            localRef: {
                kindId: applied.observation.entryRef.kindId,
                collisionScope: applied.observation.entryRef.collisionScope,
                entryId: applied.observation.entryRef.entryId,
            },
            failure: { class: 'permission', code: 'posthog/permission-denied' },
        });

        const model = projectPosthogDetailSurface(applied, live);

        expect(model.read).toEqual({
            kind: 'unavailable',
            failure: { class: 'permission', code: 'posthog/permission-denied' },
        });
        expect(model.body.origin).toBe('applied');
        expect(model.body.fields.length).toBeGreaterThan(0);
    });

    it('refuses an absence or merge arm this source never emits', () => {
        const applied = detailInput();
        const localRef = {
            kindId: applied.observation.entryRef.kindId,
            collisionScope: applied.observation.entryRef.collisionScope,
            entryId: applied.observation.entryRef.entryId,
        };
        const absent = TriageSourceObservationV1Schema.parse({ kind: 'absent', localRef });

        expect(projectPosthogDetailSurface(applied, absent).read).toEqual({
            kind: 'refused',
            reason: 'unsupportedObservation',
        });
    });
});
