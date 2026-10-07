import { afterEach, expect, it, vi } from 'vitest';

import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { abortServerFetches } from '@/sync/http/client';
import { resetServerProfilesRuntimeForTests } from '@/sync/domains/server/serverProfiles';
import { upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { resetServerReachabilitySupervisors } from '@/sync/runtime/connectivity/serverReachabilitySupervisorPool';
import {
    getCachedServerFeaturesSnapshot,
    getServerFeaturesSnapshot,
    resetServerFeaturesClientForTests,
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
    resetServerFeaturesClientForTests();
    resetServerProfilesRuntimeForTests();
    await resetServerReachabilitySupervisors();
    boundary.fetch.mockReset();
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
