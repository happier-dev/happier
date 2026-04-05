import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderHook } from '@/dev/testkit';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';
import { flushHookEffects } from '@/hooks/server/serverFeatureHookHarness.testHelpers';
import { buildServerFeaturesResponse } from '@/hooks/server/serverFeaturesTestUtils';
import {
    getServerFeaturesSnapshot,
    resetServerFeaturesClientForTests,
} from '@/sync/api/capabilities/serverFeaturesClient';
import {
    resetServerReachabilitySupervisors,
    setServerReachabilityNetworkAllowed,
} from '@/sync/runtime/connectivity/serverReachabilitySupervisorPool';
import { setActiveServerId, upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { getStorage } from '@/sync/domains/state/storage';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

type Deferred<T> = Readonly<{
    promise: Promise<T>;
    resolve: (value: T) => void;
}>;

function createDeferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((nextResolve) => {
        resolve = nextResolve;
    });
    return { promise, resolve };
}

const replaceSpy = vi.hoisted(() => vi.fn());

vi.mock('expo-router', () => {
    const mock = createExpoRouterMock({
        router: {
            replace: (value) => {
                replaceSpy(value);
            },
        },
    });
    return mock.module as any;
});

const initialStorageState = getStorage().getState();

describe('useRequireFriendsEnabled', () => {
    beforeEach(async () => {
        replaceSpy.mockReset();

        resetServerFeaturesClientForTests();
        setServerReachabilityNetworkAllowed(true);
        await resetServerReachabilitySupervisors();

        getStorage().setState(initialStorageState, true);

        const profile = upsertServerProfile({ serverUrl: 'https://friends.test', name: 'Friends Test' });
        setActiveServerId(profile.id, { scope: 'device' });

        getStorage().getState().applySettingsLocal({
            experiments: true,
            featureToggles: { 'social.friends': true },
        });
    });

    it('does not redirect before the friends feature probe resolves enabled', async () => {
        const deferred = createDeferred<void>();

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

        const probe = getServerFeaturesSnapshot({ force: true });

        const { useRequireFriendsEnabled } = await import('./useRequireFriendsEnabled');
        const hook = await renderHook(() => useRequireFriendsEnabled());
        await flushHookEffects(1);

        expect(replaceSpy).not.toHaveBeenCalled();
        expect(hook.getCurrent()).toBe(false);

        await act(async () => {
            deferred.resolve(undefined);
            await probe;
            await flushHookEffects();
        });

        expect(replaceSpy).not.toHaveBeenCalled();
        expect(hook.getCurrent()).toBe(true);

        await act(async () => {
            await hook.unmount();
            await flushHookEffects(1);
        });
    });

    it('redirects home after the friends feature probe resolves disabled', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => ({
                ok: true,
                status: 200,
                json: async () => buildServerFeaturesResponse({ friendsEnabled: false }),
            })) as any,
        );

        await getServerFeaturesSnapshot({ force: true });

        const { useRequireFriendsEnabled } = await import('./useRequireFriendsEnabled');
        const hook = await renderHook(() => useRequireFriendsEnabled());
        await flushHookEffects();

        expect(replaceSpy).toHaveBeenCalledWith('/');

        await act(async () => {
            await hook.unmount();
            await flushHookEffects(1);
        });
    });
});
