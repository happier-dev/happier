import { describe, expect, it } from 'vitest';

import { buildActivityBadgeState } from './buildActivityBadgeState';

describe('buildActivityBadgeState', () => {
    it('counts a session once even when multiple attention reasons are active', () => {
        const state = buildActivityBadgeState({
            sessions: [
                {
                    id: 's1',
                    seq: 5,
                    lastViewedSessionSeq: 3,
                    pendingPermissionRequestCount: 2,
                    pendingUserActionRequestCount: 1,
                    pendingCount: 4,
                    metadata: { path: '', host: '' },
                } as any,
            ],
            numericInboxCount: 2,
            hasNonNumericInboxAttention: false,
        });

        expect(state).toEqual({
            count: 3,
            showNonNumericDot: false,
        });
    });

    it('shows a non-numeric dot when only dot-only inbox attention exists', () => {
        const state = buildActivityBadgeState({
            sessions: [],
            numericInboxCount: 0,
            hasNonNumericInboxAttention: true,
        });

        expect(state).toEqual({
            count: 0,
            showNonNumericDot: true,
        });
    });
});
