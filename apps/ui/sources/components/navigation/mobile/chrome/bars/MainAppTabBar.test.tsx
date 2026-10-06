import * as React from 'react';
import renderer from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSessionFixture, flattenTestStyle, renderScreen, standardCleanup } from '@/dev/testkit';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { FeaturesResponseSchema, UserProfileSchema } from '@happier-dev/protocol';
import { installUiListsCommonModuleMocks } from '@/components/ui/lists/uiListsTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

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

installUiListsCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: 'View',
            Pressable: ({ children, ...props }: any) => React.createElement('Pressable', props, children),
        });
    },
});

vi.mock('expo-image', () => ({
    get Image() {
        return expoImageState.image;
    },
}));

vi.mock('expo-blur', () => ({
    BlurView: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
        React.createElement('BlurView', props, children),
}));

vi.mock('@/components/ui/layout/layout', () => ({
    layout: { maxWidth: 960 },
    useLayoutMaxWidth: () => 960,
    useLayoutMaxWidthStyle: () => ({ maxWidth: 960 }),
}));

async function renderTabBar(element: React.ReactElement) {
    const { storage } = await import('@/sync/domains/state/storageStore');
    const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverProfiles');
    const { primeServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
    const { InboxSummaryProvider } = await import('@/hooks/inbox/useInboxSummary');
    const { buildSessionListRenderableFromSession } = await import('@/sync/domains/session/listing/sessionListRenderable');
    const serverId = getActiveServerSnapshot().serverId;
    const baseFeatures = createRootLayoutFeaturesResponse({ features: { workflows: { enabled: false }, automations: { enabled: false } } });
    const features = FeaturesResponseSchema.parse({ ...baseFeatures, capabilities: { ...baseFeatures.capabilities,
        social: { friends: { allowUsername: true, requiredIdentityProviderId: null } } } });
    primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready', features } });
    const session = createSessionFixture({ id: 'needs-attention', serverId, active: true, activeAt: Date.now(),
        pendingPermissionRequestCount: 1, pendingRequestObservedAt: Date.now() });
    const hasAttention = sessionsAttentionState.hasAttention || inboxState.hasContent;
    storage.setState({
        isDataReady: true,
        profile: { ...storage.getState().profile, username: 'tabbar-viewer' },
        settings: { ...storage.getState().settings,
            tabBarFriendsBadgeEnabled: badgeSettingsState.friends, tabBarInboxBadgeEnabled: badgeSettingsState.inbox,
            tabBarSessionsBadgeEnabled: badgeSettingsState.sessions, tabBarShowLabels: badgeSettingsState.showLabels,
            tabBarSize: 'regular' },
        friends: Object.fromEntries(friendRequestsState.items.map(({ id }) => [id, UserProfileSchema.parse({
            id, username: id, firstName: id, lastName: null, avatar: null, bio: null, publicKey: null, status: 'pending' })])),
        sessions: hasAttention ? { [session.id]: session } : {},
        sessionListRowsByServerId: hasAttention ? { [serverId]: { [session.id]: buildSessionListRenderableFromSession(session) } } : {},
        ordinarySessionListMembershipByServerId: hasAttention ? { [serverId]: [session.id] } : {}, artifacts: {},
    });
    return renderScreen(<InboxSummaryProvider>{element}</InboxSummaryProvider>);
}

function hasTextChild(node: renderer.ReactTestInstance, value: string) {
    return node.findAllByType('Text' as never).some((child) => String(child.props.children) === value);
}

function hasIndicatorDot(node: renderer.ReactTestInstance) {
    return node.findAll((child) => {
        if (String(child.type) !== 'View') return false;
        const style = flattenTestStyle(child.props?.style);
        return style.width === 6 && style.height === 6;
    }).length > 0;
}

describe('MainAppTabBar', () => {
    let initialStorageState: ReturnType<typeof import('@/sync/domains/state/storageStore').storage.getState>;
    beforeEach(async () => {
        const { storage } = await import('@/sync/domains/state/storageStore');
        initialStorageState = storage.getState();
        friendRequestsState.items = [];
        inboxState.hasContent = false;
        sessionsAttentionState.hasAttention = false;
        expoImageState.image = 'Image';
        badgeSettingsState.friends = true;
        badgeSettingsState.inbox = true;
        badgeSettingsState.sessions = true;
        badgeSettingsState.showLabels = true;
    });
    afterEach(async () => {
        standardCleanup();
        (await import('@/sync/domains/state/storageStore')).storage.setState(initialStorageState, true);
    });

    it('renders a trailing accessory beside the tabs without turning it into one', async () => {
        const { MainAppTabBar } = await import('./MainAppTabBar');

        const screen = await renderTabBar(
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

        const screen = await renderTabBar(
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
        const screen = await renderTabBar(
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
            const nativeScreen = await renderTabBar(
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

        const tree = (await renderTabBar(<MainAppTabBar activeTab="sessions" onTabPress={() => {}} />)).tree;

        const tabs = tree.findAll((node) => typeof node.props?.onPress === 'function');
        const allTextNodes = tree.findAllByType('Text' as never);
        expect(tabs.some((tab) => hasIndicatorDot(tab))).toBe(false);
        expect(allTextNodes.some((node) => String(node.props.children) === '2')).toBe(false);
    });

    it('renders tabs in settings, friends, projects, sessions, inbox order', async () => {
        const { MainAppTabBar } = await import('./MainAppTabBar');

        const tree = (await renderTabBar(<MainAppTabBar activeTab="sessions" onTabPress={() => {}} />)).tree;

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

        const tree = (await renderTabBar(<MainAppTabBar activeTab="sessions" onTabPress={() => {}} />)).tree;

        const tabs = tree.findAll((node) => typeof node.props?.onPress === 'function');
        const inboxTab = tabs.find((tab) => hasIndicatorDot(tab));
        const allTextNodes = tree.findAllByType('Text' as never);

        expect(inboxTab).toBeTruthy();
        expect(allTextNodes.some((node) => String(node.props.children) === '2')).toBe(true);
        expect(hasIndicatorDot(inboxTab!)).toBe(true);
        expect(hasTextChild(inboxTab!, '2')).toBe(false);
    });

    it('shows a dot on the sessions tab when sessions need attention', async () => {
        sessionsAttentionState.hasAttention = true;
        const { MainAppTabBar } = await import('./MainAppTabBar');

        const tree = (await renderTabBar(<MainAppTabBar activeTab="inbox" onTabPress={() => {}} />)).tree;

        const sessionsTab = tree
            .findAll((node) => typeof node.props?.testID === 'string' && node.props.testID === 'tabbar-tab-sessions')[0];

        expect(sessionsTab).toBeTruthy();
        expect(hasIndicatorDot(sessionsTab!)).toBe(true);
    });

    it('announces Sessions attention only while its enabled badge is active', async () => {
        const { MainAppTabBar } = await import('./MainAppTabBar');

        sessionsAttentionState.hasAttention = false;
        const quietScreen = await renderTabBar(
            <MainAppTabBar activeTab="sessions" onTabPress={() => {}} />,
        );
        const quietSessionsTab = quietScreen.findByTestId('tabbar-tab-sessions');
        expect(quietSessionsTab?.props.accessibilityLabel).toBe('tabs.sessions');
        expect(quietSessionsTab?.props.accessibilityState).toEqual({ selected: true });

        sessionsAttentionState.hasAttention = true;
        const attentionScreen = await renderTabBar(
            <MainAppTabBar activeTab="sessions" onTabPress={() => {}} />,
        );
        const attentionSessionsTab = attentionScreen.findByTestId('tabbar-tab-sessions');
        expect(attentionSessionsTab?.props.accessibilityLabel).toBe('tabs.sessionsNeedsAttention');
        expect(attentionSessionsTab?.props.accessibilityState).toEqual({ selected: true });

        const attentionDot = attentionSessionsTab?.find(
            (node) => String(node.type) === 'View' && flattenTestStyle(node.props?.style).width === 6,
        );
        expect(attentionDot?.props.accessible).toBe(false);
        expect(attentionDot?.props.accessibilityElementsHidden).toBe(true);
        expect(attentionDot?.props.importantForAccessibility).toBe('no-hide-descendants');

        badgeSettingsState.sessions = false;
        const disabledScreen = await renderTabBar(
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
            renderTabBar(<MainAppTabBar activeTab="sessions" onTabPress={() => {}} />),
        ).resolves.toBeTruthy();
    });
});
