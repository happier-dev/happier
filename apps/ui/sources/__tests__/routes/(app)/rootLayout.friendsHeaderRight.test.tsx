import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { Stack } from 'expo-router';

import { storage } from '@/sync/domains/state/storageStore';
import { profileDefaults } from '@/sync/domains/profiles/profile';

import { createOkFetchResponse, createRootLayoutFeaturesResponse } from '@/dev/testkit/rootLayoutTestkit';

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

async function flushMicrotasks(limit = 20) {
    // Feature probe hooks resolve via async/await chains (no timers), so yielding a few
    // microtasks is the most deterministic way to let effects settle.
    for (let i = 0; i < limit; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await Promise.resolve();
    }
}

async function flushEffects(): Promise<void> {
    // Feature probe hooks perform async fetches inside a `useEffect`, which React flushes
    // on the next tick in these test environments. Matching other hook tests, yield a macrotask.
    await new Promise((r) => setTimeout(r, 0));
}

async function renderRootLayout() {
    const { default: RootLayout } = await import('@/app/(app)/_layout');
    let tree: ReturnType<typeof renderer.create> | undefined;
    act(() => {
        tree = renderer.create(<RootLayout />);
    });
    await act(async () => {
        await flushEffects();
    });
    return tree;
}

function getFriendsManageScreen(tree: ReturnType<typeof renderer.create> | undefined) {
    const screens = tree?.root.findAllByType(Stack.Screen) ?? [];
    return screens.find((node) => node.props?.name === 'friends/manage');
}

function getScreenNames(tree: ReturnType<typeof renderer.create> | undefined): string[] {
    return (tree?.root.findAllByType(Stack.Screen) ?? [])
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
                // Let feature probing fetch + apply server features so the headerRight opacity
                // reflects the computed friends identity readiness.
                await act(async () => {
                    await flushEffects();
                });

                const friendsManage = getFriendsManageScreen(tree);
                expect(friendsManage).toBeTruthy();

                const options = friendsManage?.props?.options?.({ navigation: { navigate: vi.fn() } });
                expect(typeof options?.headerRight).toBe('function');

                const node = options.headerRight();
                expect(node).not.toBeNull();
                expect(node.props?.style?.opacity).toBe(scenario.expectedOpacity);
            } finally {
                act(() => {
                    tree?.unmount();
                });
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
            act(() => {
                tree?.unmount();
            });
        }
    });
});
