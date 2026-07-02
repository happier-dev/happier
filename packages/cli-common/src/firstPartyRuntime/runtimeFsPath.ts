const WINDOWS_EXTENDED_LENGTH_PREFIX = '\\\\?\\';
const WINDOWS_UNC_PREFIX = '\\\\';
const WINDOWS_EXTENDED_LENGTH_UNC_PREFIX = '\\\\?\\UNC\\';
const WINDOWS_DEVICE_PREFIX = '\\\\.\\';
const WINDOWS_DRIVE_ABSOLUTE_PATH_PATTERN = /^[a-zA-Z]:\\/;

export function toWindowsExtendedLengthPathForFs(
    pathLike: string,
    platform: NodeJS.Platform = process.platform,
): string {
    if (platform !== 'win32') {
        return pathLike;
    }

    const normalizedPath = pathLike.replaceAll('/', '\\');

    if (
        normalizedPath.startsWith(WINDOWS_EXTENDED_LENGTH_PREFIX)
        || normalizedPath.startsWith(WINDOWS_DEVICE_PREFIX)
    ) {
        return normalizedPath;
    }

    if (normalizedPath.startsWith(WINDOWS_UNC_PREFIX)) {
        return `${WINDOWS_EXTENDED_LENGTH_UNC_PREFIX}${normalizedPath.slice(WINDOWS_UNC_PREFIX.length)}`;
    }

    if (WINDOWS_DRIVE_ABSOLUTE_PATH_PATTERN.test(normalizedPath)) {
        return `${WINDOWS_EXTENDED_LENGTH_PREFIX}${normalizedPath}`;
    }

    return pathLike;
}

export function toRuntimeFsPath(pathLike: string): string {
    return toWindowsExtendedLengthPathForFs(pathLike);
}
