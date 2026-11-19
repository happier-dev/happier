import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useReviewDetail } from './useReviewDetail';
import '@/sync/ops/actions/defaultActionExecutor';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { setActiveServerId } from '@/sync/domains/server/serverProfiles';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { deriveArtifactStoredKindV1, REVIEW_ARTIFACT_KIND_V1 } from '@happier-dev/protocol/artifacts/artifactKindV1';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { Text } from '@/components/ui/text/Text';
import { flushHookEffects } from '@/dev/testkit';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
afterEach(async () => { await homes.reset(); });

function OpenedReview({ scope }: Readonly<{ scope: ServerAccountScope | null }>) {
    const detail = useReviewDetail('same-id', { scope });
    return <><Text testID="opened-review">{detail.data?.review.counts.needsDecision ?? detail.status}</Text>
        <Text testID="review-home">{detail.scope?.serverId ?? 'none'}</Text></>;
}

describe('opened Review demand', () => {
    it('uses its named Account instead of the active Home and reconnects only when presented', async () => {
        const serverId = await homes.addHome({ serverUrl: 'https://opened-review.example', name: 'Opened', accountId: 'alice' });
        const otherHome = await homes.addHome({ serverUrl: 'https://active-review.example', name: 'Active', accountId: 'bob' });
        await setActiveServerId(otherHome, { scope: 'device' });
        let reads = 0;
        let pending = 1;
        homes.answer(serverId, 'POST /v1/reviews/get', { select: () => {
            reads++;
            return { body: {
                review: { reviewId: 'same-id', projectSourceId: null, workflowId: null, subjectKind: 'repository', sourceKind: 'direct',
                    state: 'completed', currentRoundOrdinal: 1, startedAt: 1, finishedAt: 2, createdAt: 1, updatedAt: 2,
                    counts: { total: 3, needsDecision: pending } },
                human: { reviewId: 'same-id', roundOrdinal: 1, requests: [], verdicts: [],
                    needsYou: { reviewId: 'same-id', roundOrdinal: 1, reason: 'review_needs_you', needsYou: true,
                        requestedVerdict: false, pendingDecisions: true, canSubmitVerdict: false } },
            } };
        } });
        const page = (active: boolean, accountId = 'alice') =>
            <PluginSurfaceFocusEligibilityProvider active={active} presentationActive={active}>
                <OpenedReview scope={{ serverId, accountId }} />
            </PluginSurfaceFocusEligibilityProvider>;
        const screen = await renderScreen(page(true));
        try {
            await waitForHomeGovernance(() => expect(screen.findHostByTestId('opened-review')?.props.children).toBe(1));
            expect(reads).toBe(1);
            await act(async () => { screen.update(page(false)); });
            pending = 2;
            publishHomeAccountChange(serverId, ['same-id'], { changeKinds: ['artifact'],
                artifactKinds: [deriveArtifactStoredKindV1({ kind: REVIEW_ARTIFACT_KIND_V1 })] });
            await new Promise<void>(resolve => setImmediate(resolve));
            expect(reads).toBe(1);
            await act(async () => { screen.update(page(true)); });
            await waitForHomeGovernance(() => expect(screen.findHostByTestId('opened-review')?.props.children).toBe(2));
            await act(async () => { screen.update(page(true, 'different-account')); });
            expect(screen.findHostByTestId('opened-review')?.props.children).toBe('idle');
            expect(reads).toBe(2);
            await act(async () => { screen.update(<OpenedReview scope={null} />); });
            await flushHookEffects({ cycles: 20 });
            expect(screen.findHostByTestId('review-home')?.props.children).toBe('none');
            expect(screen.findHostByTestId('opened-review')?.props.children).toBe('idle');
            expect(reads).toBe(2);
        } finally { await screen.unmount(); }
    });
});
