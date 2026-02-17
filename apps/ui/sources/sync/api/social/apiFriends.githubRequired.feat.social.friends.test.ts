import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { HappyError } from '@/utils/errors/errors';
import { getFriendsList, sendFriendRequest } from './apiFriends';

vi.mock('@/utils/timing/time', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/utils/timing/time')>();
    const immediate = async <T,>(callback: () => Promise<T>): Promise<T> => await callback();
    return {
        ...actual,
        backoff: immediate,
        backoffForever: immediate,
    };
});

afterEach(() => {
    vi.unstubAllGlobals();
});

const credentials: AuthCredentials = { token: 't', secret: 's' };

function mockError(status: number, payload: unknown) {
    vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({
            ok: false,
            status,
            json: async () => payload,
        })) as unknown as typeof fetch,
    );
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
        const invalidJsonError = new Error('invalid json');
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => ({
                ok: false,
                status: 400,
                json: async () => {
                    throw invalidJsonError;
                },
            })) as unknown as typeof fetch,
        );

        await expect(sendFriendRequest(credentials, 'u2')).rejects.toMatchObject({
            name: 'HappyError',
            message: 'Failed to add friend',
        } satisfies Partial<HappyError>);
    });

    it('throws a generic Error on server-side 5xx failures', async () => {
        mockError(503, { error: 'temporarily_unavailable' });

        await expect(sendFriendRequest(credentials, 'u2')).rejects.toThrow('Failed to add friend: 503');
    });
});

describe('getFriendsList', () => {
    it('returns an empty array when the friends routes are not available (404)', async () => {
        mockError(404, { error: 'not_found' });

        await expect(getFriendsList(credentials)).resolves.toEqual([]);
    });
});
