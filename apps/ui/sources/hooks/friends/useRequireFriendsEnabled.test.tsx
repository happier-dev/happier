import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDeferred, renderHook, standardCleanup } from '@/dev/testkit';
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

const replaceSpy = vi.hoisted(() => vi.fn());

vi.mock('expo-router', () => {
    const mock = createExpoRouterMock({
        router: {
            replace: (value) => {
                replaceSpy(value);
            },
        },
    });
    return mock.module;
});

const initialStorageState = getStorage().getState();

describe('useRequireFriendsEnabled', () => {
    afterEach(async () => {
        await standardCleanup();
        resetServerFeaturesClientForTests();
        await resetServerReachabilitySupervisors();
        vi.unstubAllGlobals();
    });
    beforeEach(async () => {
        replaceSpy.mockReset();

        resetServerFeaturesClientForTests();
        setServerReachabilityNetworkAllowed(true);
        await resetServerReachabilitySupervisors();

        getStorage().setState(initialStorageState, true);

        const profile = await upsertServerProfile({ serverUrl: 'https://friends.test', name: 'Friends Test' });
        await setActiveServerId(profile.id, { scope: 'device' });

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
                return Response.json(buildServerFeaturesResponse({ friendsEnabled: true }));
            }),
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
            vi.fn(async () => Response.json(buildServerFeaturesResponse({ friendsEnabled: false }))),
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
