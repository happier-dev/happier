import { afterEach, describe, expect, it, vi } from 'vitest';

const runtimeFetchSpy = vi.hoisted(() => vi.fn());

vi.mock('@/utils/system/runtimeFetch', () => ({
    runtimeFetch: (...args: unknown[]) => runtimeFetchSpy(...args),
    get runtimeFetchManualResponse() { return this.runtimeFetch; },
}));

import type { AuthCredentials } from '@/auth/storage/tokenStorage';

import { encodeBase64 } from '@/encryption/base64';
import { encodeUTF8 } from '@/encryption/text';

// Load the real graph before fake clocks and test deadlines. The canonical
// invalidation owner retires each case's cached/in-flight mode evidence.
const accountEncryptionMode = await import('./apiAccountEncryptionMode');

function buildTokenWithSub(sub: string): string {
    const payload = encodeBase64(encodeUTF8(JSON.stringify({ sub })), 'base64');
    return `hdr.${payload}.sig`;
}

describe('apiAccountEncryptionMode retry modes', () => {
    it('exposes the failed read while readiness keeps retrying and recovers without invalidation', async () => {
        vi.useFakeTimers();
        vi.spyOn(Math, 'random').mockReturnValue(0);
        const failure = new TypeError('Failed to fetch');
        const request = vi.fn().mockRejectedValueOnce(failure).mockRejectedValueOnce(failure)
            .mockResolvedValue(Response.json({ mode: 'plain', updatedAt: 1 }));
        const unavailable = vi.fn();
        const reading = accountEncryptionMode.readAccountEncryptionModeReadiness(
            () => accountEncryptionMode.fetchAccountEncryptionMode({ token: buildTokenWithSub('offline') }, {
                retry: 'none', request,
            }),
            () => true,
            unavailable,
        );
        await vi.advanceTimersByTimeAsync(0);
        expect(unavailable).toHaveBeenCalledWith({ status: 'unavailable', reason: failure, retrying: true });
        expect(request).toHaveBeenCalledTimes(1);
        await vi.runAllTimersAsync();
        await expect(reading).resolves.toEqual({ mode: 'plain', updatedAt: 1 });
        expect(unavailable).toHaveBeenCalledTimes(1);
        expect(request).toHaveBeenCalledTimes(3);
    });

    afterEach(async () => {
        accountEncryptionMode.invalidateAccountEncryptionModeCache();
        const { resetServerReachabilitySupervisors } = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
        await resetServerReachabilitySupervisors();
        const { stopAllEndpointSupervisorsForTests } = await import('@/sync/runtime/connectivity/endpointSupervisorPool');
        await stopAllEndpointSupervisorsForTests();
        runtimeFetchSpy.mockReset();
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('does not retry fetchAccountEncryptionMode when retry mode is none', async () => {
        vi.useFakeTimers();
        vi.spyOn(Math, 'random').mockReturnValue(0);

        const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
        await upsertAndActivateServer({ serverUrl: 'https://server.example.test', scope: 'device' });

        runtimeFetchSpy.mockImplementation(async (url: unknown) => {
            const href = String(url ?? '');
            if (href.endsWith('/health')) return new Response('{}', { status: 200 });
            if (href.includes('/v1/auth/ping')) return new Response('{}', { status: 200 });
            if (href.includes('/v1/account/encryption')) return new Response('nope', { status: 408 });
            throw new Error(`Unexpected runtimeFetch URL: ${href}`);
        });

        const { fetchAccountEncryptionMode } = await import('./apiAccountEncryptionMode');

        const credentials: AuthCredentials = {
            token: buildTokenWithSub('server-test'),
            secret: encodeBase64(new Uint8Array(32).fill(1), 'base64url'),
        };

        const promise = (
            fetchAccountEncryptionMode as unknown as (
                credentials: AuthCredentials,
                opts?: { retry?: string }
            ) => Promise<unknown>
        )(credentials, { retry: 'none' });

        const assertion = expect(promise).rejects.toThrow();
        await vi.runAllTimersAsync();
        await assertion;

        const encryptionCalls = runtimeFetchSpy.mock.calls.filter(([callUrl]) =>
            String(callUrl ?? '').includes('/v1/account/encryption'),
        );
        expect(encryptionCalls).toHaveLength(1);
    });

    it('recovers a shared Account-mode read after a sustained transient failure without a new invalidation', async () => {
        vi.useFakeTimers();
        vi.spyOn(Math, 'random').mockReturnValue(0);
        const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
        await upsertAndActivateServer({ serverUrl: 'https://mode-recovery.example.test', scope: 'tab' });
        let failuresRemaining = 9;
        runtimeFetchSpy.mockImplementation(async (url: unknown) => {
            const href = String(url ?? '');
            if (href.endsWith('/health') || href.includes('/v1/auth/ping')) return new Response('{}', { status: 200 });
            if (href.includes('/v1/account/encryption')) {
                if (failuresRemaining-- > 0) throw new TypeError('Failed to fetch');
                return Response.json({ mode: 'plain', updatedAt: 1 });
            }
            throw new Error(`Unexpected runtimeFetch URL: ${href}`);
        });
        const { fetchAccountEncryptionMode } = await import('./apiAccountEncryptionMode');
        const credentials: AuthCredentials = { token: buildTokenWithSub('mode-recovery') };
        const firstFailure = vi.fn();
        const secondFailure = vi.fn();
        const lateFailure = vi.fn();
        const first = fetchAccountEncryptionMode(credentials, { onUnavailable: firstFailure });
        const second = fetchAccountEncryptionMode(credentials, { onUnavailable: secondFailure });
        await vi.advanceTimersByTimeAsync(0);
        expect(firstFailure).toHaveBeenCalledWith(expect.objectContaining({ status: 'unavailable', retrying: true }));
        expect(secondFailure).toHaveBeenCalledWith(expect.objectContaining({ status: 'unavailable', retrying: true }));
        const late = fetchAccountEncryptionMode(credentials, { onUnavailable: lateFailure });
        expect(lateFailure).toHaveBeenCalledTimes(1);
        const settled = Promise.all([first, second, late]).then(value => ({ value }), error => ({ error }));
        await vi.runAllTimersAsync();
        expect(await settled).toEqual({ value: [
            { mode: 'plain', updatedAt: 1 }, { mode: 'plain', updatedAt: 1 }, { mode: 'plain', updatedAt: 1 },
        ] });
        expect(firstFailure).toHaveBeenCalledTimes(1);
        expect(secondFailure).toHaveBeenCalledTimes(1);
        expect(lateFailure).toHaveBeenCalledTimes(1);
        expect(runtimeFetchSpy.mock.calls.filter(([url]) => String(url).includes('/v1/account/encryption'))).toHaveLength(10);
    });

    it.each(['invalidation', 'Home replacement'] as const)('retires a pending mode retry on %s without sending credentials again', async (retirement) => {
        vi.useFakeTimers();
        vi.spyOn(Math, 'random').mockReturnValue(0);
        const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
        await upsertAndActivateServer({ serverUrl: 'https://retired-mode.example.test', scope: 'tab' });
        const { fetchAccountEncryptionMode, invalidateAccountEncryptionModeCache } = await import('./apiAccountEncryptionMode');
        const requests: string[] = [];
        runtimeFetchSpy.mockImplementation(async (url: unknown) => {
            const href = String(url ?? '');
            if (href.endsWith('/health') || href.includes('/v1/auth/ping')) return new Response('{}', { status: 200 });
            if (href.includes('/v1/account/encryption')) {
                requests.push(href);
                if (retirement === 'invalidation') invalidateAccountEncryptionModeCache();
                else await upsertAndActivateServer({ serverUrl: 'https://successor-mode.example.test', scope: 'tab' });
                throw new TypeError('Failed to fetch');
            }
            throw new Error(`Unexpected runtimeFetch URL: ${href}`);
        });
        const settled = fetchAccountEncryptionMode({ token: buildTokenWithSub('retired') })
            .then(value => ({ value }), error => ({ error }));
        await vi.runAllTimersAsync();
        expect(await settled).toMatchObject({ error: { code: 'account-encryption-mode-read-retired', canTryAgain: false } });
        expect(requests).toHaveLength(1);
    });

    it('does not retry a terminal authorization denial in shared mode', async () => {
        vi.useFakeTimers();
        const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
        await upsertAndActivateServer({ serverUrl: 'https://denied-mode.example.test', scope: 'tab' });
        let modeRequests = 0;
        runtimeFetchSpy.mockImplementation(async (url: unknown) => {
            const href = String(url ?? '');
            if (href.endsWith('/health') || href.includes('/v1/auth/ping')) return new Response('{}', { status: 200 });
            if (href.includes('/v1/account/encryption')) {
                modeRequests++;
                return Response.json({ error: 'denied' }, { status: 403 });
            }
            throw new Error(`Unexpected runtimeFetch URL: ${href}`);
        });
        const { fetchAccountEncryptionMode } = await import('./apiAccountEncryptionMode');
        const assertion = expect(fetchAccountEncryptionMode({ token: buildTokenWithSub('denied') }))
            .rejects.toMatchObject({ status: 403, code: 'forbidden' });
        await vi.runAllTimersAsync();
        await assertion;
        expect(modeRequests).toBe(1);
    });

    it.each(['schema', 'json'] as const)('settles a malformed HTTP 200 mode %s response as a typed refusal without retrying', async (failure) => {
        vi.useFakeTimers();
        const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
        await upsertAndActivateServer({ serverUrl: 'https://invalid-mode.example.test', scope: 'tab' });
        let modeRequests = 0;
        runtimeFetchSpy.mockImplementation(async (url: unknown) => {
            const href = String(url ?? '');
            if (href.endsWith('/health') || href.includes('/v1/auth/ping')) return Response.json({});
            if (href.endsWith('/v1/account/encryption')) {
                modeRequests += 1;
                // A subsequent terminal denial bounds the old retry loop. The
                // expected refusal must originate from the first invalid 200.
                if (modeRequests > 1) return Response.json({ error: 'denied' }, { status: 403 });
                return failure === 'json' ? new Response('invalid-json', { status: 200 })
                    : Response.json({ mode: 'plain' });
            }
            throw new Error(`Unexpected runtimeFetch URL: ${href}`);
        });
        const result = accountEncryptionMode.fetchAccountEncryptionMode({ token: buildTokenWithSub('invalid-mode') })
            .then(value => ({ value }), (error: unknown) => ({ error }));
        await vi.runAllTimersAsync();
        expect(await result).toMatchObject({ error: {
            status: 200, code: 'account-encryption-mode-unavailable', canTryAgain: false,
        } });
        expect(modeRequests).toBe(1);
    });
});
