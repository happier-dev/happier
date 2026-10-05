/** Expo's native update adapter, shared by Node suites composing real UI owners. */
export function createExpoUpdatesMock() {
    return {
        useUpdates: () => ({
            currentlyRunning: {},
            isChecking: false,
            isDownloading: false,
            isRestarting: false,
            isStartupProcedureRunning: false,
            isUpdateAvailable: false,
            isUpdatePending: false,
            restartCount: 0,
        }),
        checkForUpdateAsync: async () => ({ isAvailable: false }),
        fetchUpdateAsync: async () => {},
        reloadAsync: async () => {},
    };
}
