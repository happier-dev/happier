import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { HappyError } from '@/utils/errors/errors';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { resetServerReachabilitySupervisors } from '@/sync/runtime/connectivity/serverReachabilitySupervisorPool';
import { getFriendsList, sendFriendRequest } from './apiFriends';

afterEach(async () => {
    await resetServerReachabilitySupervisors();
    resetRuntimeFetch();
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

const credentials: AuthCredentials = { token: 't', secret: 's' };

function mockError(status: number, payload: unknown) {
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/health') || url.endsWith('/v1/auth/ping')) {
            return Response.json({});
        }
        // Keep status, Headers and body consumption real at the HTTP transport boundary.
        return Response.json(payload, { status });
    });
    setRuntimeFetch(fetch);
    return fetch;
}

describe('sendFriendRequest', () => {
    it('throws a typed HappyError when the server requires a linked identity provider', async () => {
        mockError(400, { error: 'provider-required', provider: 'github' });

        await expect(sendFriendRequest(credentials, 'u2')).rejects.toMatchObject({
            name: 'HappyError',
            message: 'provider-required',
            status: 400,
            kind: 'auth',
        });
    });

    it('throws a typed HappyError when the server requires a username', async () => {
        mockError(400, { error: 'username-required' });

        await expect(sendFriendRequest(credentials, 'u2')).rejects.toMatchObject({
            name: 'HappyError',
            message: 'username-required',
            status: 400,
            kind: 'auth',
        });
    });

    it('returns null when the friends routes are not available (404)', async () => {
        mockError(404, { error: 'not_found' });

        await expect(sendFriendRequest(credentials, 'u2')).resolves.toBeNull();
    });

    it('falls back to default HappyError message when 400 payload is not JSON', async () => {
        setRuntimeFetch(
            vi.fn(async (input: RequestInfo | URL) => {
                const url = String(input);
                if (url.endsWith('/health') || url.endsWith('/v1/auth/ping')) {
                    return Response.json({});
                }
                return new Response('not-json', { status: 400 });
            }),
        );

        await expect(sendFriendRequest(credentials, 'u2')).rejects.toMatchObject({
            name: 'HappyError',
            message: 'Failed to add friend',
        } satisfies Partial<HappyError>);
    });

    it('throws a generic Error on server-side 5xx failures', async () => {
        // Advance the clock boundary, not the real HTTP readiness or finite backoff owners.
        vi.useFakeTimers();
        const fetch = mockError(503, { error: 'temporarily_unavailable' });

        const outcome = sendFriendRequest(credentials, 'u2').then(value => value, (error: unknown) => error);
        await vi.runAllTimersAsync();
        expect(fetch.mock.calls.filter(([input]) => String(input).endsWith('/v1/friends/add'))).toHaveLength(8);
        const error = await outcome;
        expect(error).toBeInstanceOf(Error);
        expect(error).not.toBeInstanceOf(HappyError);
        expect(error).toHaveProperty('message', 'Failed to add friend: 503');
    });
});

describe('getFriendsList', () => {
    it('returns an empty array when the friends routes are not available (404)', async () => {
        mockError(404, { error: 'not_found' });

        await expect(getFriendsList(credentials)).resolves.toEqual([]);
    });
});
