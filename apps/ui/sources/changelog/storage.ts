import { MMKV } from 'react-native-mmkv';

const mmkv = new MMKV();

const LAST_VIEWED_RELEASE_ID_KEY = 'changelog-last-viewed-release-id';

export function getLastViewedReleaseId(): string | null {
    return mmkv.getString(LAST_VIEWED_RELEASE_ID_KEY) ?? null;
}

export function setLastViewedReleaseId(releaseId: string): void {
    mmkv.set(LAST_VIEWED_RELEASE_ID_KEY, releaseId);
}

export function hasUnreadChangelog(latestReleaseId: string | null): boolean {
    if (!latestReleaseId) {
        return false;
    }

    const lastViewedReleaseId = getLastViewedReleaseId();
    if (lastViewedReleaseId === null) {
        return false;
    }

    return latestReleaseId !== lastViewedReleaseId;
}
