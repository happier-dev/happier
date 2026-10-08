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
 * Get multiple user profiles by IDs (fetches individually)
 */
export async function getUserProfiles(
    credentials: AuthCredentials,
    userIds: string[],
    opts: FriendsListOptions = {},
): Promise<UserProfile[]> {
    if (userIds.length === 0) return [];

    const request = opts.request ?? createServerFetchForActiveServer();
    // Fetch profiles individually and filter out nulls
    const profiles = await Promise.all(
        userIds.map(id => getUserProfile(credentials, id, { ...opts, request }))
    );
    
    return profiles.filter((profile): profile is UserProfile => profile !== null);
}

/**
 * Add a friend (send request or accept existing request)
 */
export async function sendFriendRequest(
    credentials: AuthCredentials,
    recipientId: string
): Promise<UserProfile | null> {
    const request = createServerFetchForActiveServer();
    return await backoff(async () => {
        const response = await request('/v1/friends/add', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${credentials.token}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ uid: recipientId }),
        }, { includeAuth: false });

        if (!response.ok) {
            if (response.status === 404) {
                return null;
            }
            if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
                let message = 'Failed to add friend';
                try {
                    const error = await response.json();
                    if (error?.error) message = error.error;
                } catch {
                    // ignore
                }
                if (response.status === 400 && message === 'provider-required') {
                    throw new HappyError(message, false, { status: 400, kind: 'auth' });
                }
                if (response.status === 400 && message === 'username-required') {
                    throw new HappyError(message, false, { status: 400, kind: 'auth' });
                }
                throw new HappyError(message, false);
            }
            throw new Error(`Failed to add friend: ${response.status}`);
        }

        const data = await response.json();
        const parsed = UserResponseSchema.safeParse(data);
        if (!parsed.success) {
            throw new HappyError('Invalid friend response', false, { kind: 'server' });
        }

        return parsed.data.user;
    });
}

// Note: respondToFriendRequest and getPendingFriendRequests have been removed
// The new API handles friend requests differently:
// - Use sendFriendRequest (which calls /v1/friends/add) to both send and accept requests
// - Use removeFriend to reject or cancel requests
// - Use getFriendsList to get all friends including pending requests

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

/**
 * Remove a friend (or reject/cancel friend request)
 */
export async function removeFriend(
    credentials: AuthCredentials,
    friendId: string
): Promise<UserProfile | null> {
    const request = createServerFetchForActiveServer();
    return await backoff(async () => {
        const response = await request('/v1/friends/remove', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${credentials.token}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ uid: friendId }),
        }, { includeAuth: false });

        if (!response.ok) {
            if (response.status === 404) {
                return null;
            }
            if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
                let message = 'Failed to remove friend';
                try {
                    const error = await response.json();
                    if (error?.error) message = error.error;
                } catch {
                    // ignore
                }
                throw new HappyError(message, false);
            }
            throw new Error(`Failed to remove friend: ${response.status}`);
        }

        const data = await response.json();
        const parsed = UserResponseSchema.safeParse(data);
        if (!parsed.success) {
            throw new HappyError('Invalid friend response', false, { kind: 'server' });
        }

        return parsed.data.user;
    });
}
