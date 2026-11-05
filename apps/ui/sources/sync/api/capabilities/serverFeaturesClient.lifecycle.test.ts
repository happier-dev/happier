import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { MMKV } from 'react-native-mmkv';

import { renderHook } from '@/dev/testkit';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { abortServerFetches } from '@/sync/http/client';
import { resetServerProfilesRuntimeForTests, upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
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

// Load the real Settings/Services graph after network installation, outside a timed hook body.
const { useLocalServicePresentationFeatures } = await import('@/components/sessions/localServices/useLocalServicePublicPreviewFeature');

afterEach(async () => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    resetServerFeaturesClientForTests();
    resetServerProfilesRuntimeForTests();
    await resetServerReachabilitySupervisors();
    boundary.fetch.mockReset();
});

it('settles feature selection when persisting the observed Home identity fails', async () => {
    const home = await upsertAndActivateServer({ serverUrl: 'https://feature-storage-failure.example.test' });
    boundary.fetch.mockImplementation(async (url) => String(url).endsWith('/v1/features')
        ? Response.json(createRootLayoutFeaturesResponse({ capabilities: {
            serverIdentity: { serverIdentityId: 'srv_feature_storage_failure' },
        } }))
        : Response.json({ ok: true }));
    // Disk persistence is the failing system boundary; identity adoption, HTTP and hooks stay real.
    vi.spyOn(MMKV.prototype, 'set').mockImplementationOnce(() => {
        throw new Error('Device storage unavailable');
    });
    vi.useFakeTimers();
    const hook = await renderHook(() => useServerFeaturesMainSelectionSnapshot([home.id]), {
        flushOptions: { cycles: 1, turns: 0 },
    });
    try {
        await act(async () => { await vi.advanceTimersByTimeAsync(0); });
        expect(hook.getCurrent()).toMatchObject({
            status: 'ready',
            snapshotsByServerId: { [home.id]: { status: 'error', reason: 'network' } },
        });
    } finally {
        await hook.unmount();
    }
});

it.each(['runtime', 'explicit', 'selection'] as const)('retires a pending %s observation only after its final hook unmounts', async (scope) => {
    const home = await upsertAndActivateServer({ serverUrl: 'https://feature-pending-cleanup.example.test' });
    const requestSignals: AbortSignal[] = [];
    boundary.fetch.mockImplementation(async (url, init) => {
        if (!String(url).endsWith('/v1/features')) return Response.json({ ok: true });
        if (init?.signal) requestSignals.push(init.signal);
        return await new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true });
        });
    });
    const useSnapshot = () => {
        if (scope === 'runtime') return useServerFeaturesRuntimeSnapshot();
        if (scope === 'explicit') return useServerFeaturesSnapshotForServerId(home.id);
        return useServerFeaturesMainSelectionSnapshot([home.id]);
    };
    const first = await renderHook(useSnapshot);
    const remaining = await renderHook(useSnapshot);
    try {
        expect(requestSignals).toHaveLength(1);
        await first.unmount();
        expect(requestSignals[0]?.aborted).toBe(false);
        await remaining.unmount();
        expect(requestSignals[0]?.aborted).toBe(true);
        boundary.fetch.mockResolvedValue(new Response(null, { status: 404 }));
        await expect(getServerFeaturesSnapshot({ serverId: home.id, force: true })).resolves.toEqual({
            status: 'unsupported', reason: 'endpoint_missing',
        });
    } finally {
        await first.unmount();
        await remaining.unmount();
    }
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

it('limits foreign-Home Services feature reads and retries to presented demand', async () => {
    await upsertAndActivateServer({ serverUrl: 'https://feature-services-focused.example.test' });
    const home = await upsertServerProfile({ serverUrl: 'https://feature-services-foreign.example.test' });
    await upsertServerProfile({ serverUrl: 'https://feature-services-unrelated.example.test' });
    let recovered = false;
    boundary.fetch.mockImplementation(async (url) => String(url).endsWith('/v1/features')
        ? recovered ? Response.json(createRootLayoutFeaturesResponse()) : new Response(null, { status: 503 })
        : Response.json({ ok: true }));
    vi.useFakeTimers();
    let presented = false;
    const hook = await renderHook(() => useLocalServicePresentationFeatures(home.id), {
        wrapper: ({ children }) => React.createElement(PluginSurfaceFocusEligibilityProvider,
            { active: presented, presentationActive: presented, children }),
        flushOptions: { cycles: 1, turns: 0 },
    });
    const featureRequests = () => boundary.fetch.mock.calls.filter(([url]) => String(url).endsWith('/v1/features'));
    try {
        await act(async () => { await vi.advanceTimersByTimeAsync(341_240); });
        expect(featureRequests()).toHaveLength(0);
        presented = true;
        await hook.rerender();
        await act(async () => { await vi.advanceTimersByTimeAsync(0); });
        expect(featureRequests()).toHaveLength(1);
        expect(getCachedServerFeaturesSnapshot({ serverId: home.id })).toMatchObject({ status: 'error', httpStatus: 503 });
        await act(async () => { await vi.advanceTimersByTimeAsync(30_001); });
        expect(featureRequests()).toHaveLength(2);
        presented = false;
        await hook.rerender();
        const closedRequests = featureRequests().length;
        await act(async () => { await vi.advanceTimersByTimeAsync(341_240); });
        expect(featureRequests()).toHaveLength(closedRequests);
        recovered = true;
        presented = true;
        await hook.rerender();
        await act(async () => { await vi.advanceTimersByTimeAsync(0); });
        expect(featureRequests()).toHaveLength(closedRequests + 1);
        expect(getCachedServerFeaturesSnapshot({ serverId: home.id })).toMatchObject({ status: 'ready' });
        expect(featureRequests().every(([url]) => String(url).startsWith(home.serverUrl))).toBe(true);
    } finally {
        await hook.unmount();
    }
    const releasedRequests = featureRequests().length;
    await act(async () => { await vi.advanceTimersByTimeAsync(341_240); });
    expect(featureRequests()).toHaveLength(releasedRequests);
});

it('keeps a visible foreign-Home feature consumer alive when retained Services hides', async () => {
    await upsertAndActivateServer({ serverUrl: 'https://feature-peer-focused.example.test' });
    const home = await upsertServerProfile({ serverUrl: 'https://feature-peer-foreign.example.test' });
    let complete: ((response: Response) => void) | undefined;
    let requestSignal: AbortSignal | null | undefined;
    boundary.fetch.mockImplementation(async (url, init) => {
        if (!String(url).endsWith('/v1/features')) return Response.json({ ok: true });
        requestSignal = init?.signal;
        return await new Promise<Response>((resolve, reject) => {
            complete = resolve;
            init?.signal?.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true });
        });
    });
    const peer = await renderHook(() => useServerFeaturesSnapshotForServerId(home.id));
    let presented = true;
    const services = await renderHook(() => useLocalServicePresentationFeatures(home.id), {
        wrapper: ({ children }) => React.createElement(PluginSurfaceFocusEligibilityProvider,
            { active: presented, presentationActive: presented, children }),
    });
    try {
        expect(boundary.fetch.mock.calls.filter(([url]) => String(url).endsWith('/v1/features'))).toHaveLength(1);
        presented = false;
        await services.rerender();
        expect(requestSignal?.aborted).toBe(false);
        await act(async () => {
            complete?.(Response.json(createRootLayoutFeaturesResponse()));
            // Response headers precede body consumption/publication in the real HTTP owner.
            await getServerFeaturesSnapshot({ serverId: home.id });
        });
        expect(peer.getCurrent()).toMatchObject({ status: 'ready' });
        presented = true;
        await services.rerender();
        expect(boundary.fetch.mock.calls.filter(([url]) => String(url).endsWith('/v1/features'))).toHaveLength(1);
    } finally {
        await services.unmount();
        await peer.unmount();
    }
});

it('projects the exact canonical Services cache on the first reopen and Home-switch commits', async () => {
    await upsertAndActivateServer({ serverUrl: 'https://feature-cache-focused.example.test' });
    const home = await upsertServerProfile({ serverUrl: 'https://feature-cache-foreign.example.test' });
    const other = await upsertServerProfile({ serverUrl: 'https://feature-cache-other.example.test' });
    let revision = 'first';
    boundary.fetch.mockImplementation(async (url) => {
        if (!String(url).endsWith('/v1/features')) return Response.json({ ok: true });
        const payload = createRootLayoutFeaturesResponse();
        const reason = String(url).startsWith(other.serverUrl) ? 'other_home_policy' : revision;
        return Response.json({ ...payload, capabilities: { ...payload.capabilities,
            localServices: { ...payload.capabilities.localServices,
                publicPreview: { ...payload.capabilities.localServices.publicPreview, disabledReasons: [reason] },
            },
        } });
    });
    vi.useFakeTimers();
    let presented = true;
    let serverId = home.id;
    const committedReasons: Array<readonly string[]> = [];
    const hook = await renderHook(() => {
        const value = useLocalServicePresentationFeatures(serverId);
        React.useLayoutEffect(() => { committedReasons.push([...value.publicPreviewCapabilityDisabledReasons.publicPreview]); });
        return value;
    }, {
        wrapper: ({ children }) => React.createElement(PluginSurfaceFocusEligibilityProvider,
            { active: presented, presentationActive: presented, children }),
        flushOptions: { cycles: 1, turns: 0 },
    });
    const featureRequests = () => boundary.fetch.mock.calls.filter(([url]) => String(url).endsWith('/v1/features'));
    try {
        await act(async () => { await vi.advanceTimersByTimeAsync(0); });
        expect(hook.getCurrent().publicPreviewCapabilityDisabledReasons.publicPreview).toEqual(['first']);
        presented = false;
        await hook.rerender();
        await act(async () => { await vi.advanceTimersByTimeAsync(600_001); });
        expect(featureRequests()).toHaveLength(1);
        revision = 'refreshed';
        committedReasons.length = 0;
        presented = true;
        await hook.rerender();
        expect(committedReasons[0]).toEqual(['first']);
        await act(async () => { await vi.advanceTimersByTimeAsync(0); });
        expect(featureRequests()).toHaveLength(2);
        expect(hook.getCurrent().publicPreviewCapabilityDisabledReasons.publicPreview).toEqual(['refreshed']);
        committedReasons.length = 0;
        serverId = other.id;
        await hook.rerender();
        expect(committedReasons[0]).toEqual([]);
        await act(async () => { await vi.advanceTimersByTimeAsync(0); });
        expect(hook.getCurrent().publicPreviewCapabilityDisabledReasons.publicPreview).toEqual(['other_home_policy']);
        expect(featureRequests()).toHaveLength(3);
    } finally {
        await hook.unmount();
    }
});
