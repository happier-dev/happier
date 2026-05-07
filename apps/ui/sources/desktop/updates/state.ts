export function shouldShowDesktopUpdateStatus({
    availableVersion,
    dismissedVersion
}: {
    availableVersion: string | null;
    dismissedVersion: string | null;
}): boolean {
    if (!availableVersion) {
        return false;
    }
    return availableVersion !== dismissedVersion;
}
