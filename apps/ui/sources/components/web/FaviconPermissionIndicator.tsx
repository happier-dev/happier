import React from 'react';
import { Platform } from 'react-native';
import { storage } from '@/sync/domains/state/storage';
import { updateFaviconWithNotification, resetFavicon } from '@/utils/web/faviconGenerator';
import { createFaviconPermissionSnapshotSelector } from './faviconPermissionSnapshot';

/**
 * Component that monitors all sessions and updates the favicon
 * when any online session has pending permissions
 */
export const FaviconPermissionIndicator = React.memo(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined' || typeof document === 'undefined') {
        return null;
    }

    const [runtimeFreshnessVersion, refreshRuntimeFreshness] = React.useReducer((value: number) => value + 1, 0);
    const selector = React.useMemo(() => createFaviconPermissionSnapshotSelector(), []);
    void runtimeFreshnessVersion;
    const faviconSnapshot = storage(selector);

    React.useLayoutEffect(() => {
        if (faviconSnapshot.hasFreshPermission) {
            updateFaviconWithNotification();
        } else {
            resetFavicon();
        }
    }, [faviconSnapshot.hasFreshPermission]);

    React.useEffect(() => {
        if (faviconSnapshot.nextRefreshDelayMs === null) return undefined;
        const timeoutId = setTimeout(refreshRuntimeFreshness, faviconSnapshot.nextRefreshDelayMs);
        return () => clearTimeout(timeoutId);
    }, [faviconSnapshot.nextRefreshDelayMs]);

    React.useLayoutEffect(() => {
        return () => {
            resetFavicon();
        };
    }, []);

    return null;
});

FaviconPermissionIndicator.displayName = 'FaviconPermissionIndicator';
