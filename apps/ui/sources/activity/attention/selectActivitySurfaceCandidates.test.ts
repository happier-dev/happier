import { describe, expect, it } from 'vitest';

import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { buildActivityOverviewSnapshot } from '@/activity/attention/buildActivityOverviewSnapshot';
import { resolveActivitySurfacePolicy } from '@/activity/attention/resolveActivitySurfacePolicy';

import { selectActivitySurfaceCandidates } from './selectActivitySurfaceCandidates';

describe('selectActivitySurfaceCandidates', () => {
    it('delegates candidate selection to the canonical slot resolver', () => {
        const overview = buildActivityOverviewSnapshot({
            sessions: [
                createSessionFixture({
                    id: 'permission',
                    active: true,
                    presence: 'online',
                    pendingPermissionRequestCount: 1,
                }),
                createSessionFixture({
                    id: 'action',
                    active: true,
                    presence: 'online',
                    pendingUserActionRequestCount: 1,
                }),
            ],
        });

        const candidates = selectActivitySurfaceCandidates({
            overview,
            policy: resolveActivitySurfacePolicy({
                liveActivitiesMode: 'attention',
                liveActivitiesStrategy: 'dynamic_primary',
                liveActivitiesMaxConcurrent: 2,
            }),
        });

        expect(candidates.map((candidate) => candidate.sessionId)).toEqual(['permission']);
    });
});
