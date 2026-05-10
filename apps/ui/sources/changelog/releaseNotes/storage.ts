import { MMKV } from 'react-native-mmkv';

const mmkv = new MMKV();

const LAST_SEEN_RELEASE_ID_KEY = 'release-notes-last-seen-release-id';
const MIGRATION_SEEDED_RELEASE_ID_KEY = 'release-notes-migration-seeded-release-id';
const CACHED_MANIFEST_KEY = 'release-notes-cached-manifest-v1';
const CACHED_MANIFEST_FETCHED_AT_KEY = 'release-notes-cached-manifest-fetched-at';
const CACHED_ASSET_INDEX_KEY = 'release-notes-cached-asset-index-v1';
const CACHED_ASSET_INDEX_FETCHED_AT_KEY = 'release-notes-cached-asset-index-fetched-at';
const LEGACY_CHANGELOG_AUTO_SEEN_BASELINE_KEY = 'release-notes-legacy-changelog-auto-seen-baseline';

const lastSeenReleaseIdListeners = new Set<() => void>();
let releaseNotesRuntimeVersion = 0;

export function getReleaseNotesRuntimeVersion(): number {
    return releaseNotesRuntimeVersion;
}

export function emitReleaseNotesRuntimeChanged(): void {
    releaseNotesRuntimeVersion += 1;
    for (const listener of lastSeenReleaseIdListeners) {
        listener();
    }
}

function emitLastSeenReleaseIdChanged(): void {
    emitReleaseNotesRuntimeChanged();
}

export function getLastSeenReleaseId(): string | null {
    return mmkv.getString(LAST_SEEN_RELEASE_ID_KEY) ?? null;
}

export function setLastSeenReleaseId(releaseId: string): void {
    mmkv.set(LAST_SEEN_RELEASE_ID_KEY, releaseId);
    emitLastSeenReleaseIdChanged();
}

export function clearLastSeenReleaseId(): void {
    mmkv.delete(LAST_SEEN_RELEASE_ID_KEY);
    emitLastSeenReleaseIdChanged();
}

export function subscribeLastSeenReleaseId(listener: () => void): () => void {
    lastSeenReleaseIdListeners.add(listener);
    return () => {
        lastSeenReleaseIdListeners.delete(listener);
    };
}

export const subscribeReleaseNotesRuntime = subscribeLastSeenReleaseId;

export function getMigrationSeededReleaseId(): string | null {
    return mmkv.getString(MIGRATION_SEEDED_RELEASE_ID_KEY) ?? null;
}

export function setMigrationSeededReleaseId(releaseId: string): void {
    mmkv.set(MIGRATION_SEEDED_RELEASE_ID_KEY, releaseId);
    emitReleaseNotesRuntimeChanged();
}

export function getLegacyChangelogAutoSeenBaseline(): string | null {
    return mmkv.getString(LEGACY_CHANGELOG_AUTO_SEEN_BASELINE_KEY) ?? null;
}

export function setLegacyChangelogAutoSeenBaseline(baseline: string): void {
    mmkv.set(LEGACY_CHANGELOG_AUTO_SEEN_BASELINE_KEY, baseline);
}

export function getCachedManifestRaw(): string | null {
    return mmkv.getString(CACHED_MANIFEST_KEY) ?? null;
}

export function setCachedManifestRaw(rawJson: string): void {
    mmkv.set(CACHED_MANIFEST_KEY, rawJson);
    mmkv.set(CACHED_MANIFEST_FETCHED_AT_KEY, Date.now());
    emitReleaseNotesRuntimeChanged();
}

export function getCachedManifestFetchedAt(): number | null {
    return mmkv.getNumber(CACHED_MANIFEST_FETCHED_AT_KEY) ?? null;
}

export function clearCachedManifest(): void {
    mmkv.delete(CACHED_MANIFEST_KEY);
    mmkv.delete(CACHED_MANIFEST_FETCHED_AT_KEY);
    emitReleaseNotesRuntimeChanged();
}

export function getCachedAssetIndexRaw(): string | null {
    return mmkv.getString(CACHED_ASSET_INDEX_KEY) ?? null;
}

export function setCachedAssetIndexRaw(rawJson: string): void {
    mmkv.set(CACHED_ASSET_INDEX_KEY, rawJson);
    mmkv.set(CACHED_ASSET_INDEX_FETCHED_AT_KEY, Date.now());
    emitReleaseNotesRuntimeChanged();
}

export function getCachedAssetIndexFetchedAt(): number | null {
    return mmkv.getNumber(CACHED_ASSET_INDEX_FETCHED_AT_KEY) ?? null;
}

export function clearCachedAssetIndex(): void {
    mmkv.delete(CACHED_ASSET_INDEX_KEY);
    mmkv.delete(CACHED_ASSET_INDEX_FETCHED_AT_KEY);
    emitReleaseNotesRuntimeChanged();
}

export function hasUnreadRelease(latestReleaseId: string | null): boolean {
    if (!latestReleaseId) {
        return false;
    }
    const seen = getLastSeenReleaseId();
    if (seen == null) {
        // No seed yet — let migration decide. Return false until migration seeds explicit baseline.
        return false;
    }
    return seen !== latestReleaseId;
}
