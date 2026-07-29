import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Stack } from 'expo-router';

import { storage } from '@/sync/domains/state/storageStore';
import { profileDefaults } from '@/sync/domains/profiles/profile';

import { createOkFetchResponse, createRootLayoutFeaturesResponse, flushHookEffects, renderScreen } from '@/dev/testkit';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';

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

let friendsIdentityReady = false;
const routerMockState = vi.hoisted(() => ({
    push: vi.fn(),
    back: vi.fn(),
    replace: vi.fn(),
    setParams: vi.fn(),
}));


vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({
        pathname: '/',
        segments: ['(app)'],
        router: routerMockState,
    }).module;
});

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({ isAuthenticated: false }),
}));

vi.mock('@/auth/routing/authRouting', () => ({
    isPublicRouteForUnauthenticated: () => true,
}));

vi.mock('@/hooks/server/useFriendsIdentityReadiness', () => ({
    useFriendsIdentityReadiness: () => ({ isReady: friendsIdentityReady }),
}));

vi.mock('@/activity/badges/ActivityBadgeRuntime', () => ({
    ActivityBadgeRuntime: () => null,
}));

vi.mock('@/components/navigation/mobile/chrome/MobileBottomChromeHost', () => ({
    MobileBottomChromeHost: () => null,
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
    setRuntimeFetch(fetchMock);
}

async function renderRootLayout() {
    const { default: RootLayout } = await import('@/app/(app)/_layout');
    const screen = await renderScreen(<RootLayout />);
    await flushHookEffects({ cycles: 10, turns: 3 });
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

function getRegisteredScreen(
    screen: Awaited<ReturnType<typeof renderScreen>>,
    name: string,
) {
    return (screen.findAllByType(Stack.Screen) ?? [])
        .find((node) => node.props?.name === name);
}

afterEach(() => {
    resetRuntimeFetch();
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
            friendsIdentityReady = scenario.linkedProviders.length > 0 && typeof scenario.username === 'string' && scenario.username.length > 0;
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
        } finally {
            await tree?.unmount();
        }
    });

    it('registers settings as a nested navigator', async () => {
        vi.resetModules();
        stubRootLayoutFeaturesFetch();

        const tree = await renderRootLayout();
        try {
            const screenNames = getScreenNames(tree);

            expect(screenNames).toContain('settings');
        } finally {
            await tree?.unmount();
        }
    });

    it('registers project list and project detail source-control routes', async () => {
        vi.resetModules();
        stubRootLayoutFeaturesFetch();

        const tree = await renderRootLayout();
        try {
            const screenNames = getScreenNames(tree);

            expect(screenNames).toContain('projects/index');
            expect(screenNames).toContain('projects/[workspaceRefId]/index');
            expect(screenNames).toContain('projects/[workspaceRefId]/files');
            expect(screenNames).toContain('projects/[workspaceRefId]/git');
            expect(screenNames).toContain('projects/[workspaceRefId]/details');
            expect(screenNames).toContain('projects/[workspaceRefId]/terminal');
        } finally {
            await tree?.unmount();
        }
    });

    it('renders terminal connect without the shell header on web', async () => {
        vi.resetModules();
        stubRootLayoutFeaturesFetch();

        const tree = await renderRootLayout();
        try {
            const terminalConnect = getRegisteredScreen(tree, 'terminal/connect');
            expect(terminalConnect).toBeTruthy();
            expect(terminalConnect?.props?.options).toMatchObject({
                headerShown: false,
            });
        } finally {
            await tree?.unmount();
        }
    });
});
