function normalizeComparableVersion(version: string): {
    baseParts: number[];
    prereleaseChannel: 'dev' | 'preview' | null;
    prereleaseNumbers: number[];
} {
    const trimmed = String(version ?? '').trim();
    if (!trimmed) throw new Error('Invalid version');
    const [baseVersion, rawSuffix = ''] = trimmed.split('-', 2);
    const baseParts = baseVersion.split('.').map(Number);
    if (baseParts.length === 0 || baseParts.some((part) => !Number.isInteger(part) || part < 0)) {
        throw new Error('Invalid version');
    }

    if (!rawSuffix) {
        return {
            baseParts,
            prereleaseChannel: null,
            prereleaseNumbers: [],
        };
    }

    const suffixParts = rawSuffix.split('.');
    const channel = suffixParts[0];
    if (channel !== 'dev' && channel !== 'preview') {
        throw new Error('Unsupported prerelease channel');
    }
    const prereleaseNumbers = suffixParts.slice(1).map(Number);
    if (prereleaseNumbers.length === 0 || prereleaseNumbers.some((part) => !Number.isInteger(part) || part < 0)) {
        throw new Error('Invalid prerelease version');
    }

    return {
        baseParts,
        prereleaseChannel: channel,
        prereleaseNumbers,
    };
}

/**
 * Compare two semantic version strings
 * @param version1 First version to compare
 * @param version2 Second version to compare
 * @returns -1 if version1 < version2, 0 if equal, 1 if version1 > version2
 */
export function compareVersions(version1: string, version2: string): number {
    const v1 = normalizeComparableVersion(version1);
    const v2 = normalizeComparableVersion(version2);
    
    // Pad with zeros if needed
    const v1Parts = [...v1.baseParts];
    const v2Parts = [...v2.baseParts];
    const maxLength = Math.max(v1Parts.length, v2Parts.length);
    while (v1Parts.length < maxLength) v1Parts.push(0);
    while (v2Parts.length < maxLength) v2Parts.push(0);
    
    for (let i = 0; i < maxLength; i++) {
        if (v1Parts[i] > v2Parts[i]) return 1;
        if (v1Parts[i] < v2Parts[i]) return -1;
    }

    if (v1.prereleaseChannel === null && v2.prereleaseChannel !== null) return 1;
    if (v1.prereleaseChannel !== null && v2.prereleaseChannel === null) return -1;
    if (v1.prereleaseChannel === null && v2.prereleaseChannel === null) return 0;

    const v1ChannelRank = v1.prereleaseChannel === 'dev' ? 1 : 2;
    const v2ChannelRank = v2.prereleaseChannel === 'dev' ? 1 : 2;
    if (v1ChannelRank > v2ChannelRank) return 1;
    if (v1ChannelRank < v2ChannelRank) return -1;

    const v1PrereleaseNumbers = [...v1.prereleaseNumbers];
    const v2PrereleaseNumbers = [...v2.prereleaseNumbers];
    const prereleaseLength = Math.max(v1PrereleaseNumbers.length, v2PrereleaseNumbers.length);
    while (v1PrereleaseNumbers.length < prereleaseLength) v1PrereleaseNumbers.push(0);
    while (v2PrereleaseNumbers.length < prereleaseLength) v2PrereleaseNumbers.push(0);
    for (let i = 0; i < prereleaseLength; i++) {
        if (v1PrereleaseNumbers[i] > v2PrereleaseNumbers[i]) return 1;
        if (v1PrereleaseNumbers[i] < v2PrereleaseNumbers[i]) return -1;
    }
    
    return 0;
}

/**
 * Parse version string to extract major, minor, and patch numbers
 * @param version Version string to parse
 * @returns Object with major, minor, and patch numbers, or null if invalid
 */
export function parseVersion(version: string): { major: number; minor: number; patch: number } | null {
    try {
        const cleanVersion = version.split('-')[0];
        const [major, minor, patch] = cleanVersion.split('.').map(Number);
        
        if (isNaN(major) || isNaN(minor) || isNaN(patch)) {
            return null;
        }
        
        return { major, minor, patch };
    } catch {
        return null;
    }
}

/** `true` only when both versions parse and `latest` is newer. Unparseable input never claims an update. */
export function isNewerVersion(current: string | null, latest: string | null): boolean {
    if (!current || !latest) return false;
    if (!parseVersion(current) || !parseVersion(latest)) return false;
    try {
        return compareVersions(current, latest) < 0;
    } catch {
        return false;
    }
}

