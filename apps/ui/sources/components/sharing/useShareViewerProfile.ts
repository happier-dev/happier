import type { AccountDisplayProfileV1 } from '@happier-dev/protocol';
import { useShallow } from 'zustand/react/shallow';
import { getStorage } from '@/sync/domains/state/storageStore';
import { areServerAccountScopesEqual, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

/** A viewer's profile belongs to its exact Home and Account, including on inactive-Home sheets. */
export function useShareViewerProfile(scope: ServerAccountScope): AccountDisplayProfileV1 | null {
    return getStorage()(useShallow((state) => {
        const profile = areServerAccountScopesEqual(state.profileScope, scope) ? state.profile : null;
        return profile ? { firstName: profile.firstName, lastName: profile.lastName,
            username: profile.username, avatarUrl: profile.avatar?.url ?? null } : null;
    }));
}
