import type {
    ReleaseNotesAssetIndex,
    ReleaseNotesManifest,
    StoryDeckCard,
    StoryDeckImageMedia,
    StoryDeckVideoMedia,
} from './types';

function collectImageMediaKeys(media: StoryDeckImageMedia): string[] {
    return [
        media.key,
        media.mobile?.key,
        media.desktop?.key,
    ].filter((key): key is string => typeof key === 'string');
}

function collectVideoMediaKeys(media: StoryDeckVideoMedia): string[] {
    return [
        media.key,
        media.posterKey,
        media.mobile?.key,
        media.mobile?.posterKey,
        media.desktop?.key,
        media.desktop?.posterKey,
    ].filter((key): key is string => typeof key === 'string');
}

function collectCardMediaKeys(card: StoryDeckCard): string[] {
    if (card.kind === 'image') {
        return collectImageMediaKeys(card.media);
    }
    if (card.kind === 'video') {
        return collectVideoMediaKeys(card.media);
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
