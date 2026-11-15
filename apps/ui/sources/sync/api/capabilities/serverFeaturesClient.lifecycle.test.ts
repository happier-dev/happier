import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { MMKV } from 'react-native-mmkv';

import { createDeferred, installTimerCensus, renderHook } from '@/dev/testkit';
import { PLUGIN_DATA_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION } from '@happier-dev/protocol/clientCompatibility/accountStoredContentCompatibilityV1';
import { resolveAccountStoredContentCompatibilityHeaders } from '@/sync/http/accountStoredContentCompatibility';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { abortServerFetches } from '@/sync/http/client';
import { adoptHomeProfile, getServerProfileById, resetServerProfilesRuntimeForTests, upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { resetServerReachabilitySupervisors } from '@/sync/runtime/connectivity/serverReachabilitySupervisorPool';
import {
    useServerFeaturesMainSelectionSnapshot,
    useServerFeaturesRuntimeSnapshot,
    useServerFeaturesSnapshotForServerId,
} from '@/sync/domains/features/featureDecisionRuntime';
import {
    expireServerFeaturesSnapshotForReconnect,
    getCachedServerFeaturesSnapshot,
    getServerFeaturesSnapshot,
    resetServerFeaturesClientForTests,
    refreshAuthenticatedServerFeaturesSnapshot,
    subscribeServerFeaturesSnapshot,
    getServerFeaturesSnapshotRetryDelayMs,
    probeServerFeaturesAtUrl,
    primeServerFeaturesSnapshot,
} from './serverFeaturesClient';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ Platform: { OS: 'ios' } });
});
const boundary = vi.hoisted(() => ({ fetch: vi.fn<(url: unknown, init?: RequestInit) => Promise<Response>>() }));
// Only the platform network adapter is replaced; profiles, HTTP cancellation and feature sharing stay real.
vi.mock('@/utils/system/runtimeFetch', async (importOriginal) => {
    // Named first so the getter's `this` is this object, not vi.mock's Partial<unknown> factory type.
    const mocked = {
    ...await importOriginal<typeof import('@/utils/system/runtimeFetch')>(),
    runtimeFetch: boundary.fetch,
    get runtimeFetchManualResponse(): typeof import('@/utils/system/runtimeFetch').runtimeFetchManualResponse { return this.runtimeFetch; },
};
    return mocked;
});

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

it.each(['public', 'authenticated fallback'] as const)('uses the admitted address for explicit saved Home %s readiness', async (projection) => {
    await upsertAndActivateServer({ serverUrl: 'http://offline-active-home.example.test' });
    const serverIdentityId = `srv_explicit_entered_${projection === 'public' ? 'public' : 'fallback'}`;
    const canonicalServerUrl = `http://canonical-unreachable-${projection === 'public' ? 'public' : 'fallback'}.localhost:3035`;
    const enteredUrl = projection === 'public' ? 'http://192.0.2.55:3035' : 'http://192.0.2.56:3035';
    const home = await adoptHomeProfile({
        source: 'manual',
        descriptor: { serverUrl: canonicalServerUrl, canonicalServerUrl, homeServerIdentityId: serverIdentityId },
        addressSelection: { serverIdentityId, enteredUrl, canonicalServerUrl, useCanonical: false },
    });
    const caller = new AbortController();
    const firstRequest = createDeferred<string>();
    const requestUrls: string[] = [];
    boundary.fetch.mockImplementation(async (input, init) => {
        const url = String(input);
        requestUrls.push(url);
        firstRequest.resolve(url);
        // A native device cannot route the announced canonical hostname. Keep
        // that OS/network boundary pending until the observer cancels it.
        if (new URL(url).origin !== enteredUrl) {
            return await new Promise<Response>((_resolve, reject) => {
                init?.signal?.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true });
            });
        }
        if (url.endsWith('/v1/features/authenticated')) return new Response(null, { status: 404 });
        return Response.json(url.endsWith('/v1/features')
            ? createRootLayoutFeaturesResponse({ capabilities: { serverIdentity: { serverIdentityId } } })
            : { ok: true });
    });
    const observation = projection === 'public'
        ? getServerFeaturesSnapshot({ serverId: home.id, signal: caller.signal })
        : refreshAuthenticatedServerFeaturesSnapshot({ serverId: home.id, credentials: { token: 'synthetic-home-token' }, signal: caller.signal });
    try {
        expect(new URL(await firstRequest.promise).origin).toBe(enteredUrl);
        await expect(observation).resolves.toMatchObject({ status: 'ready', serverIdentityId });
        expect(requestUrls.map(url => new URL(url).origin)).toEqual(requestUrls.map(() => enteredUrl));
        expect(requestUrls).toContain(`${enteredUrl}/v1/features`);
        if (projection === 'authenticated fallback') expect(requestUrls).toContain(`${enteredUrl}/v1/features/authenticated`);
    } finally {
        caller.abort();
        await observation;
    }
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

it.each((['runtime', 'explicit', 'selection'] as const).flatMap(scope =>
    (['permission', 'identity'] as const).map(reason => [scope, reason] as const),
))('does no settled %s retry work for a conclusive %s refusal and consumes a published recovery', async (scope, reason) => {
    const serverUrl = `https://feature-refused-${scope}-${reason}.example.test`;
    if (reason === 'identity') {
        await adoptHomeProfile({ source: 'manual', descriptor: {
            serverUrl, canonicalServerUrl: serverUrl, homeServerIdentityId: `srv_pinned_${scope}`,
        } });
    }
    const home = await upsertAndActivateServer({ serverUrl });
    boundary.fetch.mockImplementation(async url => String(url).endsWith('/v1/features')
        ? reason === 'permission' ? new Response(null, { status: 403 })
            : Response.json(createRootLayoutFeaturesResponse({ capabilities: {
                serverIdentity: { serverIdentityId: `srv_different_${scope}` },
            } }))
        : Response.json({ ok: true }));
    vi.useFakeTimers();
    const census = installTimerCensus();
    const selectedIds = [home.id];
    const hook = await renderHook(() => scope === 'runtime'
        ? useServerFeaturesRuntimeSnapshot()
        : scope === 'explicit'
            ? useServerFeaturesSnapshotForServerId(home.id)
            : useServerFeaturesMainSelectionSnapshot(selectedIds), { flushOptions: { cycles: 1, turns: 0 } });
    const snapshot = () => {
        const current = hook.getCurrent();
        return 'snapshotsByServerId' in current ? current.snapshotsByServerId[home.id] : current;
    };
    try {
        await act(async () => { await vi.advanceTimersByTimeAsync(0); });
        expect(snapshot()).toMatchObject(reason === 'permission'
            ? { status: 'error', reason: 'response_status', httpStatus: 403 }
            : { status: 'error', reason: 'identity_conflict' });
        boundary.fetch.mockClear();
        await act(async () => { await vi.advanceTimersByTimeAsync(180_000); });
        expect(census.readFires()).toEqual({ timeout: 0, interval: 0 });
        expect(boundary.fetch).not.toHaveBeenCalled();
        // No pending callback remains after the settled window either.
        expect(census.read()).toEqual([]);
        expect(vi.getTimerCount()).toBe(0);

        // Explicit recovery demand completes through the real network/cache owner;
        // its publication, not another hook poll, updates every consumer.
        boundary.fetch.mockImplementation(async url => Response.json(String(url).endsWith('/v1/features')
            ? createRootLayoutFeaturesResponse(reason === 'identity' ? { capabilities: {
                serverIdentity: { serverIdentityId: `srv_pinned_${scope}` },
            } } : undefined)
            : { ok: true }));
        await act(async () => {
            await getServerFeaturesSnapshot({ serverId: home.id, force: true });
        });
        expect(snapshot()).toMatchObject({ status: 'ready' });
        expect(boundary.fetch.mock.calls.filter(([url]) => String(url).endsWith('/v1/features'))).toHaveLength(1);
    } finally {
        await hook.unmount();
        census.stop();
    }
});

it.each(['runtime', 'explicit', 'selection'] as const)('does no settled %s retry work after the owner publishes recovery', async (scope) => {
    const home = await upsertAndActivateServer({ serverUrl: `https://feature-published-recovery-${scope}.example.test` });
    boundary.fetch.mockImplementation(async url => String(url).endsWith('/v1/features')
        ? new Response(null, { status: 503 })
        : Response.json({ ok: true }));
    vi.useFakeTimers();
    const census = installTimerCensus();
    const selectedIds = [home.id];
    const hook = await renderHook(() => scope === 'runtime'
        ? useServerFeaturesRuntimeSnapshot()
        : scope === 'explicit'
            ? useServerFeaturesSnapshotForServerId(home.id)
            : useServerFeaturesMainSelectionSnapshot(selectedIds), { flushOptions: { cycles: 1, turns: 0 } });
    try {
        await act(async () => { await vi.advanceTimersByTimeAsync(0); });
        expect(vi.getTimerCount()).toBe(1);
        boundary.fetch.mockImplementation(async url => Response.json(String(url).endsWith('/v1/features')
            ? createRootLayoutFeaturesResponse() : { ok: true }));
        await act(async () => {
            await getServerFeaturesSnapshot({ serverId: home.id, force: true });
        });
        const current = hook.getCurrent();
        expect('snapshotsByServerId' in current ? current.snapshotsByServerId[home.id] : current)
            .toMatchObject({ status: 'ready' });
        boundary.fetch.mockClear();
        await act(async () => { await vi.advanceTimersByTimeAsync(180_000); });
        expect(census.readFires()).toEqual({ timeout: 0, interval: 0 });
        expect(boundary.fetch).not.toHaveBeenCalled();
        expect(census.read()).toEqual([]);
        expect(vi.getTimerCount()).toBe(0);
    } finally {
        await hook.unmount();
        census.stop();
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

it.each(['focused', 'endpoint'] as const)('keeps accepted stored-content requirements during a %s refresh, then applies conclusive incompatibility', async (projection) => {
    const home = await upsertAndActivateServer({ serverUrl: `https://requirements-${projection}.example.test` });
    const payload = (currentProtocolVersion: number) => createRootLayoutFeaturesResponse({ capabilities: {
        accountStoredContentCompatibility: { v: 1, minimumProtocolVersion: 2, currentProtocolVersion,
            declarationTransport: 'http-header-and-socket-auth-v1' },
    } });
    const observe = (signal?: AbortSignal) => projection === 'focused'
        ? getServerFeaturesSnapshot({ serverId: home.id, force: true, signal })
        : probeServerFeaturesAtUrl(home.serverUrl, { force: true, signal });
    const compatibility = () => resolveAccountStoredContentCompatibilityHeaders(undefined, {
        serverUrl: home.serverUrl, declaration: PLUGIN_DATA_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION,
    });
    boundary.fetch.mockImplementation(async url => Response.json(String(url).endsWith('/v1/features') ? payload(3) : { ok: true }));
    expect((await observe()).status).toBe('ready');
    expect(compatibility().status).toBe('available');

    const refreshReceived = createDeferred<void>();
    const response = createDeferred<Response>();
    boundary.fetch.mockImplementation(async url => {
        if (!String(url).endsWith('/v1/features')) return Response.json({ ok: true });
        refreshReceived.resolve();
        return await response.promise;
    });
    const refreshing = observe();
    try {
        await refreshReceived.promise;
        expect(compatibility().status).toBe('available');
    } finally {
        response.resolve(new Response(null, { status: 503 }));
        await refreshing;
    }
    expect(compatibility().status).toBe('available');

    const cancellationReceived = createDeferred<void>();
    boundary.fetch.mockImplementation(async (url, init) => {
        if (!String(url).endsWith('/v1/features')) return Response.json({ ok: true });
        cancellationReceived.resolve();
        return await new Promise<Response>((_resolve, reject) => {
            const abort = () => reject(new DOMException('Cancelled', 'AbortError'));
            init?.signal?.addEventListener('abort', abort, { once: true });
            if (init?.signal?.aborted) abort();
        });
    });
    const caller = new AbortController();
    const cancelled = observe(caller.signal);
    try {
        await cancellationReceived.promise;
    } finally {
        caller.abort();
        await cancelled;
    }
    expect(compatibility().status).toBe('available');

    boundary.fetch.mockImplementation(async url => Response.json(String(url).endsWith('/v1/features') ? payload(2) : { ok: true }));
    expect((await observe()).status).toBe('ready');
    expect(compatibility()).toEqual({ status: 'unavailable', reason: 'server-protocol-too-old' });
    boundary.fetch.mockImplementation(async url => String(url).endsWith('/v1/features')
        ? new Response(null, { status: 404 }) : Response.json({ ok: true }));
    expect((await observe()).status).toBe('unsupported');
    expect(compatibility()).toEqual({ status: 'unavailable', reason: 'server-requirements-unavailable' });
    expect(resolveAccountStoredContentCompatibilityHeaders(undefined, {
        serverUrl: 'https://unobserved-requirements.example.test',
        declaration: PLUGIN_DATA_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION,
    })).toEqual({ status: 'unavailable', reason: 'server-requirements-unavailable' });
});

it.each(['incompatible', 'unsupported'] as const)('keeps a conclusive %s observation bound to its request URL across profile adoption', async (completion) => {
    await upsertAndActivateServer({ serverUrl: 'https://requirements-focused-home.example.test' });
    const observedUrl = `https://requirements-observed-${completion}.example.test`;
    const adoptedUrl = `https://requirements-adopted-${completion}.example.test`;
    const identity = `srv_requirements_${completion}`;
    const profile = await adoptHomeProfile({ source: 'manual', descriptor: {
        serverUrl: observedUrl, canonicalServerUrl: observedUrl, homeServerIdentityId: identity,
    } });
    const payload = (currentProtocolVersion: number) => createRootLayoutFeaturesResponse({ capabilities: {
        serverIdentity: { serverIdentityId: null },
        accountStoredContentCompatibility: { v: 1, minimumProtocolVersion: 2, currentProtocolVersion,
            declarationTransport: 'http-header-and-socket-auth-v1' },
    } });
    const compatibility = (serverUrl: string) => resolveAccountStoredContentCompatibilityHeaders(undefined, {
        serverUrl, declaration: PLUGIN_DATA_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION,
    });
    boundary.fetch.mockImplementation(async url => Response.json(String(url).endsWith('/v1/features') ? payload(3) : { ok: true }));
    expect((await getServerFeaturesSnapshot({ serverId: profile.id, force: true })).status).toBe('ready');
    expect((await probeServerFeaturesAtUrl(adoptedUrl)).status).toBe('ready');
    expect(compatibility(observedUrl).status).toBe('available');
    expect(compatibility(adoptedUrl).status).toBe('available');

    const received = createDeferred<void>();
    const response = createDeferred<Response>();
    boundary.fetch.mockImplementation(async url => {
        if (String(url) !== `${observedUrl}/v1/features`) return Response.json({ ok: true });
        received.resolve();
        return await response.promise;
    });
    const observation = getServerFeaturesSnapshot({ serverId: profile.id, force: true });
    try {
        await received.promise;
        const adopted = await adoptHomeProfile({ source: 'manual', descriptor: {
            serverUrl: adoptedUrl, canonicalServerUrl: adoptedUrl, homeServerIdentityId: identity,
        } });
        expect(adopted.id).toBe(profile.id);
        expect(getServerProfileById(profile.id)?.serverUrl).toBe(adoptedUrl);
    } finally {
        response.resolve(completion === 'incompatible' ? Response.json(payload(2)) : new Response(null, { status: 404 }));
        await observation;
    }
    expect.soft(compatibility(observedUrl)).toEqual({ status: 'unavailable', reason: completion === 'incompatible'
        ? 'server-protocol-too-old' : 'server-requirements-unavailable' });
    expect.soft(compatibility(adoptedUrl).status).toBe('available');
});

it.each([{ captured: 3, live: 2 }, { captured: 2, live: 3 }])('does not replace live stored-content requirements when priming an older feature snapshot: %j', async ({ captured, live }) => {
    const home = await upsertAndActivateServer({ serverUrl: `https://requirements-prime-${live}.example.test` });
    let protocolVersion = captured;
    boundary.fetch.mockImplementation(async url => Response.json(String(url).endsWith('/v1/features')
        ? createRootLayoutFeaturesResponse({ capabilities: {
            accountStoredContentCompatibility: { v: 1, minimumProtocolVersion: 2, currentProtocolVersion: protocolVersion,
                declarationTransport: 'http-header-and-socket-auth-v1' },
        } }) : { ok: true }));
    const earlier = await getServerFeaturesSnapshot({ serverId: home.id, force: true });
    expect(earlier.status).toBe('ready');
    protocolVersion = live;
    expect((await getServerFeaturesSnapshot({ serverId: home.id, force: true })).status).toBe('ready');
    primeServerFeaturesSnapshot({ serverId: home.id, snapshot: earlier });
    // Demo/embedding presentation restoration is not a fresh server observation.
    // It cannot replace the later operation's actual protocol evidence.
    const compatibility = resolveAccountStoredContentCompatibilityHeaders(undefined, {
        serverUrl: home.serverUrl, declaration: PLUGIN_DATA_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION,
    });
    if (live === 3) expect(compatibility.status).toBe('available');
    else expect(compatibility).toEqual({ status: 'unavailable', reason: 'server-protocol-too-old' });
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
        // A ready answer holds for the connection; the Home's reconnect expires it.
        expireServerFeaturesSnapshotForReconnect({ serverId: home.id });
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
