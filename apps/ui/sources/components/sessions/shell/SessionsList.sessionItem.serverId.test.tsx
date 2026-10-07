import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createSessionFixture, createSessionListRenderableSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import {
    SESSION_ACTION_ARCHIVE_ID,
    SESSION_ACTION_RENAME_ID,
    SESSION_ACTION_STOP_ID,
} from '@/components/sessions/actions/sessionActionIds';
import {
    createModelBackedSessionItemTestComponent,
    type ModelBackedSessionItemTestProps,
} from './sessionItemRowViewModelTestFixture';
import { installSessionShellCommonModuleMocks } from './sessionShellTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

type SessionItemProps = ModelBackedSessionItemTestProps;

const navigateSpy = vi.fn();
installDisconnectedServerSocketBoundary();
let splitFixture: Awaited<ReturnType<typeof prepareSplitCanvas>> | null = null;
const themeColors = vi.hoisted(() => ({
    surface: '#fff',
    surfaceSelected: '#eee',
    divider: '#ddd',
    text: '#111',
    textSecondary: '#666',
    textLink: '#07f',
    input: { background: '#f0f0f0' },
    groupped: { background: '#f7f7f7' },
    status: { error: '#f00' },
    button: { primary: { tint: '#fff' } },
}));

installSessionShellCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: { OS: 'web' },
        });
    },
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock({
            theme: themeColors,
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({
            translate: (key: string) => key,
        });
    },
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock().module;
    },
    storage: async (importOriginal) => {
        const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleMock({
            importOriginal,
            overrides: {
                useHasUnreadMessages: () => false,
                useProfile: () => ({
                    id: 'u1',
                    timestamp: 0,
                    firstName: null,
                    lastName: null,
                    username: null,
                    avatar: null,
                    linkedProviders: [],
                    connectedServices: [],
                    connectedServicesV2: [],
                    connectedServiceCredentialRevisionsV1: [],
                    connectedAccountsV4: [],
                    connectedAccountGroupsV4: [],
                }),
                useSession: () => null,
                useSessionListMeaningfulActivityAt: () => null,
            },
        });
    },
});
vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: any) => React.createElement('DropdownMenu', props),
}));
vi.mock('react-native-gesture-handler', () => ({
    Swipeable: 'Swipeable',
    GestureDetector: (props: any) => React.createElement('GestureDetector', props, props.children),
}));
vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
    Octicons: 'Octicons',
}));
// Real `@/constants/Typography` is used: it depends only on the mocked
// `react-native` Platform, and the row corridor evaluates `Typography.rowMeta()`
// while module mocks initialize (browser/frame/styles.ts), so a partial
// `default`-only mock fails mock-factory initialization.
vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
    TextInput: 'TextInput',
}));
vi.mock('@/utils/sessions/sessionUtils', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/utils/sessions/sessionUtils')>();
    return {
        ...actual,
        getSessionName: () => 'Session',
        getSessionSubtitle: () => 'Subtitle',
        getSessionAvatarId: () => 'avatar',
        getSessionStatus: () => ({
            isConnected: true,
            statusText: 'Connected',
            statusColor: '#000',
            statusDotColor: '#0f0',
            isPulsing: false,
        }),
        useSessionStatus: () => ({
            isConnected: true,
            statusText: 'Connected',
            statusColor: '#000',
            statusDotColor: '#0f0',
            isPulsing: false,
        }),
    };
});
vi.mock('@/components/ui/avatar/Avatar', () => ({
    Avatar: (props: Record<string, unknown>) => React.createElement('Avatar', {
        ...props,
        testID: props.testID ?? 'session-item-avatar',
    }),
}));
vi.mock('@/agents/registry/AgentIcon', () => ({
    AgentIcon: (props: Record<string, unknown>) => React.createElement('AgentIcon', props),
}));
vi.mock('@/components/ui/status/StatusDot', () => ({
    StatusDot: 'StatusDot',
}));
vi.mock('@/components/sessions/pendingBadge', () => ({
    formatPendingCountBadge: () => null,
}));
vi.mock('@/hooks/session/useNavigateToSession', () => ({
    useNavigateToSession: () => navigateSpy,
}));
vi.mock('@/utils/platform/responsive', () => ({
    useIsTablet: () => false,
}));
vi.mock('@/hooks/ui/useHappyAction', () => ({
    useHappyAction: (_fn: unknown) => [false, vi.fn()],
}));
vi.mock('@/utils/errors/errors', () => ({
    HappyError: class HappyError extends Error {},
}));
vi.mock('@/sync/ops', async (importOriginal) => {
    const { createSyncOpsModuleMock } = await import('@/dev/testkit/mocks/syncOps');
    return createSyncOpsModuleMock({
        importOriginal,
        overrides: {
            sessionStopWithServerScope: vi.fn(async () => ({ success: true })),
            sessionArchiveWithServerScope: vi.fn(async () => ({ success: true })),
            sessionRename: vi.fn(async () => ({ success: true })),
        },
    });
});
vi.mock('@/utils/time/formatShortRelativeTime', () => ({
    formatShortRelativeTime: () => '1m',
}));
vi.mock('./sessionPinIcons', () => ({
    PinIcon: (props: Record<string, unknown>) => React.createElement('PinIcon', props),
    PinSlashIcon: (props: Record<string, unknown>) => React.createElement('PinSlashIcon', props),
}));
vi.mock('./sessionTagIcons', () => ({
    TagIcon: (props: Record<string, unknown>) => React.createElement('TagIcon', props),
}));

async function prepareSplitCanvas(sessionId: string, alreadyOpen = false) {
    const { storage } = await import('@/sync/domains/state/storageStore');
    const previousStorageState = storage.getState();
    const connection = await restoreServerAccountForTest({ serverUrl: 'https://canvas-home.example.test', accountId: 'canvas-account' });
    const serverId = connection.home.id;
    const session = createSessionFixture({ id: sessionId, active: true, metadata: { path: '/repo', machineId: 'machine-canvas', host: 'canvas.local' } });
    const anchor = createSessionFixture({ ...session, id: 'anchor' });
    storage.setState({
        sessions: { anchor, [sessionId]: session },
        sessionListRowsByServerId: { [serverId]: {
            anchor: createSessionListRenderableSessionFixture(anchor),
            [sessionId]: createSessionListRenderableSessionFixture(session),
        } },
        ordinarySessionListMembershipByServerId: { [serverId]: ['anchor', sessionId] },
    });
    const { getActiveServerAccountScope } = await import('@/sync/domains/scope/activeServerAccountScope');
    const entityScope = getActiveServerAccountScope();
    if (!entityScope) throw new Error('expected a real applied Home/Account');
    const { resolveWorkspaceTargetForSession } = await import('@/sync/domains/session/resolveWorkspaceTargetForSession');
    const { resolveSessionSplitCanvasScope } = await import('@/sync/domains/session/sessionSplitCanvasScope');
    const scope = resolveSessionSplitCanvasScope(resolveWorkspaceTargetForSession(sessionId), { routeServerId: serverId });
    if (!scope) throw new Error('expected the enrolled session workspace');
    const { collectOpenSessionIds, resolveSessionSplitCanvasState, reduceSessionSplitCanvasState, findSessionCanvasTab } = await import('@/components/sessions/canvas/sessionSplitCanvasState');
    const { sessionCanvasTabId } = await import('@/sync/domains/session/sessionSplitCanvasPersistence');
    const { collectSplitCanvasLeaves } = await import('@/components/appShell/splitCanvas/model/splitCanvasTree');
    let state = resolveSessionSplitCanvasState({ sessionId: 'anchor', scope: entityScope });
    if (alreadyOpen) {
        state = reduceSessionSplitCanvasState(state, { type: 'openSession', sessionId, leafId: state.focusedLeafId! });
        state = reduceSessionSplitCanvasState(state, { type: 'focusSession', sessionId: 'anchor' });
    }
    const { createSessionCanvasActionAdapter } = await import('@/components/sessions/canvas/sessionCanvasActions');
    const execute = createSessionCanvasActionAdapter({
        canvasKey: scope.workspaceCacheKey, getState: () => state,
        dispatch: action => { state = reduceSessionSplitCanvasState(state, action); return state; },
        // The mounted native/DOM canvas owns pixel measurement, not session admission.
        readCanvas: () => ({ readSplitMeasurement: () => ({ availableSizePx: 1200, minimumExistingSizePx: 420 }), resizeSplit: () => false }),
        getWorkspaceScope: identity => resolveSessionSplitCanvasScope(resolveWorkspaceTargetForSession(identity), { routeServerId: identity.serverId }),
    });
    const { registerSessionSplitCanvasRuntime } = await import('@/components/sessions/canvas/sessionSplitCanvasRuntime');
    const retire = registerSessionSplitCanvasRuntime({
        snapshot: { routeSessionId: 'anchor', focusedSessionId: 'anchor', openSessionIds: collectOpenSessionIds(state), scope, entityScope, canvasKey: scope.workspaceCacheKey },
        controller: {
            executeAction: execute,
            openSessionInSplit: input => { execute('session.canvas.tabs.open', { scope: entityScope, canvasKey: scope.workspaceCacheKey, sessionId: input.sessionId, leafId: state.focusedLeafId, placement: input.direction }); },
            focusSession: targetSessionId => { execute('session.canvas.tabs.activate', { scope: entityScope, canvasKey: scope.workspaceCacheKey, tabId: sessionCanvasTabId(entityScope, targetSessionId) }); },
        },
    });
    return {
        serverId, session, state: () => state, openSessionIds: () => collectOpenSessionIds(state),
        addresses: () => collectSplitCanvasLeaves(state.root).flatMap(leaf => leaf.payload.group.tabIds.map(tabId => leaf.payload.tabs[tabId].address)),
        focusedSessionId: () => {
            const tabId = collectSplitCanvasLeaves(state.root).find(leaf => leaf.id === state.focusedLeafId)?.payload.group.activeTabId;
            return tabId ? findSessionCanvasTab(state, tabId)?.tab.address.sessionId : null;
        },
        async dispose() { retire(); await connection.dispose(); storage.setState(previousStorageState, true); },
    };
}

describe('SessionItem navigation', () => {
    function createSession(id: string) {
        return createSessionFixture({
            id,
            active: true,
            activeAt: 1,
            metadata: { path: '/repo', machineId: 'machine-canvas', host: 'canvas.local' },
        });
    }

    async function renderSessionItem(props: SessionItemProps) {
        const { SessionItem } = await import('./SessionItem');
        const ModelBackedSessionItem = createModelBackedSessionItemTestComponent(SessionItem, {
            resolveRowViewModelOverrides: (itemProps) => ({
                identityDisplay: itemProps.compactMinimal === true ? 'none' : 'avatar',
            }),
        });
        return renderScreen(<ModelBackedSessionItem {...props} />);
    }

    function triggerHoverEnter(node: any) {
        node.props.onMouseEnter?.();
        node.props.onHoverIn?.();
        node.props.onPointerEnter?.();
    }

    async function triggerAllHoverTargets(screen: Awaited<ReturnType<typeof renderSessionItem>>) {
        const hoverTargets = screen.root.findAll((node: any) => (
            typeof node.props?.onPointerEnter === 'function'
            || typeof node.props?.onMouseEnter === 'function'
            || typeof node.props?.onHoverIn === 'function'
        ));
        await act(async () => {
            for (const target of hoverTargets) {
                triggerHoverEnter(target);
            }
        });
    }

    afterEach(async () => {
        standardCleanup();
        await splitFixture?.dispose();
        splitFixture = null;
    });

    it('passes serverId when navigating to a session', async () => {
        navigateSpy.mockClear();

        const screen = await renderSessionItem({
            session: createSession('sess_1'),
            serverId: 'server_a',
            serverName: 'Server A',
            showServerBadge: true,
            selected: false,
            isFirst: true,
            isLast: true,
            isSingle: true,
            variant: 'default',
            compact: false,
        });

        await screen.pressByTestIdAsync('session-list-item-sess_1');

        expect(navigateSpy).toHaveBeenCalledTimes(1);
        expect(navigateSpy).toHaveBeenCalledWith('sess_1', { serverId: 'server_a' });

        await screen.unmount();
    });

    it('hides avatars in minimal compact mode', async () => {
        const screen = await renderSessionItem({
            session: createSession('sess_min'),
            serverId: 'server_a',
            serverName: 'Server A',
            showServerBadge: true,
            selected: false,
            isFirst: true,
            isLast: true,
            isSingle: true,
            variant: 'default',
            compact: true,
            compactMinimal: true,
        });

        expect(screen.findByTestId('session-item-avatar')).toBeNull();

        await screen.unmount();
    });

    it('adds split commands to the more menu when a compatible split canvas is available', async () => {
        splitFixture = await prepareSplitCanvas('sess_split');

        const screen = await renderSessionItem({
            session: splitFixture.session,
            serverId: splitFixture.serverId,
            serverName: 'Server A',
            showServerBadge: true,
            selected: false,
            isFirst: true,
            isLast: true,
            isSingle: true,
            variant: 'default',
            compact: false,
        });

        await triggerAllHoverTargets(screen);

        const moreMenu = screen.findAllByType('DropdownMenu').find((dropdown: any) => dropdown.props.search !== true);
        const moreMenuItemIds = moreMenu?.props.items.map((item: any) => item.id);
        expect(moreMenuItemIds).toEqual(expect.arrayContaining([
            'openInSplitRight',
            'openInSplitDown',
            SESSION_ACTION_RENAME_ID,
            SESSION_ACTION_STOP_ID,
            SESSION_ACTION_ARCHIVE_ID,
        ]));

        await act(async () => {
            moreMenu?.props.onSelect('openInSplitRight');
        });

        expect(splitFixture.openSessionIds()).toEqual(['anchor', 'sess_split']);
        expect(splitFixture.state().root).toMatchObject({ kind: 'split', axis: 'row' });
        expect(splitFixture.addresses()).toEqual([
            { serverId: splitFixture.serverId, sessionId: 'anchor' },
            { serverId: splitFixture.serverId, sessionId: 'sess_split' },
        ]);

        await screen.unmount();
    });

    it('keeps desktop row navigation without a separate split handle and opens splits from its menu', async () => {
        splitFixture = await prepareSplitCanvas('sess_drag');

        const screen = await renderSessionItem({
            session: splitFixture.session,
            serverId: splitFixture.serverId,
            serverName: 'Server A',
            showServerBadge: true,
            selected: false,
            isFirst: true,
            isLast: true,
            isSingle: true,
            variant: 'default',
            compact: false,
        });

        await triggerAllHoverTargets(screen);

        expect(screen.findByTestId('session-item-split-drag-handle-sess_drag')).toBeNull();
        navigateSpy.mockClear();
        await screen.pressByTestIdAsync('session-list-item-sess_drag');
        expect(navigateSpy).toHaveBeenCalledWith('sess_drag', { serverId: splitFixture.serverId });
        expect(splitFixture.openSessionIds()).toEqual(['anchor']);

        const menu = screen.findAllByType('DropdownMenu').find((dropdown) => dropdown.props.search !== true);
        expect(menu?.props.items).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 'openInSplitRight' }),
        ]));

        await act(async () => {
            menu?.props.onSelect('openInSplitRight');
        });

        expect(splitFixture.openSessionIds()).toEqual(['anchor', 'sess_drag']);
        expect(splitFixture.state().root).toMatchObject({ kind: 'split', axis: 'row' });
        expect(splitFixture.addresses()).toEqual([
            { serverId: splitFixture.serverId, sessionId: 'anchor' },
            { serverId: splitFixture.serverId, sessionId: 'sess_drag' },
        ]);

        await screen.unmount();
    });

    it('shows reveal-in-split instead of duplicate split commands for sessions already open in the active canvas', async () => {
        splitFixture = await prepareSplitCanvas('sess_reveal', true);
        expect(splitFixture.focusedSessionId()).toBe('anchor');

        const screen = await renderSessionItem({
            session: splitFixture.session,
            serverId: splitFixture.serverId,
            serverName: 'Server A',
            showServerBadge: true,
            selected: false,
            isFirst: true,
            isLast: true,
            isSingle: true,
            variant: 'default',
            compact: false,
        });

        await triggerAllHoverTargets(screen);

        const moreMenu = screen.findAllByType('DropdownMenu').find((dropdown: any) => dropdown.props.search !== true);
        expect(moreMenu?.props.items.map((item: any) => item.id)).toContain('revealInCurrentSplit');
        expect(moreMenu?.props.items.map((item: any) => item.id)).not.toContain('openInSplitRight');
        expect(moreMenu?.props.items.map((item: any) => item.id)).not.toContain('openInSplitDown');

        await act(async () => {
            moreMenu?.props.onSelect('revealInCurrentSplit');
        });

        expect(splitFixture.openSessionIds()).toEqual(['anchor', 'sess_reveal']);
        expect(splitFixture.focusedSessionId()).toBe('sess_reveal');

        await screen.unmount();
    });
});
