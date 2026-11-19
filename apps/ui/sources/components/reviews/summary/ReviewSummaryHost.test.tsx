import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import '@/sync/ops/actions/defaultActionExecutor';
import { renderScreen } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { setActiveServerId } from '@/sync/domains/server/serverProfiles';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { deriveArtifactStoredKindV1, REVIEW_ARTIFACT_KIND_V1 } from '@happier-dev/protocol/artifacts/artifactKindV1';
import { t } from '@/text';
import { ReviewSummaryHost } from './ReviewSummaryHost';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
afterEach(async () => { await homes.reset(); });

it('opens an embedded verdict from the addressed Review metadata without reading its Artifact body', async () => {
    const serverId = await homes.addHome({ serverUrl: 'https://summary-review.example', name: 'Summary', accountId: 'alice' });
    const otherHome = await homes.addHome({ serverUrl: 'https://summary-active.example', name: 'Active', accountId: 'bob' });
    await setActiveServerId(otherHome, { scope: 'device' });
    homes.answer(serverId, 'POST /v1/reviews/get', { select: () => ({ body: {
        review: { reviewId: 'summary-review', projectSourceId: null, workflowId: null, subjectKind: 'repository', sourceKind: 'direct',
            state: 'completed', currentRoundOrdinal: 1, startedAt: 1, finishedAt: 2, createdAt: 1, updatedAt: 2,
            counts: { total: 0, needsDecision: 0 } },
        human: { reviewId: 'summary-review', roundOrdinal: 1, requests: [], verdicts: [],
            needsYou: { reviewId: 'summary-review', roundOrdinal: 1, reason: 'review_needs_you', needsYou: false,
                requestedVerdict: false, pendingDecisions: false, canSubmitVerdict: false } },
    } }) });
    const open = vi.fn();
    const screen = await renderScreen(<ReviewSummaryHost reviewId="summary-review" scope={{ serverId, accountId: 'alice' }} onOpenReview={open} />);
    try {
        await waitForHomeGovernance(() => expect(screen.getTextContent()).toContain(t('reviewWalkthrough.detail.glanceNoFindings')));
        expect(homes.requestsFor('/v1/reviews/get').map(request => request.serverId)).toEqual([serverId]);
        expect(homes.requests.some(request => request.path.startsWith('/v1/artifacts'))).toBe(false);
        await screen.pressByTestIdAsync('review-summary:open');
        expect(open).toHaveBeenCalledOnce();
        homes.answer(serverId, 'POST /v1/reviews/get', { status: 503, body: { error: 'home_temporarily_unavailable' } });
        publishHomeAccountChange(serverId, ['summary-review'], { changeKinds: ['artifact'],
            artifactKinds: [deriveArtifactStoredKindV1({ kind: REVIEW_ARTIFACT_KIND_V1 })] });
        await waitForHomeGovernance(() => expect(screen.findByTestId('review-summary:retry')).not.toBeNull());
        expect(screen.getTextContent()).toContain(t('reviewWalkthrough.detail.glanceNoFindings'));
        await screen.update(<ReviewSummaryHost reviewId="summary-review" scope={{ serverId, accountId: 'different-account' }} onOpenReview={open} />);
        expect(screen.getTextContent()).not.toContain(t('reviewWalkthrough.detail.glanceNoFindings'));
        expect(homes.requestsFor('/v1/reviews/get')).toHaveLength(2);
    } finally { await screen.unmount(); }
});
