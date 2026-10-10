import { afterEach, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { renderHook } from '@/dev/testkit';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { abortServerFetches } from '@/sync/http/client';
import { resetServerProfilesRuntimeForTests } from '@/sync/domains/server/serverProfiles';
import { upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { resetServerReachabilitySupervisors } from '@/sync/runtime/connectivity/serverReachabilitySupervisorPool';
import {
    useServerFeaturesMainSelectionSnapshot,
    useServerFeaturesRuntimeSnapshot,
    useServerFeaturesSnapshotForServerId,
} from '@/sync/domains/features/featureDecisionRuntime';
import {
    getCachedServerFeaturesSnapshot,
    getServerFeaturesSnapshot,
    resetServerFeaturesClientForTests,
    subscribeServerFeaturesSnapshot,
    getServerFeaturesSnapshotRetryDelayMs,
} from './serverFeaturesClient';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ Platform: { OS: 'ios' } });
});
const boundary = vi.hoisted(() => ({ fetch: vi.fn<(url: unknown, init?: RequestInit) => Promise<Response>>() }));
// Only the platform network adapter is replaced; profiles, HTTP cancellation and feature sharing stay real.
vi.mock('@/utils/system/runtimeFetch', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/utils/system/runtimeFetch')>(),
    runtimeFetch: boundary.fetch,
}));

afterEach(async () => {
    vi.useRealTimers();
    resetServerFeaturesClientForTests();
    resetServerProfilesRuntimeForTests();
    await resetServerReachabilitySupervisors();
    boundary.fetch.mockReset();
});

it.each(['runtime', 'explicit'] as const)('releases the %s observer retry when it unmounts after a failed first observation', async (scope) => {
    const home = await upsertAndActivateServer({ serverUrl: 'https://feature-retry-cleanup.example.test' });
    boundary.fetch.mockImplementation(async (url) => String(url).endsWith('/v1/features')
        ? new Response(null, { status: 503 })
        : Response.json({ ok: true }));
    vi.useFakeTimers();
    const useSnapshot = scope === 'runtime'
        ? useServerFeaturesRuntimeSnapshot
        : () => useServerFeaturesSnapshotForServerId(home.id);
    const hook = await renderHook(useSnapshot, { flushOptions: { cycles: 1, turns: 0 } });
    try {
        await act(async () => { await vi.advanceTimersByTimeAsync(0); });
        expect(hook.getCurrent()).toMatchObject({ status: 'error', reason: 'response_status', httpStatus: 503 });
        expect(vi.getTimerCount()).toBe(1);
    } finally {
        await hook.unmount();
    }
    expect(vi.getTimerCount()).toBe(0);
});

it('keeps the main-selection snapshot and render count stable across an identical retry', async () => {
    const home = await upsertAndActivateServer({ serverUrl: 'https://feature-retry-stability.example.test' });
    boundary.fetch.mockImplementation(async (url) => String(url).endsWith('/v1/features')
        ? new Response(null, { status: 503 })
        : Response.json({ ok: true }));
    await getServerFeaturesSnapshot({ serverId: home.id });
    vi.useFakeTimers();
    let renders = 0;
    const hook = await renderHook(() => {
        renders++;
        return useServerFeaturesMainSelectionSnapshot([home.id]);
    }, { flushOptions: { cycles: 1, turns: 0 } });
    try {
        await act(async () => { await vi.advanceTimersByTimeAsync(0); });
        const before = hook.getCurrent();
        const beforeRenders = renders;
        const beforeRequests = boundary.fetch.mock.calls.filter(([url]) => String(url).endsWith('/v1/features')).length;
        await act(async () => { await vi.advanceTimersByTimeAsync(30_001); });
        expect(boundary.fetch.mock.calls.filter(([url]) => String(url).endsWith('/v1/features'))).toHaveLength(beforeRequests + 1);
        expect(hook.getCurrent()).toBe(before);
        expect(renders).toBe(beforeRenders);
    } finally {
        await hook.unmount();
    }
});

it.each(['ready', 'unsupported', 'error'] as const)('retains an identical %s feature observation through a real refresh without notifying subscribers', async (status) => {
    const home = await upsertAndActivateServer({ serverUrl: 'https://feature-stability.example.test' });
    boundary.fetch.mockImplementation(async (url) => {
        if (!String(url).endsWith('/v1/features')) return Response.json({ ok: true });
        if (status === 'ready') return Response.json(createRootLayoutFeaturesResponse());
        return new Response(null, { status: status === 'unsupported' ? 404 : 503 });
    });
    const first = await getServerFeaturesSnapshot({ serverId: home.id });
    expect(first.status).toBe(status);
    let notifications = 0;
    const unsubscribe = subscribeServerFeaturesSnapshot(() => notifications++);
    try {
        const refreshed = await getServerFeaturesSnapshot({ serverId: home.id, force: true });
        expect(refreshed).toBe(first);
        expect(getCachedServerFeaturesSnapshot({ serverId: home.id })).toBe(first);
        expect(notifications).toBe(0);
        if (status === 'error') {
            expect(getServerFeaturesSnapshotRetryDelayMs({ serverId: home.id, snapshot: refreshed })).toBeGreaterThan(0);
        }
        boundary.fetch.mockImplementation(async (url) => String(url).endsWith('/v1/features')
            ? new Response(null, { status: status === 'unsupported' ? 503 : 404 })
            : Response.json({ ok: true }));
        const changed = await getServerFeaturesSnapshot({ serverId: home.id, force: true });
        expect(changed).not.toBe(first);
        expect(notifications).toBe(1);
    } finally {
        unsubscribe();
    }
});

it('recovers through three same-Home transport cancellations while a cancelled waiter leaves the shared observation alive', async () => {
    const origin = 'https://feature-recovery.example.test';
    await upsertAndActivateServer({ serverUrl: origin, name: 'Recovery Home' });
    const caller = new AbortController();
    const cancellation = new DOMException('Caller retired', 'AbortError');
    let switches = 0;
    boundary.fetch.mockImplementation(async (url, init) => {
        if (!String(url).endsWith('/v1/features')) return Response.json({ ok: true });
        if (switches < 3) {
            return await new Promise<Response>((_resolve, reject) => {
                init?.signal?.addEventListener('abort', () => reject(new DOMException('Transport retired', 'AbortError')), { once: true });
                queueMicrotask(() => {
                    switches += 1;
                    if (switches === 1) caller.abort(cancellation);
                    // The real connection owner calls this during same-Home Retry/restore.
                    abortServerFetches();
                });
            });
        }
        return Response.json(createRootLayoutFeaturesResponse());
    });
    const retired = getServerFeaturesSnapshot({ signal: caller.signal });
    const patient = getServerFeaturesSnapshot();
    expect(await retired).toEqual({ status: 'error', reason: 'network' });
    expect(await patient).toMatchObject({ status: 'ready' });
    expect(switches).toBe(3);
});

it('does not publish the successor Home into a retired focused-Home observation cache', async () => {
    const firstOrigin = 'https://feature-first.example.test';
    const successorOrigin = 'https://feature-successor.example.test';
    const first = await upsertAndActivateServer({ serverUrl: firstOrigin, name: 'First Home' });
    let retired = false;
    boundary.fetch.mockImplementation(async (url, init) => {
        if (!String(url).endsWith('/v1/features')) return Response.json({ ok: true });
        if (!retired) {
            retired = true;
            return await new Promise<Response>((_resolve, reject) => {
                init?.signal?.addEventListener('abort', () => reject(new DOMException('Transport retired', 'AbortError')), { once: true });
                void upsertAndActivateServer({ serverUrl: successorOrigin, name: 'Successor Home' }).then(() => abortServerFetches(), reject);
            });
        }
        return Response.json(createRootLayoutFeaturesResponse({ capabilities: {
            serverIdentity: { serverIdentityId: 'srv_successor' },
        } }));
    });
    const observation = await getServerFeaturesSnapshot({ serverId: first.id });
    expect(observation).toMatchObject({ status: 'error', reason: 'network' });
    expect(getCachedServerFeaturesSnapshot({ serverId: first.id })).toBeNull();
    expect(boundary.fetch.mock.calls.some(([url]) => String(url).startsWith(successorOrigin)
        && String(url).endsWith('/v1/features'))).toBe(false);
});
