import React from 'react';
import { Platform } from 'react-native';
import { storage } from '@/sync/domains/state/storage';
import { updateFaviconWithNotification, resetFavicon } from '@/utils/web/faviconGenerator';
import { derivePendingRequestFlagsFromAgentState } from '@/sync/domains/session/listing/sessionListRenderable';

/**
 * Component that monitors all sessions and updates the favicon
 * when any online session has pending permissions
 */
export const FaviconPermissionIndicator = React.memo(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined' || typeof document === 'undefined') {
        return null;
    }

    const hasOnlineSessionWithPermissions = storage((state) => {
        return Object.values(state.sessions).some(session => {
            // Use centralized presence logic - only "online" sessions matter
            const isOnline = session.presence === 'online';
            const isSessionActive = session.active === true;
            const hasPermissions = derivePendingRequestFlagsFromAgentState(session.agentState).hasPendingPermissionRequests;

            return isOnline && isSessionActive && hasPermissions;
        });
    });

    React.useLayoutEffect(() => {
        if (hasOnlineSessionWithPermissions) {
            updateFaviconWithNotification();
        } else {
            resetFavicon();
        }
    }, [hasOnlineSessionWithPermissions]);

    React.useLayoutEffect(() => {
        return () => {
            resetFavicon();
        };
    }, []);

    return null;
});

FaviconPermissionIndicator.displayName = 'FaviconPermissionIndicator';
