import * as React from 'react';
import { Dimensions } from 'react-native';
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
import { getReviewListSnapshot, reviewListKey } from '@/sync/store/domains/reviews/list';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { AppShellColumnContext } from '@/components/navigation/shell/appRail/appShellColumnContext';
import { WorkspaceRouteBody } from '@/app/(app)/reviews';
import { ReviewsListHost, reviewRowFact } from './ReviewsListHost';
import { findHomeHubBuiltinSection } from '@/components/hub/homeHubSections';
import { HOME_HUB_BUILTIN_DEFINITIONS, getHomeHubDefaultLayoutV1, resolveHomeHubLayout } from '@/components/hub/layout/homeHubLayout';
import { artifactViewRoute } from '@/components/artifacts/artifactBrowserModel';
import { formatShortRelativeTimeAt } from '@/utils/time/formatShortRelativeTime';
import { t } from '@/text';
import { createDefaultCollectionSpaceV1 } from '@happier-dev/protocol/collections/spaces/collectionSpacesV1';
import { COLLECTION_SPACE_ENABLEMENT_SETTING_KEYS_V1 } from '@happier-dev/protocol/collections/spaces/collectionSpaceEnablementV1';
import { settingsParse } from '@/sync/domains/settings/settings';
import { UniversalSearchRuntimeProvider, type UniversalSearchRuntime } from '@/components/appShell/search/UniversalSearchRuntimeContext';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';

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
});

describe('/reviews live host', () => {
    it('opens actionable Reviews from the actual Home section without a second toolbar or automatic page drain', async () => {
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
        try {
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
            await connection.dispose();
            storage.setState({ profileScope: previousScope });
            publishAppliedActiveServerSnapshot(previousApplied, previousAvailable);
        }
    });
    it.each([['desktop', 1024, true], ['phone', 390, false], ['collapsed desktop', 1024, false]] as const)('projects the %s collection from per-person attention and shares list, titles and search demand', async (surface, width, columnVisible) => {
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
            if (columnVisible) {
                expect(screen.findHostByTestId('reviews:row:finished')).toBeNull();
                expect(screen.findHostByTestId('reviews:row:elsewhere')).toBeNull();
                expect(screen.getTextContent()).toContain('Needs your decision');
                await reportCollectionLayout(screen, 'reviews:column');
            }
            const prefix = columnVisible ? 'reviews:column:row' : 'reviews:row';
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
    it('names and searches loaded Reviews from their exact Artifact headers and follows header updates', async () => {
        const serverUrl = 'https://review-titles.example';
        const serverId = await homes.addHome({ serverUrl, name: 'Review titles', accountId: 'alice', currentAccount: true });
        const reviewId = 'review-header-title';
        homes.artifacts(serverId).replaceStoredRow({ id: reviewId, ownerAccountId: 'alice', access: 'owner',
            publicAudience: 'none', encryptionMode: 'plain', headerVersion: 1, bodyVersion: 1, seq: 1,
            createdAt: 1, updatedAt: 1, dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
            header: encodePlainArtifactStoredContent({ kind: REVIEW_ARTIFACT_KIND_V1, v: 1, reviewId, title: 'Relay handshake' }),
            body: encodePlainArtifactStoredContent({ body: JSON.stringify({ v: 1, rounds: [] }) }) });
        homes.answer(serverId, 'POST /v1/reviews/list', { body: { items: [{ reviewId, projectSourceId: null, workflowId: null,
            subjectKind: 'repository', sourceKind: 'direct', state: 'completed', currentRoundOrdinal: 1,
            startedAt: 1, finishedAt: 2, createdAt: 1, updatedAt: 2, counts: { total: 1, needsDecision: 0 },
            needsYou: { reviewId, roundOrdinal: 1, reason: 'review_needs_you', needsYou: false,
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
