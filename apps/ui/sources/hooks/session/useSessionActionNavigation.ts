import * as React from 'react';
import { useNavigation } from 'expo-router';

import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';

/** Async session actions may navigate only while their originating session is still in view. */
export function useSessionActionNavigation(params: Readonly<{
    sessionId: string;
    serverId: string | null;
    onNavigate: () => void;
}>): () => void {
    const navigation = useNavigation();
    const currentSession = React.useRef<Readonly<{ sessionId: string; serverId: string | null }> | null>(null);

    React.useLayoutEffect(() => {
        // Deletion can unmount session content before its action settles; route focus owns the exit.
        currentSession.current = { sessionId: params.sessionId, serverId: params.serverId };
    }, [params.sessionId, params.serverId]);

    return React.useCallback(() => {
        const current = currentSession.current;
        if (!current || current.sessionId !== params.sessionId || !navigation.isFocused()) return;
        const sameServer = current.serverId === params.serverId
            || (current.serverId !== null && params.serverId !== null
                && areServerProfileIdentifiersEquivalent(current.serverId, params.serverId));
        if (sameServer) params.onNavigate();
    }, [navigation, params.onNavigate, params.serverId, params.sessionId]);
}
