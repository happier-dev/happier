import * as React from 'react';

import { useOptionalAuth } from '@/auth/context/AuthContext';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import {
    fetchAccountEncryptionMode,
    getAccountEncryptionModeCacheRevision,
    getCachedAccountEncryptionMode,
    subscribeAccountEncryptionModeCacheInvalidation,
} from '@/sync/api/account/apiAccountEncryptionMode';

/**
 * The mode owner's withdrawal revision for one Home. Every mounted mode reader
 * re-reads through the owner when it changes, so each conversion or push the
 * owner publishes reaches the presentation without a remount.
 */
export function useAccountEncryptionModeRevision(serverId: string | null | undefined): number {
    const subscribe = React.useCallback((listener: () => void) =>
        subscribeAccountEncryptionModeCacheInvalidation(listener, serverId), [serverId]);
    const getRevision = React.useCallback(() => getAccountEncryptionModeCacheRevision(serverId), [serverId]);
    return React.useSyncExternalStore(subscribe, getRevision, getRevision);
}

/**
 * The focused Account's persisted `encryptionMode` (the authority for "End-to-end encrypted"; key
 * presence is not): the cache owner's last answer at once, then one read through that owner, re-read
 * when it invalidates. `null` until the Account answers; a failed read keeps it unknown.
 */
export function useAccountEncryptionMode(options: Readonly<{ enabled?: boolean }> = {}): 'e2ee' | 'plain' | null {
    const enabled = options.enabled !== false;
    const credentials = useOptionalAuth()?.credentials ?? null;
    const { serverId } = useActiveServerSnapshot(enabled && credentials !== null);
    const revision = useAccountEncryptionModeRevision(serverId);
    const [projection, setProjection] = React.useState<Readonly<{
        credentials: AuthCredentials;
        revision: number;
        mode: 'e2ee' | 'plain';
    }> | null>(null);

    React.useEffect(() => {
        if (!credentials || !enabled) {
            setProjection(null);
            return undefined;
        }
        let current = true;
        void fetchAccountEncryptionMode(credentials).then(
            (result) => { if (current) setProjection({ credentials, revision, mode: result.mode }); },
            // Not answered (offline, unreachable Home): the mode stays unknown; nothing waits on it.
            () => { if (current) setProjection(null); },
        );
        return () => {
            current = false;
        };
    }, [credentials, enabled, revision]);

    if (!credentials || !enabled) return null;
    // A retired Account or owner revision cannot disclose the previous projection
    // while its replacement read is pending or refused.
    return getCachedAccountEncryptionMode(credentials)
        ?? (projection?.credentials === credentials && projection.revision === revision ? projection.mode : null);
}
