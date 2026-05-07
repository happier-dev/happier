import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Stack } from 'expo-router';

import { storage } from '@/sync/domains/state/storageStore';
import { profileDefaults } from '@/sync/domains/profiles/profile';

import { createOkFetchResponse, createRootLayoutFeaturesResponse, flushHookEffects, renderScreen } from '@/dev/testkit';

type ReactActEnvironmentGlobal = typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
};
(globalThis as ReactActEnvironmentGlobal).IS_REACT_ACT_ENVIRONMENT = true;

type LinkedProvider = {
    id: string;
    login: string;
    displayName: string;
    avatarUrl: string;
    profileUrl: string;
    showOnProfile: boolean;
};

vi.mock('react-native-reanimated', () => ({}));

vi.mock('@/components/navigation/mobile/chrome/MobileBottomChromeHost', () => ({
    MobileBottomChromeHost: () => React.createElement('MobileBottomChromeHost'),
}));

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({ isAuthenticated: false }),
}));

vi.mock('@/auth/routing/authRouting', () => ({
    isPublicRouteForUnauthenticated: () => true,
}));

function createGithubLinkedProvider(): LinkedProvider {
    return {
        id: 'github',
        login: 'user',
        displayName: 'User',
        avatarUrl: 'https://example.com/avatar.png',
        profileUrl: 'https://github.com/user',
        showOnProfile: true,
    };
}

function stubRootLayoutFeaturesFetch() {
    const payload = createRootLayoutFeaturesResponse();
    const fetchMock: typeof fetch = (() => createOkFetchResponse(payload)) as unknown as typeof fetch;
    vi.stubGlobal('fetch', vi.fn(fetchMock));
}

async function renderRootLayout() {
    const { default: RootLayout } = await import('@/app/(app)/_layout');
    const screen = await renderScreen(<RootLayout />);
    await flushHookEffects({ cycles: 1, turns: 1 });
    return screen;
}

function getFriendsManageScreen(screen: Awaited<ReturnType<typeof renderScreen>>) {
    const screens = screen.findAllByType(Stack.Screen) ?? [];
    return screens.find((node) => node.props?.name === 'friends/manage');
}

function getScreenNames(screen: Awaited<ReturnType<typeof renderScreen>>): string[] {
    return (screen.findAllByType(Stack.Screen) ?? [])
        .map((node) => node.props?.name)
        .filter((name): name is string => typeof name === 'string');
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('RootLayout', () => {
    const scenarios: Array<{
        expectedOpacity: number;
        linkedProviders: LinkedProvider[];
        name: string;
        username: string | null;
    }> = [
        {
            name: 'dims friends add button when identity is not ready',
            linkedProviders: [],
            username: null,
            expectedOpacity: 0.5,
        },
        {
            name: 'dims friends add button when GitHub is connected but username is missing',
            linkedProviders: [createGithubLinkedProvider()],
            username: null,
            expectedOpacity: 0.5,
        },
        {
            name: 'shows friends add button when GitHub is connected and username is set',
            linkedProviders: [createGithubLinkedProvider()],
            username: 'user',
            expectedOpacity: 1,
        },
    ];

    for (const scenario of scenarios) {
        it(scenario.name, async () => {
            vi.resetModules();
            stubRootLayoutFeaturesFetch();
            storage.getState().applyProfile({
                ...profileDefaults,
                username: scenario.username,
                linkedProviders: scenario.linkedProviders,
            });

            const tree = await renderRootLayout();
            try {
                const friendsManage = getFriendsManageScreen(tree);
                expect(friendsManage).toBeTruthy();

                const options = friendsManage?.props?.options?.({ navigation: { navigate: vi.fn() } });
                expect(typeof options?.headerRight).toBe('function');

                const node = options.headerRight();
                expect(node).not.toBeNull();
                expect(node.props?.style?.opacity).toBe(scenario.expectedOpacity);
            } finally {
                await tree?.unmount();
            }
        });
    }

    it('registers session detail routes for tool and execution-run screens', async () => {
        vi.resetModules();
        stubRootLayoutFeaturesFetch();

        const tree = await renderRootLayout();
        try {
            const screenNames = getScreenNames(tree);

            expect(screenNames).toContain('session/[id]/message/[messageId]');
            expect(screenNames).toContain('session/[id]/runs/new');
            expect(screenNames).toContain('session/[id]/runs/[runId]');
            expect(screenNames).toContain('session/[id]/git');
            expect(tree.findAllByType('MobileBottomChromeHost' as never)).toHaveLength(1);
        } finally {
            await tree?.unmount();
        }
    });

    it('delegates settings child routes to the nested settings layout', async () => {
        vi.resetModules();
        stubRootLayoutFeaturesFetch();

        const tree = await renderRootLayout();
        try {
            const screenNames = getScreenNames(tree);

            expect(screenNames).toContain('settings');
            expect(screenNames).not.toContain('settings/machines/this-computer');
        } finally {
            await tree?.unmount();
        }
    });
});
