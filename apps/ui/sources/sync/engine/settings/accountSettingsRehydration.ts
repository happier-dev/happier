export function assertAccountSettingsRehydratedVersion(input: Readonly<{
    currentVersion: number | null;
    minimumVersion: number;
}>): void {
    if (!Number.isInteger(input.currentVersion) || input.currentVersion === null || input.currentVersion < input.minimumVersion) {
        throw new Error('Account settings did not rehydrate to the daemon-acknowledged version');
    }
}
