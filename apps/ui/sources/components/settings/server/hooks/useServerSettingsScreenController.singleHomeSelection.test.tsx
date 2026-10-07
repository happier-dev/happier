import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { renderHook } from '@/dev/testkit/hooks/renderHook';

const routerReplace = vi.hoisted(() => vi.fn());
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ router: { replace: routerReplace }, params: {} }).module;
});
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
installDisconnectedServerSocketBoundary();
beforeAll(async () => {
    vi.stubEnv('EXPO_PUBLIC_SYSTEM_TASKS_RUNNER_MODE', 'unavailable');
    await loadSyncSingletonForTests();
});
beforeEach(async () => {
    routerReplace.mockClear();
    await harness.reset();
});
afterEach(standardCleanup);
afterAll(() => vi.unstubAllEnvs());

describe('useServerSettingsScreenController single-Home selection', () => {
    it('selecting a Home leaves group mode through the canonical HomeView owner and keeps its page open', async () => {
        const a = await harness.addHome({ name: 'A', serverUrl: 'https://a.example.test', accountId: null });
        const b = await harness.addHome({ name: 'B', serverUrl: 'https://b.example.test', accountId: null });
        const { updateEffectiveHomeViewState, loadEffectiveHomeViewState } = await import('@/sync/domains/server/selection/homeViewSelectionState');
        await updateEffectiveHomeViewState(() => ({
            version: 1,
            groups: [{ id: 'grp-ab', name: 'A+B', serverIds: [a, b], presentation: 'grouped' }],
            activeTargetKind: 'group', activeTargetId: 'grp-ab',
        }), { scope: 'device' });

        const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
        const { useServerSettingsScreenController } = await import('./useServerSettingsScreenController');
        const { getServerProfileById } = await import('@/sync/domains/server/serverProfiles');
        const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
        const profile = getServerProfileById(a);
        if (!profile) throw new Error('Expected saved Home A');
        const hook = await renderHook(() => useServerSettingsScreenController(), {
            wrapper: ({ children }) => <InjectedAuthProvider credentials={null}>{children}</InjectedAuthProvider>,
        });

        await act(async () => { await hook.getCurrent().onSwitchServer(profile); });

        expect(loadEffectiveHomeViewState()).toMatchObject({
            activeTargetKind: 'server', activeTargetId: a,
            groups: [{ id: 'grp-ab', serverIds: [a, b] }],
        });
        expect(getActiveServerSnapshot().serverId).toBe(a);
        expect(hook.getCurrent().activeTargetKey).toBe(`server:${a}`);
        expect(routerReplace).not.toHaveBeenCalled();
    });
});
