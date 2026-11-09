import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { backoff } from '@/utils/timing/time';
import { createServerFetchForActiveServer, type ServerFetch } from '@/sync/http/client';
import { HappyError } from '@/utils/errors/errors';
import {
    UserProfile,
    UserResponseSchema,
    FriendsResponseSchema,
    UsersSearchResponseSchema,
    type UsersSearchResponse,
} from '@/sync/domains/social/friendTypes';

type RetryMode = 'default' | 'none';
type RetryOptions = Readonly<{ retry?: RetryMode }>;
type FriendsListOptions = RetryOptions & Readonly<{ request?: ServerFetch }>;
type UserSearchOptions = FriendsListOptions & Readonly<{
    cursor?: string | null;
    purpose?: 'collaboration';
}>;

/**
 * Search for users by username (returns multiple results)
 */
export async function searchUsersByUsername(
    credentials: AuthCredentials,
    username: string,
    options?: FriendsListOptions,
): Promise<UserProfile[]> {
    return [...(await searchUsersPageByUsername(credentials, username, options)).users];
}

/** Pages the canonical username directory while keeping the released array
 * helper above for callers that deliberately consume only the first page. */
export async function searchUsersPageByUsername(
    credentials: AuthCredentials,
    username: string,
    options?: UserSearchOptions,
): Promise<Readonly<{ users: readonly UserProfile[]; nextCursor: string | null }>> {
    const request = options?.request ?? (() => {
        const focusedRequest = createServerFetchForActiveServer();
        return (path: string, init?: RequestInit) => focusedRequest(path, init, { includeAuth: false });
    })();
    const load = async () => {
        const query = new URLSearchParams({ query: username });
        if (options?.cursor) query.set('cursor', options.cursor);
        if (options?.purpose) query.set('purpose', options.purpose);
        const response = await request(
            `/v1/user/search?${query}`,
            {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${credentials.token}`,
                },
            },
        );

        if (!response.ok) {
            if (response.status === 404) {
                return { users: [], nextCursor: null };
            }
            if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
                let message = 'Failed to search users';
                try {
                    const error = await response.json();
                    if (error?.error) message = error.error;
                } catch {
                    // ignore
                }
                throw new HappyError(message, false);
            }
            throw new Error(`Failed to search users: ${response.status}`);
        }

        const data = await response.json();
        const parsed = UsersSearchResponseSchema.safeParse(data);
        if (!parsed.success) {
            throw new HappyError('Invalid user search response', false, { kind: 'server' });
        }
        
        const page: UsersSearchResponse = parsed.data;
        return { users: page.users, nextCursor: page.nextCursor ?? null };
    };
    return options?.retry === 'none' ? await load() : await backoff(load);
}

/**
 * Get a single user profile by ID
 */
export async function getUserProfile(
    credentials: AuthCredentials,
    userId: string,
    opts: FriendsListOptions = {},
): Promise<UserProfile | null> {
    const request = opts.request ?? createServerFetchForActiveServer();
    const run = async () => {
        const response = await request(
            `/v1/user/${userId}`,
            {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${credentials.token}`,
                },
            },
            { includeAuth: false, retry: opts.retry },
        );

        if (!response.ok) {
            if (response.status === 404) {
                return null;
            }
            if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
                let message = 'Failed to get user profile';
                try {
                    const error = await response.json();
                    if (error?.error) message = error.error;
                } catch {
                    // ignore
                }
                throw new HappyError(message, false);
            }
            throw new Error(`Failed to get user profile: ${response.status}`);
        }

        const data = await response.json();
        const parsed = UserResponseSchema.safeParse(data);
        if (!parsed.success) {
            throw new HappyError('Invalid user profile response', false, { kind: 'server' });
        }

        return parsed.data.user;
    };

    if (opts.retry === 'none') {
        return await run();
    }

    return await backoff(run);
}
/**
 * Exact People projection: one request for the consumed page, never one per person.
 */
export async function getUserProfiles(
    credentials: AuthCredentials,
    userIds: string[],
    opts: FriendsListOptions = {},
): Promise<UserProfile[]> {
    if (userIds.length === 0) return [];

    const request = opts.request ?? createServerFetchForActiveServer();
    const ids = [...new Set(userIds)];
    const load = async (): Promise<UserProfile[]> => {
        const response = await request('/v1/user/profiles', {
            method: 'POST',
            headers: { Authorization: `Bearer ${credentials.token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ ids }),
        }, { includeAuth: false, retry: opts.retry });
        // Released Homes without the batch read retain anonymous presentation;
        // they must not turn a rendered page into singleton profile requests.
        if (response.status === 404) return [];
        if (!response.ok) {
            if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
                throw new HappyError('Failed to get user profiles', false);
            }
            throw new Error(`Failed to get user profiles: ${response.status}`);
        }
        const parsed = UsersSearchResponseSchema.safeParse(await response.json());
        if (!parsed.success) throw new HappyError('Invalid user profiles response', false, { kind: 'server' });
        const byId = new Map(parsed.data.users.map(profile => [profile.id, profile]));
        return ids.flatMap(id => { const profile = byId.get(id); return profile ? [profile] : []; });
    };
    return opts.retry === 'none' ? await load() : await backoff(load);
}

/**
 * Get friends list (includes all statuses: friend, pending, requested)
 */
export async function getFriendsList(
    credentials: AuthCredentials,
    opts: FriendsListOptions = {},
): Promise<UserProfile[]> {
    const request = opts.request ?? createServerFetchForActiveServer();
    const run = async () => {
        const init: RequestInit = {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${credentials.token}`,
            },
        };
        const response = opts.request
            ? await request('/v1/friends', init)
            : await request('/v1/friends', init, { includeAuth: false });

        if (!response.ok) {
            if (response.status === 404) {
                return [];
            }
            if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
                let message = 'Failed to get friends list';
                try {
                    const error = await response.json();
                    if (error?.error) message = error.error;
                } catch {
                    // ignore
                }
                throw new HappyError(message, false);
            }
            throw new Error(`Failed to get friends list: ${response.status}`);
        }

        const data = await response.json();
        const parsed = FriendsResponseSchema.safeParse(data);
        if (!parsed.success) {
            throw new HappyError('Invalid friends list response', false, { kind: 'server' });
        }

        return parsed.data.friends;
    };

    if (opts.retry === 'none') {
        return await run();
    }

    return await backoff(run);
}
