function normalizeNonEmptyString(value: unknown): string | null {
    if (typeof value !== 'string') {
        return null;
    }

    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

export function normalizeFileSystemPath(value: unknown): string | null {
    const normalized = normalizeNonEmptyString(value);
    if (!normalized) {
        return null;
    }

    const normalizedSeparators = normalized.replace(/\\/g, '/');
    const normalizedDevicePath = normalizedSeparators.startsWith('//?/UNC/')
        ? `//${normalizedSeparators.slice('//?/UNC/'.length)}`
        : normalizedSeparators.startsWith('//?/')
            ? normalizedSeparators.slice('//?/'.length)
            : normalizedSeparators;
    const normalizedWindowsPath = /^[A-Za-z]:\//.test(normalizedDevicePath) || normalizedDevicePath.startsWith('//')
        ? normalizedDevicePath.toLowerCase()
        : normalizedDevicePath.replace(/^([A-Z]):/, (_match, driveLetter: string) => `${driveLetter.toLowerCase()}:`);
    const trimmedTrailingSeparators = normalizedWindowsPath.replace(/[\/]+$/, '');
    return trimmedTrailingSeparators.length > 0 ? trimmedTrailingSeparators : normalizedWindowsPath;
}
