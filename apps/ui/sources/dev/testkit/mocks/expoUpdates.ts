/** Expo's native update adapter, shared by Node suites composing real UI owners. */
export function createExpoUpdatesMock() {
    // expo-updates 55 represents disabled/development update metadata as nullable exports.
    const runtimeMetadata = {
        isEnabled: false,
        updateId: null,
        channel: null,
        runtimeVersion: null,
        createdAt: null,
        isEmbeddedLaunch: true,
    } satisfies Pick<typeof import('expo-updates'),
        'isEnabled' | 'updateId' | 'channel' | 'runtimeVersion' | 'createdAt' | 'isEmbeddedLaunch'>;

    return {
        ...runtimeMetadata,
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
