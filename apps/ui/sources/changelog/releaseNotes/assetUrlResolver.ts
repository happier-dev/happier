import { getAssetIndex, lookupAsset } from './assetIndex';
import { getActiveManifest } from './manifestRuntime';
import type { ReleaseNotesMediaSource, ResolvedReleaseNotesMedia } from './types';

const DEFAULT_REPO = 'happier-dev/happier-assets';
const DEFAULT_TAG = 'release-notes';

function isDevMode(): boolean {
    return typeof __DEV__ !== 'undefined' && __DEV__ === true;
}

function getLocalAssetsBaseUrl(): string | null {
    const raw = process.env.EXPO_PUBLIC_HAPPIER_RELEASE_NOTES_LOCAL_ASSETS_BASE_URL;
    if (typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function getRemoteAssetsBaseUrl(): string {
    const index = getAssetIndex();
    if (index?.assetsBaseUrl) {
        return index.assetsBaseUrl;
    }
    const manifest = getActiveManifest();
    if (manifest?.assetBaseUrl) {
        return manifest.assetBaseUrl;
    }
    const repo =
        (process.env.EXPO_PUBLIC_HAPPIER_RELEASE_NOTES_ASSETS_REPO ?? DEFAULT_REPO).trim()
        || DEFAULT_REPO;
    const tag =
        (process.env.EXPO_PUBLIC_HAPPIER_RELEASE_NOTES_ASSETS_TAG ?? DEFAULT_TAG).trim()
        || DEFAULT_TAG;
    return `https://github.com/${repo}/releases/download/${tag}/`;
}

function ensureTrailingSlash(value: string): string {
    return value.endsWith('/') ? value : `${value}/`;
}

function appendVersionQuery(url: string, sha256: string | null): string {
    if (!sha256) return url;
    const prefix = sha256.slice(0, 12);
    return url.includes('?') ? `${url}&v=${prefix}` : `${url}?v=${prefix}`;
}

export type ResolvedAssetUrl = ResolvedReleaseNotesMedia;

/**
 * Resolve a media asset URL.
 *
 * Resolution rules:
 *  - Production / preview: remote URL only (no local probe latency).
 *  - Development: prefer local base URL when configured, fallback to remote on card-level failure.
 */
export function resolveAssetUrl(assetKey: string): ResolvedAssetUrl | null {
    const indexEntry = lookupAsset(assetKey);
    const sha256 = indexEntry?.sha256 ?? null;
    const fileName = indexEntry?.fileName ?? assetKey;

    const remoteBase = ensureTrailingSlash(getRemoteAssetsBaseUrl());
    const remoteUrl = appendVersionQuery(`${remoteBase}${encodeURIComponent(fileName)}`, sha256);

    if (isDevMode()) {
        const localBase = getLocalAssetsBaseUrl();
        if (localBase) {
            const local = ensureTrailingSlash(localBase);
            const localUrl = `${local}${encodeURIComponent(fileName)}`;
            const primary: ReleaseNotesMediaSource = { kind: 'local', uri: localUrl };
            const fallback: ReleaseNotesMediaSource = { kind: 'remote', uri: remoteUrl };
            return {
                primary,
                fallback,
                sources: [primary, fallback],
                url: primary.uri,
                fallbackUrl: fallback.uri,
                sha256,
            };
        }
    }

    const primary: ReleaseNotesMediaSource = { kind: 'remote', uri: remoteUrl };
    return {
        primary,
        fallback: null,
        sources: [primary],
        url: primary.uri,
        fallbackUrl: null,
        sha256,
    };
}
