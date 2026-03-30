import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildServerFeaturesResponse } from '@/hooks/server/serverFeaturesTestUtils';
import { flushHookEffects } from '@/hooks/server/serverFeatureHookHarness.testHelpers';
import { renderScreen } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function createDeferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error?: unknown) => void;
    const promise = new Promise<T>((nextResolve, nextReject) => {
        resolve = nextResolve;
        reject = nextReject;
    });
    return { promise, resolve, reject };
}

describe('useRequireFriendsEnabled', () => {
    const previousScope = process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.resetModules();
        if (previousScope === undefined) delete process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
        else process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = previousScope;
    });

    it('does not redirect before the friends feature probe resolves enabled', async () => {
        vi.resetModules();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = `friends_require_enabled_${Date.now()}`;

        const deferred = createDeferred<any>();
        const replace = vi.fn();

        vi.stubGlobal(
            'fetch',
            vi.fn(async () => {
                await deferred.promise;
                return {
                    ok: true,
                    status: 200,
                    json: async () => buildServerFeaturesResponse({ friendsEnabled: true }),
                } as Response;
            }) as any,
        );

        vi.doMock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    const expoRouterMock = createExpoRouterMock({
        router: { replace },
    });
    return expoRouterMock.module;
});

        const { getStorage } = await import('@/sync/domains/state/storage');
        getStorage().getState().applySettingsLocal({
            experiments: true,
            featureToggles: { 'social.friends': true },
        });

        const seen: boolean[] = [];
        const { useRequireFriendsEnabled } = await import('./useRequireFriendsEnabled');

        function Test() {
            const enabled = useRequireFriendsEnabled();
            React.useEffect(() => {
                seen.push(enabled);
            }, [enabled]);
            return null;
        }

        let tree: renderer.ReactTestRenderer | null = null;

        tree = (await renderScreen(<Test />)).tree;
            await flushHookEffects(1);

        expect(replace).not.toHaveBeenCalled();
        expect(seen).toContain(false);

        await act(async () => {
            deferred.resolve(undefined);
            await flushHookEffects();
        });

        expect(replace).not.toHaveBeenCalled();
        expect(seen.at(-1)).toBe(true);

        await act(async () => {
            tree?.unmount();
            await flushHookEffects(1);
        });
    });

    it('redirects home after the friends feature probe resolves disabled', async () => {
        vi.resetModules();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = `friends_require_disabled_${Date.now()}`;

        const replace = vi.fn();

        vi.stubGlobal(
            'fetch',
            vi.fn(async () => ({
                ok: true,
                status: 200,
                json: async () => buildServerFeaturesResponse({ friendsEnabled: false }),
            })) as any,
        );

        vi.doMock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    const expoRouterMock = createExpoRouterMock({
        router: { replace },
    });
    return expoRouterMock.module;
});

        const { getStorage } = await import('@/sync/domains/state/storage');
        getStorage().getState().applySettingsLocal({
            experiments: true,
            featureToggles: { 'social.friends': true },
        });

        const { useRequireFriendsEnabled } = await import('./useRequireFriendsEnabled');

        function Test() {
            useRequireFriendsEnabled();
            return null;
        }

        let tree: renderer.ReactTestRenderer | null = null;

        tree = (await renderScreen(<Test />)).tree;
            await flushHookEffects();

        expect(replace).toHaveBeenCalledWith('/');

        await act(async () => {
            tree?.unmount();
            await flushHookEffects(1);
        });
    });
});
