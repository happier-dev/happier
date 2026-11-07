import { MMKV } from 'react-native-mmkv';

const mmkv = new MMKV();

const LAST_VIEWED_RELEASE_ID_KEY = 'changelog-last-viewed-release-id';
const LEGACY_LAST_VIEWED_VERSION_KEY = 'changelog-last-viewed-version';
const listeners = new Set<() => void>();

export function getLastViewedReleaseId(): string | null {
    const releaseId = mmkv.getString(LAST_VIEWED_RELEASE_ID_KEY);
    if (releaseId !== undefined) return releaseId;
    // UI 0.2.21 (f6f4032f) stored integer Version identities. Keep that key intact
    // for rollback; upgrades read it without treating existing users as fresh installs.
    const legacyVersion = mmkv.getNumber(LEGACY_LAST_VIEWED_VERSION_KEY) ?? 0;
    return legacyVersion > 0 ? String(legacyVersion) : null;
}

export function setLastViewedReleaseId(releaseId: string): void {
    if (getLastViewedReleaseId() === releaseId) return;
    mmkv.set(LAST_VIEWED_RELEASE_ID_KEY, releaseId);
    for (const listener of listeners) listener();
}

export function subscribeChangelogReadState(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

export function hasUnreadChangelog(latestReleaseId: string | null): boolean {
    const lastViewed = getLastViewedReleaseId();
    return latestReleaseId !== null && lastViewed !== null && latestReleaseId !== lastViewed;
}
