import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import type { UserProfile } from '@/sync/domains/social/friendTypes';
import { getFriendsList } from '@/sync/api/social/apiFriends';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { isRuntimeFeatureEnabled } from '@/sync/domains/features/featureDecisionInputs';

export async function fetchAndApplyFriends(params: {
    credentials: AuthCredentials | null | undefined;
    applyFriends: (friends: UserProfile[]) => void;
}): Promise<void> {
    if (!params.credentials) {
        return;
    }

    const activeServer = getActiveServerSnapshot();
    const enabled = await isRuntimeFeatureEnabled({
        featureId: 'social.friends',
        serverId: activeServer.serverId,
        timeoutMs: 400,
    });

    if (!enabled) {
        return;
    }

    const friendsList = await getFriendsList(params.credentials);
    params.applyFriends(friendsList);
}
