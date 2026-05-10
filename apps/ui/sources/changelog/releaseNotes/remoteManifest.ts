import { commitRemoteAssetIndex } from './assetIndex';
import { doesAssetIndexCoverReleaseNotesManifest } from './manifestAssetCoverage';
import { commitRemoteManifest } from './manifestRuntime';
import {
    parseReleaseNotesAssetIndex,
    parseReleaseNotesManifest,
} from './schema';

const DEFAULT_REPO = 'happier-dev/happier-assets';
const DEFAULT_TAG = 'release-notes';
const DEFAULT_MANIFEST_FILE = 'release-notes__manifest.json';
const DEFAULT_ASSET_INDEX_FILE = 'release-notes__assets-index.json';
const FETCH_TIMEOUT_MS = 5_000;

export type ReleaseNotesRevalidationPart = Readonly<{
    committed: boolean;
    url: string;
}>;

export type ReleaseNotesRevalidationResult = Readonly<{
    manifest: ReleaseNotesRevalidationPart;
    assetIndex: ReleaseNotesRevalidationPart;
}>;

function resolveRemoteAssetFileUrl(fileName: string): string {
    const explicit =
        process.env.EXPO_PUBLIC_HAPPIER_RELEASE_NOTES_MANIFEST_URL?.trim() ?? '';
    if (fileName === DEFAULT_MANIFEST_FILE && explicit) {
        return explicit;
    }
    const repo =
        (process.env.EXPO_PUBLIC_HAPPIER_RELEASE_NOTES_ASSETS_REPO ?? DEFAULT_REPO).trim()
        || DEFAULT_REPO;
    const tag =
        (process.env.EXPO_PUBLIC_HAPPIER_RELEASE_NOTES_ASSETS_TAG ?? DEFAULT_TAG).trim()
        || DEFAULT_TAG;
    return `https://github.com/${repo}/releases/download/${tag}/${fileName}`;
}

function appendCacheBust(url: string): string {
    const trimmed = url.trim();
    if (!trimmed) return trimmed;
    const suffix = `happierCacheBust=${Date.now()}`;
    return trimmed.includes('?') ? `${trimmed}&${suffix}` : `${trimmed}?${suffix}`;
}

let inFlight: Promise<ReleaseNotesRevalidationResult> | null = null;

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Cold-launch revalidation: best-effort, non-fatal, single attempt per launch.
 * Returns whether the remote manifest and asset index were committed.
 */
export async function revalidateRemoteManifest(): Promise<ReleaseNotesRevalidationResult> {
    if (inFlight) return inFlight;
    const manifestUrl = appendCacheBust(resolveRemoteAssetFileUrl(DEFAULT_MANIFEST_FILE));
    const assetIndexUrl = appendCacheBust(resolveRemoteAssetFileUrl(DEFAULT_ASSET_INDEX_FILE));
    async function fetchText(url: string): Promise<string | null> {
        try {
            const response = await fetchWithTimeout(url, FETCH_TIMEOUT_MS);
            if (!response.ok) return null;
            return await response.text();
        } catch {
            return null;
        }
    }

    inFlight = (async () => {
        const [manifestText, assetIndexText] = await Promise.all([
            fetchText(manifestUrl),
            fetchText(assetIndexUrl),
        ]);
        if (!manifestText || !assetIndexText) {
            return {
                manifest: { committed: false, url: manifestUrl },
                assetIndex: { committed: false, url: assetIndexUrl },
            };
        }
        try {
            const manifest = parseReleaseNotesManifest(JSON.parse(manifestText));
            const assetIndex = parseReleaseNotesAssetIndex(JSON.parse(assetIndexText));
            if (!manifest || !assetIndex || !doesAssetIndexCoverReleaseNotesManifest(manifest, assetIndex)) {
                return {
                    manifest: { committed: false, url: manifestUrl },
                    assetIndex: { committed: false, url: assetIndexUrl },
                };
            }
        } catch {
            return {
                manifest: { committed: false, url: manifestUrl },
                assetIndex: { committed: false, url: assetIndexUrl },
            };
        }
        const committedManifest = commitRemoteManifest(manifestText);
        const committedAssetIndex = commitRemoteAssetIndex(assetIndexText);
        return {
            manifest: { committed: committedManifest != null, url: manifestUrl },
            assetIndex: { committed: committedAssetIndex != null, url: assetIndexUrl },
        };
    })();
    try {
        return await inFlight;
    } finally {
        // Allow another attempt next cold launch (or after manual reset in tests).
        inFlight = null;
    }
}

export function resetRemoteManifestForTests(): void {
    inFlight = null;
}
