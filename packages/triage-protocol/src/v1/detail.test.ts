import { describe, expect, it } from 'vitest';

import { createTriageSourceV1Fixture } from '../testing/v1/fixtures.js';
import { TriageDetailSurfaceInputV1Schema } from './detail.js';
import { TriagePrepareReviewWorkspaceResultV1Schema } from './workspace.js';

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

    it('has no originComposer field while its canonical projection is unpublished', () => {
        // COMPOSER-COMPOSABLE-REF: a Triage-local mirror, adoption wrapper, or
        // permissive JSON carrier for ComposerRefV1 is explicitly forbidden, so
        // the optional field is absent from V1 rather than faked.
        expect(TriageDetailSurfaceInputV1Schema.safeParse({
            ...fixture.detailInput,
            originComposer: { kind: 'session', sessionId: 'session-1' },
        }).success).toBe(false);
    });
});

describe('Triage review-workspace result', () => {
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
