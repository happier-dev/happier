import { useCallback, useEffect } from 'react';
import { AppState, AppStateStatus, Platform } from 'react-native';
import * as Updates from 'expo-updates';
import { useUpdates as useExpoUpdates } from 'expo-updates';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';

let otaAppStateSubscription: { remove: () => void } | null = null;
let otaCheckInFlight: Promise<void> | null = null;
let otaRuntimeConsumerCount = 0;

function shouldManageOtaUpdates(): boolean {
    return !__DEV__ && Platform.OS !== 'web';
}

function shouldRunOtaChecks(): boolean {
    return shouldManageOtaUpdates() && otaRuntimeConsumerCount > 0;
}

async function runSingleFlightOtaCheck(): Promise<void> {
    if (!shouldRunOtaChecks()) {
        return;
    }

    if (otaCheckInFlight) {
        return otaCheckInFlight;
    }

    otaCheckInFlight = (async () => {
        const update = await Updates.checkForUpdateAsync();
        if (update.isAvailable) {
            await Updates.fetchUpdateAsync();
        }
    })().finally(() => {
        otaCheckInFlight = null;
    });

    return otaCheckInFlight;
}

function startOtaRuntime(): void {
    if (otaAppStateSubscription || !shouldRunOtaChecks()) {
        return;
    }

    otaAppStateSubscription = AppState.addEventListener('change', (nextAppState: AppStateStatus) => {
        if (nextAppState === 'active') {
            void runSingleFlightOtaCheck().catch(() => {});
        }
    });

    void runSingleFlightOtaCheck().catch(() => {});
}

function stopOtaRuntime(): void {
    otaAppStateSubscription?.remove();
    otaAppStateSubscription = null;
}

export function useUpdates() {
    const otaUpdatesEnabled = useFeatureEnabled('updates.ota');
    const otaRuntimeSupported = otaUpdatesEnabled && shouldManageOtaUpdates();
    const updatesState = useExpoUpdates();

    const checkForUpdates = useCallback(async () => {
        if (!otaRuntimeSupported) {
            return;
        }

        try {
            await runSingleFlightOtaCheck();
        } catch {}
    }, [otaRuntimeSupported]);

    useEffect(() => {
        if (!otaRuntimeSupported) {
            return;
        }

        otaRuntimeConsumerCount += 1;
        startOtaRuntime();

        return () => {
            otaRuntimeConsumerCount = Math.max(0, otaRuntimeConsumerCount - 1);
            if (otaRuntimeConsumerCount === 0) {
                stopOtaRuntime();
            }
        };
    }, [otaRuntimeSupported]);

    const reloadApp = useCallback(async () => {
        try {
            if (Platform.OS === 'web') {
                window.location.reload();
            } else {
                await Updates.reloadAsync();
            }
        } catch {}
    }, []);

    return {
        updateAvailable: otaRuntimeSupported && updatesState.isUpdatePending,
        isChecking: otaRuntimeSupported && updatesState.isChecking,
        isDownloading: otaRuntimeSupported && updatesState.isDownloading,
        isRestarting: otaRuntimeSupported && updatesState.isRestarting,
        isUpdateAvailable: otaRuntimeSupported && updatesState.isUpdateAvailable,
        isUpdatePending: otaRuntimeSupported && updatesState.isUpdatePending,
        downloadProgress: otaRuntimeSupported ? updatesState.downloadProgress : undefined,
        checkError: otaRuntimeSupported ? updatesState.checkError : undefined,
        downloadError: otaRuntimeSupported ? updatesState.downloadError : undefined,
        lastCheckForUpdateTimeSinceRestart: otaRuntimeSupported ? updatesState.lastCheckForUpdateTimeSinceRestart : undefined,
        availableUpdate: otaRuntimeSupported ? updatesState.availableUpdate : undefined,
        downloadedUpdate: otaRuntimeSupported ? updatesState.downloadedUpdate : undefined,
        currentlyRunning: updatesState.currentlyRunning,
        otaUpdatesEnabled,
        otaRuntimeSupported,
        checkForUpdates,
        reloadApp,
    };
}
