import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '@/sync/ops/actions/defaultActionExecutor';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { reportCollectionLayout } from '@/dev/testkit/harness/collectionLayoutHarness';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { setActiveServerId } from '@/sync/domains/server/serverProfiles';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { storage } from '@/sync/domains/state/storageStore';
import { getAppliedActiveServerSnapshot, isAppliedActiveServerRuntimeAvailable, publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { deriveArtifactStoredKindV1, REVIEW_ARTIFACT_KIND_V1 } from '@happier-dev/protocol/artifacts/artifactKindV1';
import { ARTIFACT_LIST_PAGE_MAX_ITEMS_V1 } from '@happier-dev/protocol/artifacts/artifactListSelectionV1';
import { getReviewListSnapshot, reviewListKey } from '@/sync/store/domains/reviews/list';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { WorkspaceRouteBody } from '@/app/(app)/reviews';
import { artifactViewRoute } from '@/components/artifacts/artifactBrowserModel';
import { formatRelativeTimeShort } from '@/utils/time/formatShortRelativeTime';
import { t } from '@/text';

const routerPush = vi.hoisted(() => vi.fn());
// RN's physical recycler is absent from Test Renderer; keep real Collection rows beneath it.
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(
    (await import('@/dev/testkit/mocks/virtualizedList')).createCapturingFlatListMock().module,
));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({ pathname: '/reviews', router: { push: routerPush } }).module);

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
afterEach(async () => { await homes.reset(); routerPush.mockClear(); });

describe('/reviews live host', () => {
    it('renders real list metadata and withdraws demand while its retained page is hidden', async () => {
        const serverId = await homes.addHome({ serverUrl: 'https://reviews-host.example', name: 'Reviews', accountId: 'alice' });
        await setActiveServerId(serverId, { scope: 'device' });
        const previousScope = storage.getState().profileScope;
        const previousApplied = getAppliedActiveServerSnapshot();
        const previousAvailable = isAppliedActiveServerRuntimeAvailable();
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot(), true);
        storage.setState({ profileScope: { serverId, accountId: 'alice' } });
        let reads = 0;
        homes.answer(serverId, 'POST /v1/reviews/list', { select: () => {
            reads++;
            return { body: { items: [{ reviewId: 'review-live', projectSourceId: null, workflowId: null,
                subjectKind: 'repository', sourceKind: 'direct', state: 'completed', currentRoundOrdinal: 1,
                startedAt: 1, finishedAt: 2, createdAt: 1, updatedAt: 2, counts: { total: 3, needsDecision: 1 } }], cursor: null } };
        } });
        const page = (active: boolean) => <PluginSurfaceFocusEligibilityProvider active={active} presentationActive={active}>
            <WorkspaceRouteBody />
        </PluginSurfaceFocusEligibilityProvider>;
        const screen = await renderScreen(page(true));
        try {
            await waitForHomeGovernance(() => expect(screen.findByTestId('reviews:list')).not.toBeNull());
            await waitForHomeGovernance(() => expect(reads).toBe(1));
            const key = reviewListKey({ serverId, accountId: 'alice' }, { limit: ARTIFACT_LIST_PAGE_MAX_ITEMS_V1 });
            await waitForHomeGovernance(() => expect(getReviewListSnapshot(key).items?.[0]?.reviewId).toBe('review-live'));
            await reportCollectionLayout(screen, 'reviews:list');
            await waitForHomeGovernance(() => expect(screen.findHostByTestId('reviews:row:review-live')).not.toBeNull());
            expect(screen.findHostByTestId('reviews:row:review-live')?.props.accessibilityLabel)
                .toBe(`${t('detailsSurface.review.title')} · ${formatRelativeTimeShort(1, Date.now())}`);
            await screen.pressByTestIdAsync('reviews:row:review-live');
            expect(routerPush).toHaveBeenCalledWith(artifactViewRoute('review-live'));
            await act(async () => { screen.update(page(false)); });
            publishHomeAccountChange(serverId, ['review-live'], { changeKinds: ['artifact'],
                artifactKinds: [deriveArtifactStoredKindV1({ kind: REVIEW_ARTIFACT_KIND_V1 })] });
            await new Promise<void>(resolve => setImmediate(resolve));
            expect(reads).toBe(1);
            await act(async () => { screen.update(page(true)); });
            await waitForHomeGovernance(() => expect(reads).toBe(2));
        } finally {
            await screen.unmount();
            storage.setState({ profileScope: previousScope });
            publishAppliedActiveServerSnapshot(previousApplied, previousAvailable);
        }
    });
});
