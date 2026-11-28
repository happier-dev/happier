import * as React from 'react';
import { Dimensions } from 'react-native';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import type { ReviewListResponseV1 } from '@happier-dev/protocol/reviews/reviewListV1';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@/sync/ops/actions/defaultActionExecutor';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { reportCollectionLayout } from '@/dev/testkit/harness/collectionLayoutHarness';
import { withPopoverWebGlobals } from '@/dev/testkit/harness/popoverHarness';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { setActiveServerId } from '@/sync/domains/server/serverProfiles';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { storage } from '@/sync/domains/state/storageStore';
import { sync } from '@/sync/sync';
import { getAppliedActiveServerSnapshot, isAppliedActiveServerRuntimeAvailable, publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { deriveArtifactStoredKindV1, REVIEW_ARTIFACT_KIND_V1 } from '@happier-dev/protocol/artifacts/artifactKindV1';
import { ARTIFACT_LIST_PAGE_MAX_ITEMS_V1 } from '@happier-dev/protocol/artifacts/artifactListSelectionV1';
import { getReviewListSnapshot, retireReviewList, reviewListKey } from '@/sync/store/domains/reviews/list';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { AppShellColumnContext } from '@/components/navigation/shell/appRail/appShellColumnContext';
import { WorkspaceRouteBody } from '@/app/(app)/reviews';
import { ReviewsListHost } from './ReviewsListHost';
import { reviewRowFact, ReviewRowFactText } from './list/reviewRowFact';
import { findHomeHubBuiltinSection } from '@/components/hub/homeHubSections';
import { presentReadyHome } from '@/components/hub/homeArrival';
import { HOME_HUB_BUILTIN_DEFINITIONS, getHomeHubDefaultLayoutV1, resolveHomeHubLayout } from '@/components/hub/layout/homeHubLayout';
import { artifactViewRoute } from '@/components/artifacts/artifactBrowserModel';
import { formatShortRelativeTimeAt } from '@/utils/time/formatShortRelativeTime';
import { t } from '@/text';
import { createDefaultCollectionSpaceV1 } from '@happier-dev/protocol/collections/spaces/collectionSpacesV1';
import { COLLECTION_SPACE_ENABLEMENT_SETTING_KEYS_V1 } from '@happier-dev/protocol/collections/spaces/collectionSpaceEnablementV1';
import { settingsParse } from '@/sync/domains/settings/settings';
import { UniversalSearchRuntimeProvider, type UniversalSearchRuntime } from '@/components/appShell/search/UniversalSearchRuntimeContext';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { ResourceSpaceMembershipMutationV1Schema } from '@happier-dev/protocol/collections/spaces/resourceSpaceMembershipV1';
import { ReviewListRequestV1Schema } from '@happier-dev/protocol/reviews/reviewListV1';

const routerPush = vi.hoisted(() => vi.fn());
const membershipAlert = vi.hoisted(() => vi.fn());
const modalShow = vi.hoisted(() => vi.fn((_config: { component: { name?: string }; props?: Record<string, unknown> }) => 'review-start-sheet'));
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({
    spies: { alert: membershipAlert, show: modalShow as never } }).module);
// RN's physical recycler is absent from Test Renderer; keep real Collection rows beneath it.
vi.mock('react-native', async () => {
    const lists = await import('@/dev/testkit/mocks/virtualizedList');
    return (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
        ...lists.createCapturingFlatListMock().module,
        ...lists.createCapturingSectionListMock().module,
    });
});
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
// Menus and editors on this page render inline under Test Renderer (no window).
vi.mock('@/components/ui/popover', async original => (await import('@/dev/testkit/mocks/popover')).createInlinePopoverModuleMock(original));
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({ pathname: '/reviews', router: { push: routerPush } }).module);

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
let restoreDimensions = () => {};
beforeEach(() => {
    const dimensions = vi.spyOn(Dimensions, 'get').mockReturnValue({ width: 390, height: 900, scale: 1, fontScale: 1 });
    restoreDimensions = () => dimensions.mockRestore();
});
afterEach(async () => { await homes.reset(); routerPush.mockClear(); membershipAlert.mockClear(); modalShow.mockClear(); restoreDimensions(); });

describe('reviewRowFact', () => {
    const row = (patch: Partial<ReviewListResponseV1['items'][number]>, needsYou: Partial<ReviewListResponseV1['items'][number]['needsYou']> = {}) => ({
        reviewId: 'r', projectSourceId: null, workflowId: null, subjectKind: 'repository', sourceKind: 'direct', state: 'completed',
        currentRoundOrdinal: 1, startedAt: 1, finishedAt: 2, createdAt: 1, updatedAt: 2, counts: { total: 2, needsDecision: 0 },
        needsYou: { reviewId: 'r', roundOrdinal: 1, reason: 'review_needs_you', needsYou: false, requestedVerdict: false,
            pendingDecisions: false, canSubmitVerdict: false, ...needsYou }, ...patch,
    }) as ReviewListResponseV1['items'][number];
    it('says one fact: what needs the person, else how the Review came out, and nothing while running', () => {
        expect(reviewRowFact(row({ counts: { total: 3, needsDecision: 2 } }))).toEqual(
            { label: t('reviewWalkthrough.detail.glanceToDecide', { count: 2 }), tone: 'attention' });
        expect(reviewRowFact(row({}, { needsYou: true, requestedVerdict: true }))).toEqual(
            { label: t('reviewWalkthrough.detail.requestedFromYou'), tone: 'attention' });
        expect(reviewRowFact(row({ counts: { total: 0, needsDecision: 0 } }))?.label).toBe(t('reviewWalkthrough.detail.glanceNoFindings'));
        expect(reviewRowFact(row({}))?.label).toBe(t('reviewWalkthrough.detail.glanceAllDecided'));
        expect(reviewRowFact(row({ state: 'running', counts: { total: 0, needsDecision: 0 } }))).toBeNull();
    });
    it('marks a failed Review as failed, with its state word and the semantic failure glyph (DESIGN-REVIEWS-OPUS-1128 D)', async () => {
        const failed = row({ state: 'failed', counts: { total: 0, needsDecision: 0 } });
        expect(reviewRowFact(failed)).toEqual(
            { label: t('reviewWalkthrough.collection.stateFailed'), tone: 'danger', saysState: true });
        const screen = await renderScreen(<ReviewRowFactText item={failed} />);
        try {
            expect(screen.findAll(node => node.props.name === 'warning')).not.toHaveLength(0);
            expect(screen.getTextContent()).toContain(t('reviewWalkthrough.collection.stateFailed'));
        } finally { await screen.unmount(); }
    });
});

describe('/reviews live host', () => {
    it.each(['list', 'detail', 'summary'] as const)('keeps the %s content beside Home offline recovery until normal Retry succeeds', async (surface) => {
        const serverUrl = 'https://review-offline.example';
        const serverId = await homes.addHome({ serverUrl, name: 'Review offline', accountId: 'alice', currentAccount: true });
        homes.answer(serverId, '/v1/machines', { body: [] });
        const reviewId = 'retained-offline-review';
        const review = {
            reviewId, projectSourceId: null, workflowId: null, subjectKind: 'repository', sourceKind: 'direct',
            state: 'completed', currentRoundOrdinal: 1, startedAt: 1, finishedAt: 2, createdAt: 1, updatedAt: 2,
            counts: { total: 1, needsDecision: 1 }, needsYou: { reviewId, roundOrdinal: 1, reason: 'review_needs_you',
                needsYou: true, requestedVerdict: false, pendingDecisions: true, canSubmitVerdict: true },
        } satisfies ReviewListResponseV1['items'][number];
        homes.answer(serverId, 'POST /v1/reviews/list', { body: { items: [review], cursor: null } });
        const { needsYou, ...metadata } = review;
        homes.answer(serverId, 'POST /v1/reviews/get', { body: { review: metadata, human: { reviewId, roundOrdinal: 1, requests: [], verdicts: [], needsYou } } });
        homes.answer(serverId, 'POST /v1/reviews/comments', { body: { items: [], cursor: null } });
        homes.artifacts(serverId).replaceStoredRow({ id: reviewId, ownerAccountId: 'alice', access: 'owner',
            publicAudience: 'none', encryptionMode: 'plain', headerVersion: 1, bodyVersion: 1, seq: 1,
            createdAt: 1, updatedAt: 1, dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
            header: encodePlainArtifactStoredContent({ kind: REVIEW_ARTIFACT_KIND_V1, v: 1, reviewId, title: 'Retained Review' }),
            body: encodePlainArtifactStoredContent({ body: JSON.stringify({ v: 1, rounds: [] }) }) });
        const connection = await restoreServerAccountForTest({ serverUrl, accountId: 'alice', request: homes.request, requestOwnsReachabilityProbes: true, configureSocket: configureConnectedServerSocketBoundary });
        await sync.awaitBootstrapForegroundAcquisition();
        const { ReviewDetailHost } = await import('./detail/ReviewDetailHost');
        const { ReviewSummaryHost } = await import('./summary/ReviewSummaryHost');
        const artifact = { id: reviewId, sourceServerId: serverId, title: 'Retained Review', isDecrypted: true,
            header: { kind: REVIEW_ARTIFACT_KIND_V1, v: 1 as const, reviewId, title: 'Retained Review' },
            body: JSON.stringify({ v: 1, rounds: [{ ordinal: 1, state: 'completed', startedAt: 1, finishedAt: 2, reviewerIds: [], runs: [] }] }),
            ownerAccountId: 'alice', access: 'owner', storageMode: 'plain', headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 } satisfies DecryptedArtifact;
        const screen = await renderScreen(surface === 'list' ? <ReviewsListHost />
            : surface === 'detail' ? <ReviewDetailHost artifact={artifact} bodyState="ready" onRetry={() => {}} />
            : <ReviewSummaryHost reviewId={reviewId} />);
        const expectContent = () => surface === 'list'
            ? expect(screen.findHostByTestId(`reviews:row:${reviewId}`)).not.toBeNull()
            : surface === 'summary' ? expect(screen.findByTestId('review-summary')).not.toBeNull()
            : expect(screen.getTextContent()).toContain('Retained Review');
        try {
            if (surface === 'list') await reportCollectionLayout(screen, 'reviews:list');
            await vi.waitFor(expectContent);
            const { retryActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
            // The same physical HTTP boundary as an offline browser's normal connection-menu Retry.
            homes.answer(serverId, '/v1/auth/ping', { select: () => { throw new TypeError('Failed to fetch'); } });
            await act(async () => { await retryActiveServerConnection(); });
            await vi.waitFor(() => expect(storage.getState().endpointStatus).toBe('offline'));
            expect(screen.findByTestId('home-unreachable')).not.toBeNull();
            expectContent();
            homes.answer(serverId, '/v1/auth/ping', { body: {} });
            await screen.pressByTestIdAsync('home-unreachable-retry');
            await vi.waitFor(() => expect({ endpoint: storage.getState().endpointStatus, socket: storage.getState().socketStatus }).toEqual({ endpoint: 'online', socket: 'connected' }));
            expect(screen.findByTestId('home-unreachable')).toBeNull();
            expectContent();
        } finally { await screen.unmount(); await connection.dispose(); }
    });
    it('opens actionable Reviews after Home arrival without a second toolbar or automatic page drain', async () => {
        const section = findHomeHubBuiltinSection('reviews');
        expect(section, 'Home registers the Reviews consumer').not.toBeNull();
        expect(resolveHomeHubLayout(getHomeHubDefaultLayoutV1(), HOME_HUB_BUILTIN_DEFINITIONS, []).sections)
            .toContainEqual(expect.objectContaining({ id: 'reviews', hidden: false }));
        const serverId = await homes.addHome({ serverUrl: 'https://home-reviews.example', name: 'Reviews', accountId: 'alice' });
        await setActiveServerId(serverId, { scope: 'device' });
        const previousScope = storage.getState().profileScope;
        const previousApplied = getAppliedActiveServerSnapshot();
        const previousAvailable = isAppliedActiveServerRuntimeAvailable();
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot(), true);
        storage.setState({ profileScope: { serverId, accountId: 'alice' } });
        const items: ReviewListResponseV1['items'] = ['needs', 'running', 'finished'].map(reviewId => ({
            reviewId, projectSourceId: null, workflowId: null, subjectKind: 'repository', sourceKind: 'direct',
            state: reviewId === 'running' ? 'running' : 'completed', currentRoundOrdinal: 1,
            startedAt: 1, finishedAt: reviewId === 'running' ? null : 2, createdAt: 1, updatedAt: 2,
            // An aggregate pending count does not make a Review need this person's decision.
            counts: { total: 8, needsDecision: 8 }, needsYou: { reviewId, roundOrdinal: 1, reason: 'review_needs_you',
                needsYou: reviewId === 'needs', requestedVerdict: reviewId === 'needs', pendingDecisions: false,
                canSubmitVerdict: reviewId === 'needs' },
        }));
        let reads = 0;
        homes.answer(serverId, 'POST /v1/reviews/list', { select: () => {
            reads++;
            return { body: { items, cursor: 'next-page' } };
        } });
        for (const item of items) homes.artifacts(serverId).replaceStoredRow({ id: item.reviewId, ownerAccountId: 'alice', access: 'owner',
            publicAudience: 'none', encryptionMode: 'plain', headerVersion: 1, bodyVersion: 1, seq: 1,
            createdAt: 1, updatedAt: 1, dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
            header: encodePlainArtifactStoredContent({ kind: REVIEW_ARTIFACT_KIND_V1, v: 1, reviewId: item.reviewId, title: `Exact ${item.reviewId}` }),
            body: encodePlainArtifactStoredContent({ body: JSON.stringify({ v: 1, rounds: [] }) }) });
        const connection = await restoreServerAccountForTest({ serverUrl: 'https://home-reviews.example', accountId: 'alice', request: homes.request });
        await sync.awaitBootstrapForegroundAcquisition();
        const screen = await renderScreen(<PluginSurfaceFocusEligibilityProvider active presentationActive>
            {section!.render({ menu: <React.Fragment />, placeholder: '', frameStyle: 'plain', composerSuggestions: 'none' })}
        </PluginSurfaceFocusEligibilityProvider>);
        let withdrawHome: (() => void) | undefined;
        try {
            expect(reads).toBe(0);
            expect(screen.findHostByTestId('reviews:home')).toBeNull();
            await act(async () => { withdrawHome = presentReadyHome(); });
            await vi.waitFor(() => expect(screen.findByTestId('reviews:home')).not.toBeNull());
            await reportCollectionLayout(screen, 'reviews:home');
            await waitForHomeGovernance(() => expect(screen.findHostByTestId('reviews:home:row:needs')).not.toBeNull());
            expect(screen.findHostByTestId('reviews:home:row:running')).not.toBeNull();
            expect(screen.findHostByTestId('reviews:home:row:finished')).toBeNull();
            // Home's section is one short list under its own title (U8 G2): no bands, the whole collection one press away.
            expect(screen.getTextContent()).not.toContain(t('reviewWalkthrough.collection.needsYourDecision'));
            expect(screen.findByTestId('reviews:scope-line')).toBeNull();
            expect(reads).toBe(1);
            await screen.pressByTestIdAsync('reviews:home:row:needs');
            expect(routerPush).toHaveBeenCalledWith(artifactViewRoute('needs'));
            expect(screen.findHostByTestId('reviews:home:continuation:all')?.props.accessibilityLabel)
                .toBe(t('reviewWalkthrough.collection.showAll', { count: 2 }));
            await screen.pressByTestIdAsync('reviews:home:continuation:all');
            expect(routerPush).toHaveBeenLastCalledWith('/reviews');
            expect(reads).toBe(1);
        } finally {
            await screen.unmount();
            withdrawHome?.();
            await connection.dispose();
            storage.setState({ profileScope: previousScope });
            publishAppliedActiveServerSnapshot(previousApplied, previousAvailable);
        }
    });
    it.each([true, false])('beside the column at 1440 opens the latest Review in place and keeps the view controls on the column (Reviews=%s)', async hasReviews => {
        vi.spyOn(Dimensions, 'get').mockReturnValue({ width: 1440, height: 900, scale: 1, fontScale: 1 });
        const serverUrl = `https://reviews-latest-${hasReviews}.example`;
        const serverId = await homes.addHome({ serverUrl, name: 'Reviews latest', accountId: 'alice', currentAccount: true });
        const row = (reviewId: string): ReviewListResponseV1['items'][number] => ({
            reviewId, projectSourceId: null, workflowId: null, subjectKind: 'repository', sourceKind: 'direct', state: 'completed',
            currentRoundOrdinal: 1, startedAt: 1, finishedAt: 2, createdAt: 1, updatedAt: 2, counts: { total: 0, needsDecision: 0 },
            needsYou: { reviewId, roundOrdinal: 1, reason: 'review_needs_you', needsYou: false, requestedVerdict: false,
                pendingDecisions: false, canSubmitVerdict: false },
        });
        const items = hasReviews ? [row('latest'), row('older')] : [];
        homes.answer(serverId, 'POST /v1/reviews/list', { body: { items, cursor: null } });
        const opened: string[] = [];
        homes.answer(serverId, 'POST /v1/reviews/get', { select: input => {
            const reviewId = (input as { reviewId: string }).reviewId;
            opened.push(reviewId);
            const { needsYou, ...review } = row(reviewId);
            return { body: { review, human: { reviewId, roundOrdinal: 1, requests: [], verdicts: [], needsYou } } };
        } });
        homes.answer(serverId, 'POST /v1/reviews/comments', { body: { items: [], cursor: null } });
        for (const item of items) homes.artifacts(serverId).replaceStoredRow({ id: item.reviewId, ownerAccountId: 'alice', access: 'owner',
            publicAudience: 'none', encryptionMode: 'plain', headerVersion: 1, bodyVersion: 1, seq: 1,
            createdAt: 1, updatedAt: 1, dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
            header: encodePlainArtifactStoredContent({ kind: REVIEW_ARTIFACT_KIND_V1, v: 1, reviewId: item.reviewId, title: `Exact ${item.reviewId}` }),
            body: encodePlainArtifactStoredContent({ body: JSON.stringify({ v: 1, rounds: [] }) }) });
        const connection = await restoreServerAccountForTest({ serverUrl, accountId: 'alice', request: homes.request });
        await sync.awaitBootstrapForegroundAcquisition();
        const { View } = await import('react-native');
        const restorePopoverGlobals = withPopoverWebGlobals();
        const screen = await renderScreen(<PluginSurfaceFocusEligibilityProvider active presentationActive>
            <AppShellColumnContext.Provider value={{ present: true, columnVisible: true }}>
                <View testID="test:shell-column"><ReviewsListHost surface="column" /></View>
                <View testID="test:page"><WorkspaceRouteBody /></View>
            </AppShellColumnContext.Provider>
        </PluginSurfaceFocusEligibilityProvider>);
        const region = (id: string) => screen.findHostByTestId(id)!;
        const inRegion = (id: string, testID: string) => region(id).findAll(node => node.props.testID === testID).length > 0;
        const textIn = (node: { children: readonly (string | { children: readonly unknown[] })[] }): string =>
            node.children.map(child => typeof child === 'string' ? child : textIn(child as never)).join('');
        try {
            // The list's own controls stand at the head of the column it narrows; the page beside it holds none.
            await waitForHomeGovernance(() => expect(inRegion('test:shell-column', 'reviews:scope-line')).toBe(true));
            expect(inRegion('test:page', 'reviews:scope-line')).toBe(false);
            expect(inRegion('test:page', 'reviews:list')).toBe(false);
            if (!hasReviews) {
                await waitForHomeGovernance(() => expect(inRegion('test:page', 'reviews:empty:start')).toBe(true));
                expect(screen.getTextContent()).toContain(t('reviewWalkthrough.collection.columnEmpty'));
                expect(screen.findByTestId('review-detail:header')).toBeNull();
                expect(screen.findAllHostsByTestId('reviews:start')).toHaveLength(0);
                expect(opened).toEqual([]);
                return;
            }
            // No Review open and the list has some: the latest opens in place, without a route write.
            await waitForHomeGovernance(() => expect(screen.findByTestId('review-detail:header')).not.toBeNull());
            expect(inRegion('test:page', 'review-detail:header')).toBe(true);
            expect(textIn(region('test:page'))).toContain('Exact latest');
            expect(screen.findByTestId('reviews:none-open')).toBeNull();
            expect(opened).toEqual(['latest']);
            expect(inRegion('test:shell-column', 'reviews:start')).toBe(true);
            expect(routerPush).not.toHaveBeenCalled();
            // Narrowing the column opens the latest Review that still matches; a filtered-out one never stays open.
            await screen.pressByTestIdAsync('reviews:search-toggle');
            await act(async () => { screen.changeTextByTestId('reviews:search', 'Exact older'); });
            await waitForHomeGovernance(() => expect(screen.findHostByTestId('reviews:column:row:latest')).toBeNull());
            await waitForHomeGovernance(() => expect(textIn(region('test:page'))).toContain('Exact older'));
            expect(textIn(region('test:page'))).not.toContain('Exact latest');
            await act(async () => { screen.changeTextByTestId('reviews:search', 'matches nothing'); });
            await waitForHomeGovernance(() => expect(screen.findByTestId('reviews:none-open')).not.toBeNull());
            expect(screen.findByTestId('review-detail:header')).toBeNull();
            expect(routerPush).not.toHaveBeenCalled();
        } finally {
            await screen.unmount();
            await connection.dispose();
            restorePopoverGlobals();
        }
    });
    it.each([['phone', 390, false], ['collapsed desktop', 1024, false]] as const)('projects the %s collection from per-person attention and shares list, titles and search demand', async (surface, width, columnVisible) => {
        vi.spyOn(Dimensions, 'get').mockReturnValue({ width, height: 900, scale: 1, fontScale: 1 });
        const serverUrl = `https://review-groups-${surface.replaceAll(' ', '-')}.example`;
        const serverId = await homes.addHome({ serverUrl, name: 'Review groups', accountId: 'alice', currentAccount: true });
        const row = (reviewId: string, projectSourceId: string, state: 'running' | 'completed', needsYou: boolean): ReviewListResponseV1['items'][number] => ({
            reviewId, projectSourceId, workflowId: null, subjectKind: 'repository', sourceKind: 'direct', state,
            currentRoundOrdinal: 1, startedAt: 1, finishedAt: state === 'running' ? null : 2, createdAt: 1, updatedAt: 2,
            counts: { total: 8, needsDecision: 8 }, needsYou: { reviewId, roundOrdinal: 1, reason: 'review_needs_you',
                needsYou, requestedVerdict: needsYou, pendingDecisions: false, canSubmitVerdict: needsYou },
        });
        const items = [row('needs', 'source-a', 'completed', true), row('running', 'source-b', 'running', false),
            row('finished', 'source-a', 'completed', false), row('elsewhere', 'source-b', 'completed', false)];
        for (const item of items) homes.artifacts(serverId).replaceStoredRow({ id: item.reviewId, ownerAccountId: 'alice', access: 'owner',
            publicAudience: 'none', encryptionMode: 'plain', headerVersion: 1, bodyVersion: 1, seq: 1,
            createdAt: 1, updatedAt: 1, dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
            header: encodePlainArtifactStoredContent({ kind: REVIEW_ARTIFACT_KIND_V1, v: 1, reviewId: item.reviewId, title: `Exact ${item.reviewId}` }),
            body: encodePlainArtifactStoredContent({ body: JSON.stringify({ v: 1, rounds: [] }) }) });
        homes.answer(serverId, 'POST /v1/reviews/list', { body: { items, cursor: null } });
        for (const [id, name] of [['source-a', 'Happier'], ['source-b', 'Website']]) homes.answer(serverId, `/v1/projects/sources/${id}`, {
            body: { ok: true, source: { id, name, revision: 1, audience: [], createdByAccountId: 'alice' }, canManage: true },
        });
        const connection = await restoreServerAccountForTest({ serverUrl, accountId: 'alice', request: homes.request });
        // Measure the visible collection after the ordinary bootstrap's conservative recovery wake.
        await sync.awaitBootstrapForegroundAcquisition();
        // Machine inventory is an eager Home bootstrap read, independent of this collection's demand.
        await waitForHomeGovernance(() => expect(homes.requests.some(request => new URL(request.path, serverUrl).pathname === '/v1/machines')).toBe(true));
        items.forEach(item => storage.getState().deleteArtifact(item.reviewId));
        const before = homes.requests.length;
        const page = (active: boolean) => <PluginSurfaceFocusEligibilityProvider active={active} presentationActive={active}>
            <AppShellColumnContext.Provider value={{ present: width > 390, columnVisible }}>
                <WorkspaceRouteBody />{columnVisible ? <ReviewsListHost surface="column" /> : null}
            </AppShellColumnContext.Provider>
        </PluginSurfaceFocusEligibilityProvider>;
        const screen = await renderScreen(page(true));
        try {
            await reportCollectionLayout(screen, 'reviews:list');
            await vi.waitFor(() => expect(screen.findHostByTestId('reviews:row:needs')).not.toBeNull());
            expect(screen.findHostByTestId('reviews:row:running')).not.toBeNull();
            // Without the column the page is the list: nothing opens on its own.
            expect(screen.findByTestId('review-detail:header')).toBeNull();
            expect(routerPush).not.toHaveBeenCalled();
            const prefix = 'reviews:row';
            await vi.waitFor(() => expect(screen.findHostByTestId(`${prefix}:finished`)).not.toBeNull());
            expect(screen.findHostByTestId(`${prefix}:elsewhere`)).not.toBeNull();
            await vi.waitFor(() => expect(screen.getTextContent()).toContain('Website'));
            expect(screen.getTextContent()).toContain('Happier');
            expect(screen.findAllHostsByTestId('reviews:scope-line')).toHaveLength(1);
            const reads = () => homes.requests.slice(before);
            expect(reads().filter(request => request.path === '/v1/reviews/list').map(request => request.input)).toEqual([
                { limit: ARTIFACT_LIST_PAGE_MAX_ITEMS_V1 },
            ]);
            const paths = () => reads().map(request => new URL(request.path, serverUrl).pathname);
            expect(paths().filter(path => path.startsWith('/v1/projects/sources/')).sort()).toEqual([
                '/v1/projects/sources/source-a', '/v1/projects/sources/source-b',
            ]);
            expect(paths().filter(path => path === '/v1/projects/sources')).toEqual([]);
            expect(reads().filter(request => request.path === '/v1/artifacts/read').map(request => request.input)).toEqual([
                { artifactIds: items.map(item => item.reviewId).sort(), projection: 'headers' },
            ]);
            await screen.pressByTestIdAsync('reviews:search-toggle');
            await act(async () => { screen.changeTextByTestId('reviews:search', 'Exact needs'); });
            await vi.waitFor(() => expect(screen.findHostByTestId(`${prefix}:finished`)).toBeNull());
            expect(screen.findHostByTestId(`${prefix}:needs`)).not.toBeNull();
            await act(async () => { screen.changeTextByTestId('reviews:search', ''); });
            await vi.waitFor(() => expect(screen.findHostByTestId(`${prefix}:finished`)).not.toBeNull());
            expect(reads().filter(request => request.path === '/v1/reviews/list')).toHaveLength(1);
            expect(reads().filter(request => /comments|machine|rpc/.test(request.path))).toEqual([]);
            for (const item of items) expect(storage.getState().artifacts[item.reviewId]?.body).toBeUndefined();
            await screen.update(page(false));
            const settledReads = reads().length;
            await act(async () => publishHomeAccountChange(serverId, ['needs'], {
                changeKinds: ['artifact'], artifactKinds: [deriveArtifactStoredKindV1({ kind: REVIEW_ARTIFACT_KIND_V1 })],
            }));
            expect(reads()).toHaveLength(settledReads);
        } finally { await screen.unmount(); await connection.dispose(); }
    });
    it.each([{ width: 390, round: 1 }, { width: 390, round: 3 }, { width: 1440, round: 3 }])(
        'names and searches loaded Reviews from their exact Artifact headers and shows later rounds ($width, round $round)', async ({ width, round }) => {
        vi.mocked(Dimensions.get).mockReturnValue({ width, height: 900, scale: 1, fontScale: 1 });
        const serverUrl = 'https://review-titles.example';
        const serverId = await homes.addHome({ serverUrl, name: 'Review titles', accountId: 'alice', currentAccount: true });
        const reviewId = 'review-header-title';
        homes.artifacts(serverId).replaceStoredRow({ id: reviewId, ownerAccountId: 'alice', access: 'owner',
            publicAudience: 'none', encryptionMode: 'plain', headerVersion: 1, bodyVersion: 1, seq: 1,
            createdAt: 1, updatedAt: 1, dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
            header: encodePlainArtifactStoredContent({ kind: REVIEW_ARTIFACT_KIND_V1, v: 1, reviewId, title: 'Relay handshake' }),
            body: encodePlainArtifactStoredContent({ body: JSON.stringify({ v: 1, rounds: [] }) }) });
        homes.answer(serverId, 'POST /v1/reviews/list', { body: { items: [{ reviewId, projectSourceId: null, workflowId: null,
            subjectKind: 'repository', sourceKind: 'direct', state: 'completed', currentRoundOrdinal: round,
            startedAt: 1, finishedAt: 2, createdAt: 1, updatedAt: 2, counts: { total: 1, needsDecision: 0 },
            needsYou: { reviewId, roundOrdinal: round, reason: 'review_needs_you', needsYou: false,
                requestedVerdict: false, pendingDecisions: false, canSubmitVerdict: false } }], cursor: null } });
        const connection = await restoreServerAccountForTest({ serverUrl, accountId: 'alice', request: homes.request });
        storage.getState().deleteArtifact(reviewId);
        const before = homes.requests.length;
        const screen = await renderScreen(<PluginSurfaceFocusEligibilityProvider active presentationActive>
            <WorkspaceRouteBody />
        </PluginSurfaceFocusEligibilityProvider>);
        try {
            await reportCollectionLayout(screen, 'reviews:list');
            await vi.waitFor(() => expect(screen.findHostByTestId(`reviews:row:${reviewId}`)).not.toBeNull());
            await vi.waitFor(() => expect(screen.getTextContent()).toContain('Relay handshake'));
            expect(screen.findHostByTestId(`reviews:row:${reviewId}`)?.props.accessibilityLabel).toContain('Relay handshake');
            const roundLabel = t('reviewWalkthrough.detail.round', { round });
            if (round > 1) {
                expect(screen.getTextContent()).toContain(roundLabel);
                expect(screen.findHostByTestId(`reviews:row:${reviewId}`)?.props.accessibilityLabel).toContain(roundLabel);
            } else {
                expect(screen.getTextContent()).not.toContain(roundLabel);
                expect(screen.findHostByTestId(`reviews:row:${reviewId}`)?.props.accessibilityLabel).not.toContain(roundLabel);
            }
            expect(storage.getState().artifacts[reviewId]?.body).toBeUndefined();
            const titleReads = () => homes.requests.slice(before).filter(request => request.path === '/v1/artifacts/read');
            expect(titleReads().map(request => request.input)).toEqual([{ artifactIds: [reviewId], projection: 'headers' }]);
            await screen.pressByTestIdAsync('reviews:search-toggle');
            await act(async () => { screen.changeTextByTestId('reviews:search', 'handshake'); });
            expect(screen.findHostByTestId(`reviews:row:${reviewId}`)).not.toBeNull();
            const artifact = storage.getState().artifacts[reviewId];
            if (!artifact?.isDecrypted) throw new Error('The list must open the canonical header');
            await act(async () => storage.getState().applyArtifacts([{ ...artifact, title: 'Durable review', headerVersion: 2 }]));
            await waitForHomeGovernance(() => expect(screen.findHostByTestId(`reviews:row:${reviewId}`)).toBeNull());
            await act(async () => { screen.changeTextByTestId('reviews:search', 'durable'); });
            await waitForHomeGovernance(() => expect(screen.getTextContent()).toContain('Durable review'));
            expect(titleReads()).toHaveLength(1);
        } finally { await screen.unmount(); await connection.dispose(); }
    });
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
                startedAt: 1, finishedAt: 2, createdAt: 1, updatedAt: 2, counts: { total: 3, needsDecision: 1 },
                needsYou: { reviewId: 'review-live', roundOrdinal: 1, reason: 'review_needs_you', needsYou: false,
                    requestedVerdict: false, pendingDecisions: false, canSubmitVerdict: false } }], cursor: 'next-page' } };
        } });
        const page = (active: boolean) => <PluginSurfaceFocusEligibilityProvider active={active} presentationActive={active}>
            <WorkspaceRouteBody />
        </PluginSurfaceFocusEligibilityProvider>;
        const restorePopoverGlobals = withPopoverWebGlobals();
        const screen = await renderScreen(page(true));
        try {
            await waitForHomeGovernance(() => expect(screen.findByTestId('reviews:list')).not.toBeNull());
            await waitForHomeGovernance(() => expect(reads).toBe(1));
            const key = reviewListKey({ serverId, accountId: 'alice' }, { limit: ARTIFACT_LIST_PAGE_MAX_ITEMS_V1 });
            await waitForHomeGovernance(() => expect(getReviewListSnapshot(key).items?.[0]?.reviewId).toBe('review-live'));
            await reportCollectionLayout(screen, 'reviews:list');
            await waitForHomeGovernance(() => expect(screen.findHostByTestId('reviews:row:review-live')).not.toBeNull());
            // Its sealed title hasn't opened yet: the title's place holds a skeleton bar, never the word "Review" (U8 R8 L3).
            expect(screen.findByTestId('reviews:row:review-live:title-pending')).not.toBeNull();
            // One fact: what needs the person, never the total beside it (U8 A2).
            const pendingLabel = t('reviewWalkthrough.detail.glanceToDecide', { count: 1 });
            expect(screen.getTextContent()).toContain(pendingLabel);
            expect(screen.getTextContent()).not.toContain(t('reviewWalkthrough.detail.findingsCount', { count: 3 }));
            const byline = `${t('reviewWalkthrough.collection.subjectRepository')} · ${t('reviewWalkthrough.collection.stateCompleted')}`;
            expect(screen.findHostByTestId('reviews:row:review-live')?.props.accessibilityLabel)
                .toBe(`${t('detailsSurface.review.title')} · ${pendingLabel} · ${byline} · ${formatShortRelativeTimeAt(1, Date.now())}`);
            await screen.pressByTestIdAsync('reviews-space-filter-open');
            expect(screen.getTextContent()).toContain(t('sessionsList.conditionCountPartial', { count: 1 }));
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
            restorePopoverGlobals();
            storage.setState({ profileScope: previousScope });
            publishAppliedActiveServerSnapshot(previousApplied, previousAvailable);
        }
    });

    it.each([true, false])('settles saved-space row menu membership (allowed=%s) visibly without a competing list refresh', async allowed => {
        const serverId = await homes.addHome({ serverUrl: 'https://reviews-membership.example', name: 'Reviews', accountId: 'alice' });
        await setActiveServerId(serverId, { scope: 'device' });
        const previous = storage.getState();
        const previousApplied = getAppliedActiveServerSnapshot();
        const previousAvailable = isAppliedActiveServerRuntimeAvailable();
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot(), true);
        const base = createDefaultCollectionSpaceV1('review');
        const scope = { serverId, accountId: 'alice' };
        storage.setState({ profileScope: scope, settingsScope: scope, settingsVersion: 1,
            settings: settingsParse({ collectionSpacesEnabled: true, [COLLECTION_SPACE_ENABLEMENT_SETTING_KEYS_V1.review]: true,
                collectionSpacesV1: { v: 1, spaces: [{ ...base, id: 'release', name: 'Release', membership: { mode: 'manual_only' } }] } }) });
        let reads = 0;
        homes.answer(serverId, 'POST /v1/reviews/list', { select: () => {
            reads++;
            return { body: { items: [{ reviewId: 'review-member', projectSourceId: null, workflowId: null,
                subjectKind: 'repository', sourceKind: 'direct', state: 'completed', currentRoundOrdinal: 1,
                startedAt: 1, finishedAt: 2, createdAt: 1, updatedAt: 2, counts: { total: 0, needsDecision: 0 },
                needsYou: { reviewId: 'review-member', roundOrdinal: 1, reason: 'review_needs_you', needsYou: false,
                    requestedVerdict: false, pendingDecisions: false, canSubmitVerdict: false } }], cursor: null } };
        } });
        const mutations: unknown[] = [];
        homes.answer(serverId, 'POST /v2/session-organization/resource-space-memberships', { select: input => {
            mutations.push(input);
            return allowed ? { body: { changed: true } } : { status: 403, body: { error: 'permission_denied' } };
        } });
        const restorePopoverGlobals = withPopoverWebGlobals();
        const screen = await renderScreen(<PluginSurfaceFocusEligibilityProvider active presentationActive><WorkspaceRouteBody /></PluginSurfaceFocusEligibilityProvider>);
        try {
            // The row's own overflow (shared row actions: shown on hover, focus and touch) carries its spaces.
            const { ContextMenu } = await import('@happier-dev/plugin-ui');
            const row = () => screen.findAll(node => node.props.testID === 'reviews:row:review-member'
                && Array.isArray(node.props.secondaryActions))[0];
            await waitForHomeGovernance(() => expect(row()).toBeDefined());
            expect(row()!.props.secondaryActions).toEqual([expect.objectContaining({ id: 'add:release',
                label: t('reviewWalkthrough.collection.addToSpace', { space: 'Release' }) })]);
            await act(async () => { row()!.findByType(ContextMenu).props.onSelect('add:release'); });
            await waitForHomeGovernance(() => expect(mutations).toEqual([{ resourceKind: 'artifact', resourceId: 'review-member', operation: 'add', spaceId: 'release' }]));
            if (!allowed) await waitForHomeGovernance(() => expect(membershipAlert).toHaveBeenCalled());
            await new Promise<void>(resolve => setImmediate(resolve));
            expect(reads).toBe(1);
            if (allowed) expect(membershipAlert).not.toHaveBeenCalled();
        } finally {
            await screen.unmount();
            restorePopoverGlobals();
            storage.setState({ profileScope: previous.profileScope, settingsScope: previous.settingsScope,
                settingsVersion: previous.settingsVersion, settings: previous.settings });
            publishAppliedActiveServerSnapshot(previousApplied, previousAvailable);
        }
    });

    it('retains a phone menu association across saved views and remount without Session tag writes', async () => {
        const serverUrl = 'https://reviews-retained-spaces.example';
        const serverId = await homes.addHome({ serverUrl, name: 'Reviews', accountId: 'alice' });
        await setActiveServerId(serverId, { scope: 'device' });
        const previous = storage.getState();
        const previousApplied = getAppliedActiveServerSnapshot();
        const previousAvailable = isAppliedActiveServerRuntimeAvailable();
        const connection = await restoreServerAccountForTest({ serverUrl, accountId: 'alice', request: homes.request });
        await sync.awaitBootstrapForegroundAcquisition();
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot(), true);
        const base = createDefaultCollectionSpaceV1('review');
        const scope = { serverId, accountId: 'alice' };
        storage.setState({ profileScope: scope, settingsScope: scope, settingsVersion: 1,
            settings: settingsParse({ collectionSpacesEnabled: true, [COLLECTION_SPACE_ENABLEMENT_SETTING_KEYS_V1.review]: true,
                collectionSpacesV1: { v: 1, spaces: [
                    { ...base, id: 'release', name: 'Release', membership: { mode: 'manual_only' } },
                    { ...base, id: 'other-view', name: 'Other view', filter: { state: 'running' } },
                ] } }) });
        const definitions = storage.getState().settings.collectionSpacesV1;
        const items: ReviewListResponseV1['items'] = ['shared-review', 'neighbor'].map(reviewId => ({
            reviewId, projectSourceId: null, workflowId: null, subjectKind: 'repository', sourceKind: 'direct',
            state: reviewId === 'neighbor' ? 'running' : 'completed', currentRoundOrdinal: 1,
            startedAt: 1, finishedAt: reviewId === 'neighbor' ? null : 2, createdAt: 1, updatedAt: 2,
            counts: { total: 0, needsDecision: 0 }, needsYou: { reviewId, roundOrdinal: 1, reason: 'review_needs_you',
                needsYou: false, requestedVerdict: false, pendingDecisions: false, canSubmitVerdict: false },
        }));
        // HTTP is the boundary. The retained response models the server's personal association;
        // mounted selection, Action admission, serialization and the Review store remain real.
        let member = false;
        const changes: boolean[] = [];
        homes.answer(serverId, 'POST /v2/session-organization/resource-space-memberships', { select: input => {
            const request = ResourceSpaceMembershipMutationV1Schema.parse(input);
            expect(request).toEqual({ resourceKind: 'artifact', resourceId: 'shared-review', operation: 'add', spaceId: 'release' });
            const changed = !member;
            member = true;
            changes.push(changed);
            return { body: { changed } };
        } });
        const queries: ReturnType<typeof ReviewListRequestV1Schema.parse>[] = [];
        homes.answer(serverId, 'POST /v1/reviews/list', { select: input => {
            const request = ReviewListRequestV1Schema.parse(input);
            queries.push(request);
            return { body: { items: request.spaceId === 'release' ? member ? [items[0]] : []
                : request.state === 'running' ? [items[1]] : items, cursor: null } };
        } });
        const restorePopoverGlobals = withPopoverWebGlobals();
        const page = () => <PluginSurfaceFocusEligibilityProvider active presentationActive><WorkspaceRouteBody /></PluginSurfaceFocusEligibilityProvider>;
        let screen = await renderScreen(page());
        try {
            const { ContextMenu } = await import('@happier-dev/plugin-ui');
            const row = () => screen.findAll(node => node.props.testID === 'reviews:row:shared-review'
                && Array.isArray(node.props.secondaryActions))[0];
            await waitForHomeGovernance(() => expect(row()).toBeDefined());
            // Repeating Add from All is idempotent at the HTTP owner, without changing another view.
            for (let index = 0; index < 2; index++) {
                await act(async () => { row()!.findByType(ContextMenu).props.onSelect('add:release'); });
                await waitForHomeGovernance(() => expect(changes).toHaveLength(index + 1));
            }
            expect(changes).toEqual([true, false]);
            await screen.pressByTestIdAsync('reviews-space-strip:release');
            await waitForHomeGovernance(() => expect(queries.at(-1)).toMatchObject({ spaceId: 'release', spaceMembershipMode: 'manual_only' }));
            await waitForHomeGovernance(() => expect(row()).toBeDefined());
            expect(screen.findHostByTestId('reviews:row:neighbor')).toBeNull();
            const releaseQuery = queries.at(-1)!;
            const beforeReload = queries.length;
            await screen.unmount();
            // A reload loses the volatile list snapshot; the remount must read the persisted association.
            retireReviewList(reviewListKey(scope, releaseQuery));
            screen = await renderScreen(page());
            await waitForHomeGovernance(() => expect(queries.length).toBeGreaterThan(beforeReload));
            expect(queries.at(-1)).toEqual(releaseQuery);
            await waitForHomeGovernance(() => expect(row()).toBeDefined());
            expect(screen.findHostByTestId('reviews:row:neighbor')).toBeNull();
            await screen.pressByTestIdAsync('reviews-space-strip:other-view');
            await waitForHomeGovernance(() => expect(screen.findHostByTestId('reviews:row:neighbor')).not.toBeNull());
            expect(screen.findHostByTestId('reviews:row:shared-review')).toBeNull();
            await screen.pressByTestIdAsync('reviews-space-strip:release');
            await waitForHomeGovernance(() => expect(row()).toBeDefined());
            expect(changes).toEqual([true, false]);
            const writes = homes.requests.filter(request => request.method === 'POST'
                && request.path.startsWith('/v2/session-organization/'));
            expect(writes.map(request => request.path)).toEqual([
                '/v2/session-organization/resource-space-memberships', '/v2/session-organization/resource-space-memberships',
            ]);
            expect(storage.getState().settings.collectionSpacesV1).toEqual(definitions);
            expect(membershipAlert).not.toHaveBeenCalled();
        } finally {
            await screen.unmount();
            await connection.dispose();
            restorePopoverGlobals();
            storage.setState({ profileScope: previous.profileScope, settingsScope: previous.settingsScope,
                settingsVersion: previous.settingsVersion, settings: previous.settings });
            publishAppliedActiveServerSnapshot(previousApplied, previousAvailable);
        }
    });

    it('keeps search behind its icon and narrows only the loaded rows, saying so', async () => {
        const serverId = await homes.addHome({ serverUrl: 'https://reviews-search.example', name: 'Reviews', accountId: 'alice' });
        await setActiveServerId(serverId, { scope: 'device' });
        const previousScope = storage.getState().profileScope;
        const previousApplied = getAppliedActiveServerSnapshot();
        const previousAvailable = isAppliedActiveServerRuntimeAvailable();
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot(), true);
        storage.setState({ profileScope: { serverId, accountId: 'alice' } });
        const row = (reviewId: string, subjectKind: 'repository' | 'pull_request') => ({ reviewId, projectSourceId: null, workflowId: null,
            subjectKind, sourceKind: 'direct', state: 'completed', currentRoundOrdinal: 1,
            startedAt: 1, finishedAt: 2, createdAt: 1, updatedAt: 2, counts: { total: 1, needsDecision: 0 },
            needsYou: { reviewId, roundOrdinal: 1, reason: 'review_needs_you', needsYou: false,
                requestedVerdict: false, pendingDecisions: false, canSubmitVerdict: false } });
        homes.answer(serverId, 'POST /v1/reviews/list', { select: () => ({ body: {
            items: [row('review-repo', 'repository'), row('review-pr', 'pull_request')], cursor: null } }) });
        const screen = await renderScreen(<PluginSurfaceFocusEligibilityProvider active presentationActive>
            <WorkspaceRouteBody />
        </PluginSurfaceFocusEligibilityProvider>);
        try {
            await waitForHomeGovernance(() => expect(screen.findHostByTestId('reviews:row:review-pr')).not.toBeNull());
            expect(screen.findByTestId('reviews:search')).toBeNull();
            await screen.pressByTestIdAsync('reviews:search-toggle');
            await act(async () => { screen.changeTextByTestId('reviews:search', t('reviewWalkthrough.collection.subjectPullRequest')); });
            await waitForHomeGovernance(() => expect(screen.findHostByTestId('reviews:row:review-repo')).toBeNull());
            await waitForHomeGovernance(() => expect(screen.findHostByTestId('reviews:row:review-pr')).not.toBeNull());
            expect(screen.findByTestId('reviews:search-scope')).not.toBeNull();
        } finally {
            await screen.unmount();
            storage.setState({ profileScope: previousScope });
            publishAppliedActiveServerSnapshot(previousApplied, previousAvailable);
        }
    });

    it('keeps the empty column to its one-line hint: the page beside it owns Start a review', async () => {
        vi.spyOn(Dimensions, 'get').mockReturnValue({ width: 1440, height: 900, scale: 1, fontScale: 1 });
        const serverId = await homes.addHome({ serverUrl: 'https://reviews-column.example', name: 'Reviews', accountId: 'alice' });
        await setActiveServerId(serverId, { scope: 'device' });
        const previousScope = storage.getState().profileScope;
        storage.setState({ profileScope: { serverId, accountId: 'alice' } });
        homes.answer(serverId, 'POST /v1/reviews/list', { select: () => ({ body: { items: [], cursor: null } }) });
        const connection = await restoreServerAccountForTest({ serverUrl: 'https://reviews-column.example', accountId: 'alice', request: homes.request });
        const screen = await renderScreen(<PluginSurfaceFocusEligibilityProvider active presentationActive>
            <ReviewsListHost surface="column" />
        </PluginSurfaceFocusEligibilityProvider>);
        try {
            await waitForHomeGovernance(() => expect(screen.findByTestId('reviews:empty')).not.toBeNull());
            expect(screen.getTextContent()).toContain(t('reviewWalkthrough.collection.columnEmpty'));
            expect(screen.findByTestId('reviews:empty:start')).toBeNull();
        } finally {
            await screen.unmount();
            await connection.dispose();
            storage.setState({ profileScope: previousScope });
        }
    });

    it.each([false, true])('Start a review with existing Reviews=%s opens the Review start sheet, never universal search', async hasReviews => {
        vi.spyOn(Dimensions, 'get').mockReturnValue({ width: 1024, height: 900, scale: 1, fontScale: 1 });
        const serverId = await homes.addHome({ serverUrl: 'https://reviews-empty.example', name: 'Reviews', accountId: 'alice' });
        await setActiveServerId(serverId, { scope: 'device' });
        const previousScope = storage.getState().profileScope;
        const previousApplied = getAppliedActiveServerSnapshot();
        const previousAvailable = isAppliedActiveServerRuntimeAvailable();
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot(), true);
        storage.setState({ profileScope: { serverId, accountId: 'alice' } });
        const items: ReviewListResponseV1['items'] = hasReviews ? [{ reviewId: 'existing-review', projectSourceId: null,
            workflowId: null, subjectKind: 'repository', sourceKind: 'direct', state: 'running', currentRoundOrdinal: 1,
            startedAt: 1, finishedAt: null, createdAt: 1, updatedAt: 1, counts: { total: 0, needsDecision: 0 },
            needsYou: { reviewId: 'existing-review', roundOrdinal: 1, reason: 'review_needs_you', needsYou: false,
                requestedVerdict: false, pendingDecisions: false, canSubmitVerdict: false } }] : [];
        homes.answer(serverId, 'POST /v1/reviews/list', { select: () => ({ body: { items, cursor: null } }) });
        const connection = await restoreServerAccountForTest({ serverUrl: 'https://reviews-empty.example', accountId: 'alice', request: homes.request });
        await sync.awaitBootstrapForegroundAcquisition();
        const opened: (string | undefined)[] = [];
        const runtime: UniversalSearchRuntime = { open: query => { opened.push(query); }, buildCommands: () => [] };
        const screen = await renderScreen(<UniversalSearchRuntimeProvider value={runtime}>
            <PluginSurfaceFocusEligibilityProvider active presentationActive><WorkspaceRouteBody /></PluginSurfaceFocusEligibilityProvider>
        </UniversalSearchRuntimeProvider>);
        try {
            const startId = hasReviews ? 'reviews:start' : 'reviews:empty:start';
            await waitForHomeGovernance(() => expect(screen.findByTestId(startId)).not.toBeNull());
            expect(screen.findByTestId(hasReviews ? 'reviews:empty:start' : 'reviews:start')).toBeNull();
            await screen.pressByTestIdAsync(startId);
            await waitForHomeGovernance(() => expect(modalShow).toHaveBeenCalledTimes(1));
            const sheet = modalShow.mock.calls[0]![0];
            expect(sheet.component.name).toBe('ReviewExecutionRunLaunchSelectionModal');
            expect(sheet.props).toMatchObject({ sessionId: null, serverId, draft: expect.objectContaining({ target: { kind: 'detached' } }) });
            expect(opened).toEqual([]);
        } finally {
            await screen.unmount();
            await connection.dispose();
            storage.setState({ profileScope: previousScope });
            publishAppliedActiveServerSnapshot(previousApplied, previousAvailable);
        }
    });
});
