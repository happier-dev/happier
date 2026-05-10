import type { ReleaseNotesAssetIndex, ReleaseNotesManifest, StoryDeckCard } from './types';

function collectCardMediaKeys(card: StoryDeckCard): string[] {
    if (card.kind === 'image') {
        return card.media.key ? [card.media.key] : [];
    }
    if (card.kind === 'video') {
        return [card.media.key, card.media.posterKey].filter((key): key is string => typeof key === 'string');
    }
    return [];
}

export function collectReleaseNotesManifestMediaKeys(manifest: ReleaseNotesManifest): string[] {
    const keys = new Set<string>();
    for (const release of manifest.releases) {
        for (const card of release.cards) {
            for (const key of collectCardMediaKeys(card)) {
                keys.add(key.startsWith(`${release.releaseId}/`) ? key : `${release.releaseId}/${key}`);
            }
        }
    }
    return [...keys].sort();
}

export function findMissingReleaseNotesAssetKeys(
    manifest: ReleaseNotesManifest,
    assetIndex: ReleaseNotesAssetIndex,
): string[] {
    return collectReleaseNotesManifestMediaKeys(manifest).filter((key) => !assetIndex.assets[key]);
}

export function doesAssetIndexCoverReleaseNotesManifest(
    manifest: ReleaseNotesManifest,
    assetIndex: ReleaseNotesAssetIndex,
): boolean {
    return findMissingReleaseNotesAssetKeys(manifest, assetIndex).length === 0;
}
