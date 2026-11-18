import { afterEach, expect, it } from 'vitest';
import type { ReviewHumanStateV1 } from '@happier-dev/protocol/reviews/reviewHumanV1';

import { renderHook, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { useReviewHumanActions } = await import('./useReviewHumanActions');
await import('@/sync/ops/actions/defaultActionExecutor');

afterEach(async () => {
    await standardCleanup();
    await homes.reset();
});

it('requests the selected Team and submits the authenticated person’s verdict for the opened Review round', async () => {
    const serverId = await homes.addHome({ name: 'Home', serverUrl: 'https://review-human.example', accountId: 'alice', currentAccount: true });
    const scope = createServerAccountScope(serverId, 'alice')!;
    const human: ReviewHumanStateV1 = {
        reviewId: 'opened-review', roundOrdinal: 2, requests: [], verdicts: [],
        needsYou: { reviewId: 'opened-review', roundOrdinal: 2, reason: 'review_needs_you',
            requestedVerdict: true, pendingDecisions: false, needsYou: true, canSubmitVerdict: true },
    };
    const requestPath = '/v1/reviews/opened-review/reviewers';
    const verdictPath = '/v1/reviews/opened-review/verdicts';
    const reviewers = [{ principal: { kind: 'team' as const, teamId: 'review-team' }, required: true }];
    homes.answer(serverId, `POST ${requestPath}`, {
        body: { ...human, requests: [{ ...reviewers[0], id: 'asked', roundOrdinal: 2, needsAccess: true }] },
    });
    homes.answer(serverId, `POST ${verdictPath}`, {
        body: { ...human, verdicts: [{ accountId: 'alice', roundOrdinal: 2, verdict: 'request_changes', submittedAt: 1, revision: 1 }] },
    });

    const hook = await renderHook(() => useReviewHumanActions(scope, human));
    try {
        await waitForHomeGovernance(() => expect(hook.getCurrent().ready).toBe(true));
        const reviewersResult = await hook.getCurrent().setReviewers?.(reviewers);
        expect(reviewersResult, JSON.stringify(reviewersResult)).toMatchObject({
            ok: true, result: { requests: [{ needsAccess: true }] },
        });
        const verdictResult = await hook.getCurrent().submitVerdict?.('request_changes');
        expect(verdictResult, JSON.stringify(verdictResult)).toMatchObject({
            ok: true, result: { verdicts: [{ accountId: 'alice', roundOrdinal: 2, verdict: 'request_changes' }] },
        });
        expect(homes.requestsFor(requestPath).map(request => request.input)).toEqual([{ roundOrdinal: 2, reviewers }]);
        expect(homes.requestsFor(verdictPath).map(request => request.input)).toEqual([{ roundOrdinal: 2, verdict: 'request_changes' }]);
    } finally {
        await hook.unmount();
    }
});
