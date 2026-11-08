import * as React from 'react';
import { act, type ReactTestInstance } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, onTestFailed, vi } from 'vitest';

import { createDeferred, flushHookEffects, renderScreen, withPopoverWebGlobals } from '@/dev/testkit';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { answerDiscussionThreadForTests, createAccountTokenForTests, createHomeGovernanceHarness, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { tryWriteServerEnabledBitInPlace } from '@happier-dev/protocol/features/serverEnabledBit';
import { installSessionPaneRuntimeTestHarness, prepareSessionPaneRuntimeForTests } from '@/components/sessions/panes/sessionPaneRuntimeTestHarness';
import { installSessionRouteCommonModuleMocks } from '@/__tests__/routes/(app)/session/[id]/sessionRouteTestHelpers';
import { AppShellColumnContext } from '@/components/navigation/shell/appRail/appShellColumnContext';
import { SurfaceStateSizeProvider } from '@/components/ui/surfaces/surfaceStateSize';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const routerReplaceSpy = vi.fn();
const viewport = vi.hoisted(() => ({ width: 800, height: 600, scale: 1, fontScale: 1 }));
let routeFocused = true;
let routeParams: { discussionId: string; serverId?: string; messageId?: string } = {
    discussionId: 'discussion-1',
};
let navigationBoundary: ReturnType<typeof import('@/dev/testkit/mocks/reactNavigation').createReactNavigationNativeMock>;

installSessionRouteCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({ Dimensions: { get: () => viewport } });
    },
    unistyles: async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock({
        rt: { screen: viewport, orientation: 'landscape' },
    }),
    modal: async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ confirmResult: true }).module,
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        const boundary = createExpoRouterMock({ router: { replace: routerReplaceSpy } });
        return { ...boundary.module, useLocalSearchParams: () => routeParams };
    },
    nativeNavigation: async () => {
        const { createReactNavigationNativeMock } = await import('@/dev/testkit/mocks/reactNavigation');
        navigationBoundary = createReactNavigationNativeMock();
        return { ...navigationBoundary, useIsFocused: () => routeFocused };
    },
});

// The host renderer has no measured viewport; keep the real transcript shell
// and row projection while replacing only the native recycler/layout boundary.
vi.mock('@legendapp/list/react-native', async (importOriginal) => {
    const { createCapturingLegendListMock } = await import('@/dev/testkit/mocks/legendList');
    return createCapturingLegendListMock({ original: await importOriginal<Record<string, unknown>>(), renderItems: true }).module;
});

await prepareSessionPaneRuntimeForTests();
const homes = createHomeGovernanceHarness();
const runtime = installSessionPaneRuntimeTestHarness({ sessionId: 'session-1',
    credentials: { token: createAccountTokenForTests('account-a', { currentAccount: true }) },
    features: () => {
        const features = createRootLayoutFeaturesResponse();
        for (const id of ['sharing.session', 'sessions.conversations'] as const) {
            if (!tryWriteServerEnabledBitInPlace(features, id, true)) throw new Error(`Cannot enable ${id}`);
        }
        return features;
    },
    request: async (url, init) => new URL(String(url)).pathname.startsWith('/v1/discussions')
        ? homes.request(url, init) : null,
});

beforeEach(() => {
    Object.assign(viewport, { width: 800, height: 600 });
    routeParams = { discussionId: 'discussion-1', serverId: runtime.serverId };
    routeFocused = true;
    routerReplaceSpy.mockClear();
});
afterEach(async () => { await homes.reset(); });

async function renderDiscussionRoute(kind: 'discussion' | 'new' = 'discussion', columnVisible = false) {
    // The SDK context establishes a standalone screen. Its focus measurement is
    // the native boundary; Home qualification and the view are real.
    const { DiscussionRouteScreen } = await import('@/components/discussions/DiscussionRouteScreen');
    return renderScreen(<runtime.Wrapper>
        <navigationBoundary.NavigationContext.Provider value={navigationBoundary.useNavigation()}>
            <AppShellColumnContext.Provider value={{ present: columnVisible, columnVisible }}>
                <DiscussionRouteScreen kind={kind} />
            </AppShellColumnContext.Provider>
        </navigationBoundary.NavigationContext.Provider>
    </runtime.Wrapper>);
}

/** Message bodies render as Markdown, so their text sits below the content host. */
function hostText(node: ReactTestInstance | string | null): string {
    if (node === null) return '';
    return typeof node === 'string' ? node : node.children.map(hostText).join('');
}

describe('DiscussionRouteScreen', () => {
    it.each([true, false])('loads the full desktop thread with column visibility %s and stable external snapshots', async (columnVisible) => {
        Object.assign(viewport, { width: 1440, height: 940 });
        const serverId = await homes.addHome({ name: 'Discussion Home', serverUrl: 'https://session-pane.test',
            serverIdentityId: runtime.serverIdentityId, accountId: runtime.accountScope!.accountId,
            credentials: runtime.credentials, active: false });
        answerDiscussionThreadForTests(homes, serverId, { accountId: 'account-a', loseCreate: false, loseFirstRejoin: false });
        const { createDiscussionClient } = await import('@/sync/api/discussions/discussionActions');
        const client = createDiscussionClient({ scope: runtime.accountScope!, availability: 'available' });
        const created = await client.create({ creationLocalId: 'snapshot-create', messageLocalId: 'snapshot-first-message',
            title: 'Loaded conversation', content: { v: 1, parts: [{ t: 'text', text: 'Committed conversation content' }] } });
        expect(created.kind).toBe('succeeded');
        routeParams = { discussionId: 'committed-thread', serverId };
        let phase = 'mounting route';
        onTestFailed(() => console.error('Discussion snapshot phase:', phase,
            'requests:', homes.requests.map(request => request.path)));
        const errors = vi.spyOn(console, 'error');
        const screen = await renderDiscussionRoute('discussion', columnVisible);
        try {
            expect(screen.findByType(SurfaceStateSizeProvider).props.size).toBe('page');
            phase = 'waiting for loaded detail';
            await waitForHomeGovernance(() => expect(screen.findByTestId('session-discussion-details')).not.toBeNull());
            expect(screen.findHostByTestId('discussion-right-sidebar-action-rail')).not.toBeNull();
            phase = 'waiting for committed message';
            await waitForHomeGovernance(() => expect(hostText(screen.findHostByTestId('session-discussion-message-content-committed-root'))).toContain('Committed conversation content'));
            expect(screen.findAllByTestId('session-discussion-details-state')).toHaveLength(0);
            const { readRegisteredDiscussionRepository } = await import('@/sync/ops/discussions/discussionRepositoryRegistry');
            const repository = readRegisteredDiscussionRepository(runtime.accountScope!, { serverId: runtime.accountScope!.serverId });
            expect(repository).not.toBeNull();
            expect(repository!.getSnapshot()).toBe(repository!.getSnapshot());
            expect(repository!.getListSnapshot()).toBe(repository!.getListSnapshot());
            expect(errors.mock.calls.filter(args => args.some(value => /getSnapshot.*cached|maximum update depth/i.test(String(value))))).toEqual([]);
        } finally {
            await screen.unmount();
            errors.mockRestore();
        }
    });

    it('opens the committed Discussion at its captured Home without waiting for remote draft acknowledgement', async () => {
        const serverId = await homes.addHome({ name: 'Discussion Home', serverUrl: 'https://session-pane.test',
            serverIdentityId: runtime.serverIdentityId, accountId: runtime.accountScope!.accountId,
            credentials: runtime.credentials, active: false });
        const thread = answerDiscussionThreadForTests(homes, serverId, { accountId: 'account-a', loseCreate: false, loseFirstRejoin: false });
        const { configureSessionDraftRepository, flushSessionDraftLocally, getSessionDraftSnapshot } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
        const { createSessionDraftCipher } = await import('@/sync/encryption/sessionDraftEncryption');
        const scope = runtime.accountScope!;
        const pendingClear = createDeferred<void>();
        let clearStarted = false;
        configureSessionDraftRepository({ scope, syncEnabled: true,
            cipher: createSessionDraftCipher({ accountMode: 'plain', accountCryptoMaterial: null, getSessionContext: () => null, randomBytes: length => new Uint8Array(length) }),
            transport: {
                read: async () => ({ status: 'absent' }),
                list: async () => ({ items: [] }),
                mutate: async ({ address, expectedRevision, content }) => {
                    // An emptied draft crosses the canonical transport as a tombstone.
                    if (thread.stored() && content === null) {
                        clearStarted = true;
                        await pendingClear.promise;
                    }
                    return { status: 'updated', record: { address, content,
                        revision: expectedRevision === 'absent' ? 0 : expectedRevision + 1, createdAt: 1, updatedAt: 2 } };
                },
            },
        });
        routeParams = { discussionId: '', serverId };
        const screen = await renderDiscussionRoute('new');
        let phase = 'waiting for creation form';
        onTestFailed(() => console.error('Discussion creation phase:', phase,
            'committed:', Boolean(thread.stored()), 'clear started:', clearStarted,
            'requests:', homes.requests.map(request => request.path)));
        try {
            await waitForHomeGovernance(() => expect(screen.findByTestId('session-discussion-title')).not.toBeNull());
            await act(async () => {
                screen.changeTextByTestId('session-discussion-title', 'Create and open');
                screen.changeTextByTestId('new-session-composer-input', 'The first committed message');
            });
            phase = 'waiting for enabled send';
            await waitForHomeGovernance(() => expect(screen.findByTestId('new-session-composer-send')?.props.disabled).toBe(false));
            phase = 'submitting';
            await screen.pressByTestIdAsync('new-session-composer-send');
            phase = 'waiting for remote draft clear';
            await waitForHomeGovernance(() => expect(clearStarted).toBe(true));
            await flushSessionDraftLocally({ scope });
            await flushHookEffects();
            expect(routerReplaceSpy).toHaveBeenCalledWith(`/discussions/committed-thread?serverId=${encodeURIComponent(runtime.serverId)}&sourceSurface=discussions`);
            expect(getSessionDraftSnapshot(scope, { kind: 'newDiscussion' })?.localSupplement.discussionMutationAttempt).toBeUndefined();
        } finally {
            pendingClear.resolve();
            await flushHookEffects();
            await screen.unmount();
            configureSessionDraftRepository({ syncEnabled: false });
        }
    });

    it('opens a Home Discussion without a parent Session route or hydration', async () => {
        const { resolveInboxItemPageRoute } = await import('@/components/inbox/inboxItemFocus');
        const href = resolveInboxItemPageRoute({ kind: 'discussion', serverId: runtime.serverId,
            id: 'discussion-1', messageId: 'committed-root' });
        const route = new URL(href, 'https://ui.invalid');
        routeParams = { discussionId: 'discussion-1', serverId: route.searchParams.get('serverId')!,
            messageId: route.searchParams.get('messageId')! };
        const { DiscussionDetailsView } = await import('@/components/discussions/DiscussionDetailsView');
        const screen = await renderDiscussionRoute();

        expect(screen.findByType(DiscussionDetailsView).props).toMatchObject({
            active: true,
            standaloneSurface: true,
            target: {
                kind: 'discussion',
                address: { serverId: runtime.serverId },
                discussionId: 'discussion-1',
                messageId: 'committed-root',
            },
        });
        expect(screen.findByType(DiscussionDetailsView).props.target.address).not.toHaveProperty('sessionId');
        expect(screen.findAllByTestId('session-discussion-route-loading')).toHaveLength(0);
    });

    it('keeps an edited decision sheet mounted across desktop and phone layouts', async () => {
        const serverId = await homes.addHome({ name: 'Discussion Home', serverUrl: 'https://session-pane.test',
            serverIdentityId: runtime.serverIdentityId, accountId: runtime.accountScope!.accountId,
            credentials: runtime.credentials, active: false });
        answerDiscussionThreadForTests(homes, serverId, { accountId: 'account-a', loseCreate: false, loseFirstRejoin: false });
        const { createDiscussionClient } = await import('@/sync/api/discussions/discussionActions');
        const client = createDiscussionClient({ scope: runtime.accountScope!, availability: 'available' });
        const created = await client.create({ creationLocalId: 'decision-resize-create', messageLocalId: 'decision-resize-message',
            title: 'Decision continuity', content: { v: 1, parts: [{ t: 'text', text: 'Keep the resize draft' }] } });
        expect(created.kind).toBe('succeeded');
        routeParams = { discussionId: 'committed-thread', serverId };
        const { getStorage } = await import('@/sync/domains/state/storage');
        getStorage().getState().applySettingsLocal({ mobileWorkspaceExperienceV1: 'cockpit' });
        const { DiscussionRouteScreen } = await import('@/components/discussions/DiscussionRouteScreen');
        const frame = (columnVisible: boolean) => <runtime.Wrapper>
            <navigationBoundary.NavigationContext.Provider value={navigationBoundary.useNavigation()}>
                <AppShellColumnContext.Provider value={{ present: columnVisible, columnVisible }}>
                    <DiscussionRouteScreen kind="discussion" />
                </AppShellColumnContext.Provider>
            </navigationBoundary.NavigationContext.Provider>
        </runtime.Wrapper>;
        const restorePopoverWebGlobals = withPopoverWebGlobals();
        const screen = await renderScreen(frame(true));
        try {
            const { DiscussionMessageMenu } = await import('@/components/discussions/DiscussionMessageMenu');
            await waitForHomeGovernance(() => expect(screen.findByType(DiscussionMessageMenu).props.saveDecision).toBe(true));
            await act(async () => screen.findByType(DiscussionMessageMenu).props.onSelect('saveDecision'));
            await act(async () => screen.changeTextByTestId('save-memory-decision.text', 'Draft survives rotation'));

            Object.assign(viewport, { width: 390, height: 844 });
            await screen.update(frame(false));
            expect(screen.findByTestId('save-memory-decision.text')?.props.value).toBe('Draft survives rotation');

            Object.assign(viewport, { width: 1440, height: 940 });
            await screen.update(frame(true));
            expect(screen.findByTestId('save-memory-decision.text')?.props.value).toBe('Draft survives rotation');
        } finally {
            await act(async () => getStorage().getState().applySettingsLocal({ mobileWorkspaceExperienceV1: 'classic' }));
            await screen.unmount();
            restorePopoverWebGlobals();
        }
    });

    it('keeps the Discussion mounted without declaring it visible when the native route loses focus', async () => {
        routeFocused = false;
        const { DiscussionDetailsView } = await import('@/components/discussions/DiscussionDetailsView');
        const screen = await renderDiscussionRoute();

        expect(screen.findByType(DiscussionDetailsView).props).toMatchObject({
            active: false,
            standaloneSurface: true,
            target: { address: { serverId: runtime.serverId } },
        });
    });
});
