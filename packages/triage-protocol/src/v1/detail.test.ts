import { describe, expect, it } from 'vitest';

import { createTriageSourceV1Fixture } from '../testing/v1/fixtures.js';
import {
    TriageDetailSurfaceInputV1JsonSchema,
    TriageDetailSurfaceInputV1Schema,
} from './detail.js';
import {
    TriagePrepareReviewWorkspaceInputV1Schema,
    TriagePrepareReviewWorkspaceResultV1Schema,
    projectTriagePrepareReviewWorkspaceInputV1,
} from './workspace.js';

const fixture = createTriageSourceV1Fixture();

describe('Triage detail surface input', () => {
    it('requires the bounded linked-Session projection', () => {
        const { linkedSessions: _dropped, ...withoutLinks } = fixture.detailInput;
        expect(TriageDetailSurfaceInputV1Schema.safeParse(withoutLinks).success).toBe(false);
        expect(TriageDetailSurfaceInputV1Schema.safeParse({
            ...fixture.detailInput,
            linkedSessions: [],
        }).success).toBe(true);
    });

    it('preserves an unavailable Session id without transcript metadata', () => {
        const parsed = TriageDetailSurfaceInputV1Schema.parse({
            ...fixture.detailInput,
            linkedSessions: [{ sessionId: 'session-tombstoned' }],
        });
        expect(parsed.linkedSessions).toEqual([{ sessionId: 'session-tombstoned' }]);
        expect(TriageDetailSurfaceInputV1Schema.safeParse({
            ...fixture.detailInput,
            linkedSessions: [{ sessionId: 'session-1', messages: [] }],
        }).success).toBe(false);
    });

    it('rejects an opaque storage tag anywhere a canonical ref belongs', () => {
        expect(TriageDetailSurfaceInputV1Schema.safeParse({
            ...fixture.detailInput,
            observation: {
                ...fixture.detailInput.observation,
                entryTag: 'sVsEDIcJ8L0lHpJ4gGxeJTFHmVYyZg2vJoKzDxOEnQY',
            },
        }).success).toBe(false);
    });

    it('keeps a source that pinned an older copy renderable when the host adds a field', () => {
        // Each source pins its own copy of this schema and gates its entire
        // detail render on one `safeParse` (for example
        // `scm-bitbucket/src/ui/renderSurface.tsx`), so a closed envelope makes
        // every future optional host field a total loss of that source's detail
        // body. The envelope therefore drops unknown outer keys.
        const parsed = TriageDetailSurfaceInputV1Schema.parse({
            ...fixture.detailInput,
            aFieldThisBuildDoesNotKnow: { v: 2, note: 'from a newer host' },
        });
        expect(Object.hasOwn(parsed, 'aFieldThisBuildDoesNotKnow')).toBe(false);
        expect(parsed.instance).toEqual(fixture.detailInput.instance);
        expect(parsed.linkedSessions).toEqual(fixture.detailInput.linkedSessions);

        // Tolerance stops at the envelope: the inner shapes carry identity and
        // admission authority and stay closed.
        for (const closedInner of [
            {
                ...fixture.detailInput,
                observation: { ...fixture.detailInput.observation, unknownInnerField: true },
            },
            {
                ...fixture.detailInput,
                linkedSessions: [{ sessionId: 'session-1', unknownInnerField: true }],
            },
        ]) {
            expect(TriageDetailSurfaceInputV1Schema.safeParse(closedInner).success).toBe(false);
        }
    });
});

/**
 * The Composer-origin ADDRESS is not carried here.
 *
 * PEP `03d1` §17.8 places `originComposer` in exactly one carrier — Triage's
 * closed private launch input at
 * `packages/plugins/triage/src/composer/entryDetailLaunchInput.ts`, whose own
 * suite owns the five host arms and their negatives. This envelope is
 * `additive-open/drop`, which is right for a forward-compatible presentation
 * payload and wrong for an address the destination resolves with an exact
 * `get(originComposer)`: dropping it silently would leave that destination
 * unable to reach the draft its reader came from, with no signal at all.
 *
 * A second carrier here would also widen the disclosure — this envelope is what
 * every third-party source plugin receives.
 */
describe('the Composer-origin address', () => {
    it('is not a field of the source detail envelope', () => {
        const parsed = TriageDetailSurfaceInputV1Schema.parse({
            ...fixture.detailInput,
            originComposer: { kind: 'session', sessionId: 'session-1' },
        });

        expect(Object.hasOwn(parsed, 'originComposer')).toBe(false);
        expect(TriageDetailSurfaceInputV1JsonSchema.properties?.originComposer).toBeUndefined();
    });
});

describe('Triage review-workspace result', () => {
    it('projects one source input and omits an unselected workspace', () => {
        const { v: _v, workspace: _workspace, ...facts } = fixture.prepareReviewWorkspaceInput;
        const projected = projectTriagePrepareReviewWorkspaceInputV1({
            ...facts,
            workspace: null,
        });

        expect(projected.v).toBe(1);
        expect(Object.hasOwn(projected, 'workspace')).toBe(false);
        expect(TriagePrepareReviewWorkspaceInputV1Schema.parse(projected)).toEqual(projected);
    });

    it('carries the source route into preparation and its canonical pull-request reference back out', () => {
        expect(TriagePrepareReviewWorkspaceInputV1Schema.safeParse({
            ...fixture.prepareReviewWorkspaceInput,
            lastKnownLocator: fixture.getResult.kind === 'present'
                ? fixture.getResult.locator
                : undefined,
        }).success).toBe(true);

        expect(TriagePrepareReviewWorkspaceResultV1Schema.safeParse({
            kind: 'prepared',
            repositoryPath: '/workspaces/example-repository',
            branch: 'review/pull-17',
            created: true,
            currentness: { kind: 'currentAtObservedHead' },
            pullRequest: { number: 17 },
        }).success).toBe(true);
    });

    it('keeps `created` the sole rollback authority on the only Session-composing arm', () => {
        expect(TriagePrepareReviewWorkspaceResultV1Schema.safeParse({
            kind: 'prepared',
            repositoryPath: '/workspaces/example-repository',
            branch: 'review/pull-17',
            currentness: { kind: 'currentAtObservedHead' },
        }).success).toBe(false);
    });

    it('requires the exact moved and stale head facts rather than a bare verdict', () => {
        expect(TriagePrepareReviewWorkspaceResultV1Schema.safeParse({
            kind: 'prepared',
            repositoryPath: '/workspaces/example-repository',
            branch: 'review/pull-17',
            created: false,
            currentness: { kind: 'movedToObservedHead' },
        }).success).toBe(false);
        expect(TriagePrepareReviewWorkspaceResultV1Schema.safeParse({
            kind: 'prepared',
            repositoryPath: '/workspaces/example-repository',
            branch: 'review/pull-17',
            created: false,
            currentness: {
                kind: 'preservedStale',
                resolvedHeadSha: 'aaaa',
                observedHeadSha: 'bbbb',
                reason: 'dirtyWorktree',
            },
            pullRequest: { number: 17 },
        }).success).toBe(true);
    });

    it('admits only the closed non-prepared arms', () => {
        for (const kind of ['workspaceRequired', 'workspaceMismatch', 'unsupported']) {
            expect(TriagePrepareReviewWorkspaceResultV1Schema.parse({ kind })).toEqual({ kind });
        }
        expect(TriagePrepareReviewWorkspaceResultV1Schema.safeParse({
            kind: 'unavailable',
            reason: 'scmResolver',
        }).success).toBe(true);
        expect(TriagePrepareReviewWorkspaceResultV1Schema.safeParse({
            kind: 'unavailable',
            reason: 'network',
        }).success).toBe(false);
        expect(TriagePrepareReviewWorkspaceResultV1Schema.safeParse({ kind: 'cancelled' }).success)
            .toBe(false);
    });
});
