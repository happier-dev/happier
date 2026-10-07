import * as React from 'react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { renderHook } from '@/dev/testkit/hooks/renderHook';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ params: {} }).module;
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
    await harness.reset();
    const { updateEffectiveHomeViewState } = await import('@/sync/domains/server/selection/homeViewSelectionState');
    await updateEffectiveHomeViewState(() => ({
        version: 1, groups: [], activeTargetKind: null, activeTargetId: null,
    }), { scope: 'device' });
});
afterEach(standardCleanup);
afterAll(() => vi.unstubAllEnvs());

async function addHomes() {
    const a = await harness.addHome({ name: 'A', serverUrl: 'https://a.example.test', accountId: 'account-a' });
    const b = await harness.addHome({ name: 'B', serverUrl: 'https://b.example.test', accountId: 'account-b' });
    return { a, b };
}

async function renderController() {
    const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
    const { useServerSettingsScreenController } = await import('./useServerSettingsScreenController');
    return renderHook(() => useServerSettingsScreenController(), {
        wrapper: ({ children }) => <InjectedAuthProvider credentials={null}>{children}</InjectedAuthProvider>,
    });
}

describe('useServerSettingsScreenController', () => {
    it('uses explicit active server target kind/id when present', async () => {
        const { a } = await addHomes();
        const { updateEffectiveHomeViewState } = await import('@/sync/domains/server/selection/homeViewSelectionState');
        await updateEffectiveHomeViewState(() => ({
            version: 1,
            groups: [{ id: 'grp-one', name: 'Group One', serverIds: [a], presentation: 'grouped' }],
            activeTargetKind: 'group', activeTargetId: 'grp-one',
        }), { scope: 'device' });
        const hook = await renderController();
        expect(hook.getCurrent().activeTargetKey).toBe('group:grp-one');
    });

    it('keeps an explicit All Homes selection rather than treating it as a stale group', async () => {
        const { a, b } = await addHomes();
        const { readUsableHomeServerIds } = await import('@/sync/domains/scope/usableHomeServerIds');
        await waitForHomeGovernance(() => expect(readUsableHomeServerIds()).toEqual([a, b].sort()));
        const { updateEffectiveHomeViewState, loadEffectiveHomeViewState } = await import('@/sync/domains/server/selection/homeViewSelectionState');
        await updateEffectiveHomeViewState(() => ({
            version: 1, groups: [], activeTargetKind: 'group', activeTargetId: '@all-homes',
        }), { scope: 'device' });
        const hook = await renderController();
        expect(hook.getCurrent().activeTargetKey).toBe('group:@all-homes');
        expect(loadEffectiveHomeViewState()).toMatchObject({
            activeTargetKind: 'group', activeTargetId: '@all-homes',
        });
    });

    it('keeps a valid explicit Home target when another Home is focused', async () => {
        const { a, b } = await addHomes();
        const { updateEffectiveHomeViewState } = await import('@/sync/domains/server/selection/homeViewSelectionState');
        const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
        await updateEffectiveHomeViewState(() => ({
            version: 1, groups: [], activeTargetKind: 'server', activeTargetId: a,
        }), { scope: 'device' });
        const hook = await renderController();
        expect(hook.getCurrent().activeTargetKey).toBe(`server:${a}`);
        expect(getActiveServerSnapshot().serverId).toBe(b);
    });
});
