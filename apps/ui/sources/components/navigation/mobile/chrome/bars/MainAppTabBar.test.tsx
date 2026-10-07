import * as React from 'react';
import 'fake-indexeddb/auto';
import renderer from 'react-test-renderer';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createRootLayoutFeaturesResponse, createSessionFixture, flushHookEffects, renderScreen as renderBoundaryScreen, standardCleanup } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storage';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { InboxSummaryProvider } from '@/hooks/inbox/useInboxSummary';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { createHomeHubArtifactHttpBoundary } from '@/dev/testkit/harness/homeHubArtifactHttpBoundary';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { TabBadge } from '@/components/ui/navigation/tabBadge/TabBadge';
import { actionOperationStore } from '@/sync/domains/actionOperations/actionOperationStore';
import '@/sync/syncEngine';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const friendRequestsState = vi.hoisted(() => ({
    items: [] as Array<{ id: string }>,
}));

const inboxState = vi.hoisted(() => ({
    hasContent: false,
}));

const sessionsAttentionState = vi.hoisted(() => ({
    hasAttention: false,
}));
const expoImageState = vi.hoisted(() => ({
    image: 'Image' as unknown,
}));

const badgeSettingsState = vi.hoisted(() => ({
    friends: true,
    inbox: true,
    sessions: true,
    showLabels: true,
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: key => key });
});

vi.mock('react-native-safe-area-context', () => ({
    initialWindowMetrics: null,
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock('expo-image', () => ({
    get Image() {
        return expoImageState.image;
    },
}));

vi.mock('expo-blur', () => ({
    BlurView: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
        React.createElement('BlurView', props, children),
}));

installDisconnectedServerSocketBoundary();
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>>;

function badgeSettings() {
    return { ...settingsDefaults, experiments: true, featureToggles: { 'social.friends': true },
        tabBarFriendsBadgeEnabled: badgeSettingsState.friends, tabBarInboxBadgeEnabled: badgeSettingsState.inbox,
        tabBarSessionsBadgeEnabled: badgeSettingsState.sessions, tabBarShowLabels: badgeSettingsState.showLabels };
}

async function renderScreen(element: React.ReactElement) {
    await flushHookEffects({ cycles: 3 });
    const serverId = resolveServerProfileScopeIdForIdentifier(connection.home.id);
    const makeSession = (id: string, attention: boolean) => createSessionFixture({
        id, serverId, active: true, activeAt: Date.now(), updatedAt: Date.now(),
        agentState: attention ? { requests: { permission: { tool: 'Bash', arguments: {}, kind: 'permission', createdAt: Date.now() } }, completedRequests: {} } : null,
    });
    const sessions = sessionsAttentionState.hasAttention ? [makeSession('needs-attention', true)] : [];
    await act(async () => {
        // An unseen failed operation belongs to Inbox and cannot light the Sessions badge.
        actionOperationStore.reset();
        if (inboxState.hasContent) actionOperationStore.mergeSnapshots({ serverId, snapshots: [{
            version: 1, operationId: 'operation-1', requestId: 'request-1', revision: 1,
            actionId: 'session.handoff', state: 'failed', scope: { accountId: 'tabbar-account', machineId: 'machine-1' },
            title: 'Handoff', createdAt: 1, settledAt: 2, progress: { kind: 'indeterminate' }, cancellation: 'unsupported',
        }] });
        storage.setState({
            isDataReady: true,
            settings: badgeSettings(),
            friends: Object.fromEntries(friendRequestsState.items.map(({ id }) => [id, {
                id, username: id, firstName: id, lastName: null, avatar: null, bio: null, publicKey: null, badges: [], status: 'pending' as const,
            }])),
            sessions: Object.fromEntries(sessions.map(session => [session.id, session])),
            sessionListRowsByServerId: { [serverId]: Object.fromEntries(sessions.map(session => [session.id, buildSessionListRenderableFromSession(session)])) },
            ordinarySessionListMembershipByServerId: { [serverId]: sessions.map(session => session.id) },
            sessionListIndexByServerId: {}, concurrentSessionListCacheByServerId: {},
        });
    });
    const screen = await renderBoundaryScreen(
        <InjectedAuthProvider credentials={connection.credentials}>
            <InboxSummaryProvider>{element}</InboxSummaryProvider>
        </InjectedAuthProvider>,
    );
    await flushHookEffects({ cycles: 3 });
    return screen;
}

function hasTextChild(node: renderer.ReactTestInstance, value: string) {
    return node.findAllByType('Text' as never).some((child) => String(child.props.children) === value);
}

function hasIndicatorDot(node: renderer.ReactTestInstance) {
    return node.findAllByType(TabBadge).some(badge => badge.props.variant === 'dot');
}

describe('MainAppTabBar', () => {
    beforeEach(async () => {
        friendRequestsState.items = [];
        inboxState.hasContent = false;
        sessionsAttentionState.hasAttention = false;
        expoImageState.image = 'Image';
        badgeSettingsState.friends = true;
        badgeSettingsState.inbox = true;
        badgeSettingsState.sessions = true;
        badgeSettingsState.showLabels = true;
        const artifact = createHomeHubArtifactHttpBoundary('tabbar-account');
        connection = await restoreServerAccountForTest({ serverUrl: 'https://tabbar.test', accountId: 'tabbar-account', request: (url, init) => {
            const path = new URL(String(url)).pathname;
            if (path === '/v2/account/settings') return Promise.resolve(Response.json({ content: { t: 'plain', v: badgeSettings() }, version: 1 }));
            if (path === '/v1/features') return Promise.resolve(Response.json(createRootLayoutFeaturesResponse({
                features: { workflows: { enabled: false }, automations: { enabled: false } },
            })));
            return artifact.request(url, init);
        } });
    });
    afterEach(async () => {
        standardCleanup();
        actionOperationStore.reset();
        await connection.dispose();
    });

    it('renders a trailing accessory beside the tabs without turning it into one', async () => {
        const { MainAppTabBar } = await import('./MainAppTabBar');

        const screen = await renderScreen(
            <MainAppTabBar
                activeTab="sessions"
                onTabPress={() => {}}
                trailingAccessory={React.createElement('TrailingAccessory')}
            />,
        );

        // A sibling capsule, never an extra tab: it must not appear inside the tablist and must
        // never be eligible for the active-tab highlight.
        expect(screen.tree.root.findAllByType('TrailingAccessory' as never)).toHaveLength(1);
        const tablist = screen.tree.root.find((node) => node.props.accessibilityRole === 'tablist');
        expect(tablist.findAllByType('TrailingAccessory' as never)).toHaveLength(0);
    });

    it('exposes localized tab semantics and selected state when visual labels are hidden', async () => {
        badgeSettingsState.showLabels = false;
        friendRequestsState.items = [{ id: 'fr-1' }, { id: 'fr-2' }];
        inboxState.hasContent = true;
        sessionsAttentionState.hasAttention = true;
        const { MainAppTabBar } = await import('./MainAppTabBar');

        const screen = await renderScreen(
            <MainAppTabBar activeTab="sessions" onTabPress={() => {}} />,
        );

        expect(screen.tree.findAll((node) => node.props.accessibilityRole === 'tablist')).toHaveLength(1);

        const expectedTabs = [
            ['settings', 'tabs.settings', false],
            ['friends', 'tabs.friends', false],
            ['projects', 'tabs.projects', false],
            ['sessions', 'tabs.sessionsNeedsAttention', true],
            ['inbox', 'tabs.inbox', false],
        ] as const;

        for (const [id, label, selected] of expectedTabs) {
            const tab = screen.findByTestId(`tabbar-tab-${id}`);
            expect(tab?.props.accessibilityRole).toBe('tab');
            expect(tab?.props.accessibilityLabel).toBe(label);
            expect(tab?.props.accessibilityState).toEqual({ selected });
            expect(tab?.props['aria-selected']).toBe(selected);
            expect(tab && hasTextChild(tab, label)).toBe(false);
        }
    });

    it('supplements RNW tab activation for Space without double-handling Enter or pointer presses', async () => {
        const onTabPress = vi.fn();
        const { MainAppTabBar } = await import('./MainAppTabBar');
        const screen = await renderScreen(
            <MainAppTabBar activeTab="sessions" onTabPress={onTabPress} />,
        );
        const projectsTab = screen.findByTestId('tabbar-tab-projects');
        const preventDefault = vi.fn();

        expect(projectsTab?.props.onKeyDown).toEqual(expect.any(Function));
        projectsTab?.props.onKeyDown({
            key: ' ',
            nativeEvent: { key: ' ' },
            preventDefault,
        });
        expect(preventDefault).toHaveBeenCalledOnce();
        expect(onTabPress).toHaveBeenCalledOnce();
        expect(onTabPress).toHaveBeenLastCalledWith('projects');

        projectsTab?.props.onKeyDown({
            key: 'Enter',
            nativeEvent: { key: 'Enter' },
            preventDefault,
        });
        expect(onTabPress).toHaveBeenCalledOnce();

        projectsTab?.props.onPress();
        expect(onTabPress).toHaveBeenCalledTimes(2);
        expect(onTabPress).toHaveBeenLastCalledWith('projects');

        const { Platform } = await import('react-native');
        const previousPlatform = Platform.OS;
        (Platform as { OS: string }).OS = 'ios';
        try {
            const nativeScreen = await renderScreen(
                <MainAppTabBar activeTab="sessions" onTabPress={onTabPress} />,
            );
            expect(nativeScreen.findByTestId('tabbar-tab-projects')?.props.onKeyDown).toBeUndefined();
        } finally {
            (Platform as { OS: string }).OS = previousPlatform;
        }
    });

    it('hides tab badges when disabled in settings', async () => {
        friendRequestsState.items = [{ id: 'fr-1' }, { id: 'fr-2' }];
        inboxState.hasContent = true;
        sessionsAttentionState.hasAttention = true;
        badgeSettingsState.friends = false;
        badgeSettingsState.inbox = false;
        badgeSettingsState.sessions = false;
        const { MainAppTabBar } = await import('./MainAppTabBar');

        const tree = (await renderScreen(<MainAppTabBar activeTab="sessions" onTabPress={() => {}} />)).tree;

        const tabs = tree.findAll((node) => typeof node.props?.onPress === 'function');
        const allTextNodes = tree.findAllByType('Text' as never);
        expect(tabs.some((tab) => hasIndicatorDot(tab))).toBe(false);
        expect(allTextNodes.some((node) => String(node.props.children) === '2')).toBe(false);
    });

    it('renders tabs in settings, friends, projects, sessions, inbox order', async () => {
        const { MainAppTabBar } = await import('./MainAppTabBar');

        const tree = (await renderScreen(<MainAppTabBar activeTab="sessions" onTabPress={() => {}} />)).tree;

        const tabIds = Array.from(new Set(
            tree.findAll((node) => typeof node.props?.testID === 'string' && node.props.testID.startsWith('tabbar-tab-'))
                .map((node) => String(node.props.testID).replace('tabbar-tab-', '')),
        ));

        expect(tabIds).toEqual(['settings', 'friends', 'projects', 'sessions', 'inbox']);
    });

    it('shows friend request counts on the friends tab and a dot for inbox content', async () => {
        friendRequestsState.items = [{ id: 'fr-1' }, { id: 'fr-2' }];
        inboxState.hasContent = true;
        const { MainAppTabBar } = await import('./MainAppTabBar');

        const tree = (await renderScreen(<MainAppTabBar activeTab="sessions" onTabPress={() => {}} />)).tree;

        const inboxTab = tree.root.findByProps({ testID: 'tabbar-tab-inbox' });
        const friendsTab = tree.root.findByProps({ testID: 'tabbar-tab-friends' });
        const sessionsTab = tree.root.findByProps({ testID: 'tabbar-tab-sessions' });

        expect(inboxTab).toBeTruthy();
        expect(hasTextChild(friendsTab, '2')).toBe(true);
        expect(hasIndicatorDot(inboxTab!)).toBe(true);
        expect(hasTextChild(inboxTab!, '2')).toBe(false);
        expect(hasIndicatorDot(sessionsTab)).toBe(false);
    });

    it('shows a dot on the sessions tab when sessions need attention', async () => {
        sessionsAttentionState.hasAttention = true;
        const { MainAppTabBar } = await import('./MainAppTabBar');

        const tree = (await renderScreen(<MainAppTabBar activeTab="inbox" onTabPress={() => {}} />)).tree;

        const sessionsTab = tree
            .findAll((node) => typeof node.props?.testID === 'string' && node.props.testID === 'tabbar-tab-sessions')[0];

        expect(sessionsTab).toBeTruthy();
        expect(hasIndicatorDot(sessionsTab!)).toBe(true);
    });

    it('announces Sessions attention only while its enabled badge is active', async () => {
        const { MainAppTabBar } = await import('./MainAppTabBar');

        sessionsAttentionState.hasAttention = false;
        const quietScreen = await renderScreen(
            <MainAppTabBar activeTab="sessions" onTabPress={() => {}} />,
        );
        const quietSessionsTab = quietScreen.findByTestId('tabbar-tab-sessions');
        expect(quietSessionsTab?.props.accessibilityLabel).toBe('tabs.sessions');
        expect(quietSessionsTab?.props.accessibilityState).toEqual({ selected: true });

        sessionsAttentionState.hasAttention = true;
        const attentionScreen = await renderScreen(
            <MainAppTabBar activeTab="sessions" onTabPress={() => {}} />,
        );
        const attentionSessionsTab = attentionScreen.findByTestId('tabbar-tab-sessions');
        expect(attentionSessionsTab?.props.accessibilityLabel).toBe('tabs.sessionsNeedsAttention');
        expect(attentionSessionsTab?.props.accessibilityState).toEqual({ selected: true });

        const attentionDot = attentionSessionsTab?.find(
            (node) => typeof node.type === 'string' && node.props.importantForAccessibility === 'no-hide-descendants',
        );
        expect(attentionDot?.props.accessible).toBe(false);
        expect(attentionDot?.props.accessibilityElementsHidden).toBe(true);
        expect(attentionDot?.props.importantForAccessibility).toBe('no-hide-descendants');

        badgeSettingsState.sessions = false;
        const disabledScreen = await renderScreen(
            <MainAppTabBar activeTab="sessions" onTabPress={() => {}} />,
        );
        const disabledSessionsTab = disabledScreen.findByTestId('tabbar-tab-sessions');
        expect(disabledSessionsTab?.props.accessibilityLabel).toBe('tabs.sessions');
        expect(disabledSessionsTab?.props.accessibilityState).toEqual({ selected: true });
    });

    it('renders without crashing when expo-image omits Image', async () => {
        expoImageState.image = undefined;
        const { MainAppTabBar } = await import('./MainAppTabBar');

        await expect(
            renderScreen(<MainAppTabBar activeTab="sessions" onTabPress={() => {}} />),
        ).resolves.toBeTruthy();
    });
});
