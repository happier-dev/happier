import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { backoff } from '@/utils/timing/time';
import { serverFetch } from '@/sync/http/client';
import { HappyError } from '@/utils/errors/errors';
import {
    UserProfile,
    UserResponse,
    FriendsResponse,
    UsersSearchResponse,
    UserResponseSchema,
    FriendsResponseSchema,
    UsersSearchResponseSchema
} from '@/sync/domains/social/friendTypes';

/**
 * Search for users by username (returns multiple results)
 */
export async function searchUsersByUsername(
    credentials: AuthCredentials,
    username: string
): Promise<UserProfile[]> {
    return await backoff(async () => {
        const response = await serverFetch(
            `/v1/user/search?${new URLSearchParams({ query: username })}`,
            {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${credentials.token}`,
                },
            },
            { includeAuth: false },
        );

        if (!response.ok) {
            if (response.status === 404) {
                return [];
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
            console.error('Failed to parse search response:', parsed.error);
            return [];
        }
        
        return parsed.data.users;
    });
}

/**
 * Get a single user profile by ID
 */
export async function getUserProfile(
    credentials: AuthCredentials,
    userId: string
): Promise<UserProfile | null> {
    return await backoff(async () => {
        const response = await serverFetch(
            `/v1/user/${userId}`,
            {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${credentials.token}`,
                },
            },
            { includeAuth: false },
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
            console.error('Failed to parse user response:', parsed.error);
            return null;
        }

        return parsed.data.user;
    });
}

/**
 * Get multiple user profiles by IDs (fetches individually)
 */
export async function getUserProfiles(
    credentials: AuthCredentials,
    userIds: string[]
): Promise<UserProfile[]> {
    if (userIds.length === 0) return [];

    // Fetch profiles individually and filter out nulls
    const profiles = await Promise.all(
        userIds.map(id => getUserProfile(credentials, id))
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
    return await backoff(async () => {
        const response = await serverFetch('/v1/friends/add', {
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
            console.error('Failed to parse add friend response:', parsed.error);
            return null;
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
    credentials: AuthCredentials
): Promise<UserProfile[]> {
    return await backoff(async () => {
        const response = await serverFetch('/v1/friends', {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${credentials.token}`,
            },
        }, { includeAuth: false });

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
            console.error('Failed to parse friends list:', parsed.error);
            return [];
        }

        return parsed.data.friends;
    });
}

/**
 * Remove a friend (or reject/cancel friend request)
 */
export async function removeFriend(
    credentials: AuthCredentials,
    friendId: string
): Promise<UserProfile | null> {
    return await backoff(async () => {
        const response = await serverFetch('/v1/friends/remove', {
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
            console.error('Failed to parse remove friend response:', parsed.error);
            return null;
        }

        return parsed.data.user;
    });
}
