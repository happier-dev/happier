import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '@/sync/ops/actions/defaultActionExecutor';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { reportCollectionLayout } from '@/dev/testkit/harness/collectionLayoutHarness';
import { withPopoverWebGlobals } from '@/dev/testkit/harness/popoverHarness';
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
import { createDefaultCollectionSpaceV1 } from '@happier-dev/protocol/collections/spaces/collectionSpacesV1';
import { COLLECTION_SPACE_ENABLEMENT_SETTING_KEYS_V1 } from '@happier-dev/protocol/collections/spaces/collectionSpaceEnablementV1';
import { settingsParse } from '@/sync/domains/settings/settings';
import { UniversalSearchRuntimeProvider, type UniversalSearchRuntime } from '@/components/appShell/search/UniversalSearchRuntimeContext';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';

const routerPush = vi.hoisted(() => vi.fn());
const membershipAlert = vi.hoisted(() => vi.fn());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ spies: { alert: membershipAlert } }).module);
// RN's physical recycler is absent from Test Renderer; keep real Collection rows beneath it.
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(
    (await import('@/dev/testkit/mocks/virtualizedList')).createCapturingFlatListMock().module,
));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
// Menus and editors on this page render inline under Test Renderer (no window).
vi.mock('@/components/ui/popover', async original => (await import('@/dev/testkit/mocks/popover')).createInlinePopoverModuleMock(original));
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({ pathname: '/reviews', router: { push: routerPush } }).module);

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
afterEach(async () => { await homes.reset(); routerPush.mockClear(); membershipAlert.mockClear(); });

describe('/reviews live host', () => {
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
            screen.changeTextByTestId('reviews:search', 'handshake');
            expect(screen.findHostByTestId(`reviews:row:${reviewId}`)).not.toBeNull();
            const artifact = storage.getState().artifacts[reviewId];
            if (!artifact?.isDecrypted) throw new Error('The list must open the canonical header');
            await act(async () => storage.getState().applyArtifacts([{ ...artifact, title: 'Durable review', headerVersion: 2 }]));
            await waitForHomeGovernance(() => expect(screen.findHostByTestId(`reviews:row:${reviewId}`)).toBeNull());
            screen.changeTextByTestId('reviews:search', 'durable');
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
            const totalLabel = t('reviewWalkthrough.detail.findingsCount', { count: 3 });
            const pendingLabel = t('reviewWalkthrough.detail.glanceToDecide', { count: 1 });
            expect(screen.getTextContent()).toContain(totalLabel);
            expect(screen.getTextContent()).toContain(pendingLabel);
            expect(screen.findHostByTestId('reviews:row:review-live')?.props.accessibilityLabel)
                .toBe(`${t('detailsSurface.review.title')} · ${totalLabel} · ${pendingLabel} · ${formatRelativeTimeShort(1, Date.now())}`);
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
            await waitForHomeGovernance(() => expect(screen.findHostByTestId('reviews:row:review-member:menu')).not.toBeNull());
            await screen.pressByTestIdAsync('reviews:row:review-member:menu');
            await screen.pressByTestIdAsync('reviews:row:review-member:add:release');
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
            screen.changeTextByTestId('reviews:search', t('reviewWalkthrough.collection.subjectPullRequest'));
            await waitForHomeGovernance(() => expect(screen.findHostByTestId('reviews:row:review-repo')).toBeNull());
            expect(screen.findHostByTestId('reviews:row:review-pr')).not.toBeNull();
            expect(screen.findByTestId('reviews:search-scope')).not.toBeNull();
        } finally {
            await screen.unmount();
            storage.setState({ profileScope: previousScope });
            publishAppliedActiveServerSnapshot(previousApplied, previousAvailable);
        }
    });

    it('offers Start a review once when there are no Reviews, through the same Start review command', async () => {
        const serverId = await homes.addHome({ serverUrl: 'https://reviews-empty.example', name: 'Reviews', accountId: 'alice' });
        await setActiveServerId(serverId, { scope: 'device' });
        const previousScope = storage.getState().profileScope;
        const previousApplied = getAppliedActiveServerSnapshot();
        const previousAvailable = isAppliedActiveServerRuntimeAvailable();
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot(), true);
        storage.setState({ profileScope: { serverId, accountId: 'alice' } });
        homes.answer(serverId, 'POST /v1/reviews/list', { select: () => ({ body: { items: [], cursor: null } }) });
        const opened: (string | undefined)[] = [];
        const runtime: UniversalSearchRuntime = { open: query => { opened.push(query); }, buildCommands: () => [] };
        const screen = await renderScreen(<UniversalSearchRuntimeProvider value={runtime}>
            <PluginSurfaceFocusEligibilityProvider active presentationActive><WorkspaceRouteBody /></PluginSurfaceFocusEligibilityProvider>
        </UniversalSearchRuntimeProvider>);
        try {
            await waitForHomeGovernance(() => expect(screen.findByTestId('reviews:empty')).not.toBeNull());
            await screen.pressByTestIdAsync('reviews:empty:start');
            expect(opened).toEqual([t('commandPalette.commands.startReviewRunTitle')]);
        } finally {
            await screen.unmount();
            storage.setState({ profileScope: previousScope });
            publishAppliedActiveServerSnapshot(previousApplied, previousAvailable);
        }
    });
});
