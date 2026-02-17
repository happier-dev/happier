import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, AppStateStatus, Platform } from 'react-native';
import * as Updates from 'expo-updates';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';

export function useUpdates() {
    const otaUpdatesEnabled = useFeatureEnabled('updates.ota');
    const [updateAvailable, setUpdateAvailable] = useState(false);
    const [isChecking, setIsChecking] = useState(false);
    const isCheckingRef = useRef(false);

    const checkForUpdates = useCallback(async () => {
        if (__DEV__) {
            // Don't check for updates in development
            return;
        }

        if (!otaUpdatesEnabled) {
            return;
        }

        if (isCheckingRef.current) {
            return;
        }

        isCheckingRef.current = true;
        setIsChecking(true);

        try {
            const update = await Updates.checkForUpdateAsync();
            if (update.isAvailable) {
                await Updates.fetchUpdateAsync();
                setUpdateAvailable(true);
            }
        } catch (error) {
            console.error('Error checking for updates:', error);
        } finally {
            isCheckingRef.current = false;
            setIsChecking(false);
        }
    }, [otaUpdatesEnabled]);

    const handleAppStateChange = useCallback((nextAppState: AppStateStatus) => {
        if (nextAppState === 'active') {
            void checkForUpdates();
        }
    }, [checkForUpdates]);

    useEffect(() => {
        // Check for updates when app becomes active
        const subscription = AppState.addEventListener('change', handleAppStateChange);

        return () => {
            subscription.remove();
        };
    }, [handleAppStateChange]);

    useEffect(() => {
        void checkForUpdates();
    }, [checkForUpdates]);

    useEffect(() => {
        if (otaUpdatesEnabled) return;
        setUpdateAvailable(false);
    }, [otaUpdatesEnabled]);

    const reloadApp = useCallback(async () => {
        if (Platform.OS === 'web') {
            window.location.reload();
        } else {
            try {
                await Updates.reloadAsync();
            } catch (error) {
                console.error('Error reloading app:', error);
            }
        }
    }, []);

    return {
        updateAvailable,
        isChecking,
        checkForUpdates,
        reloadApp,
    };
}
