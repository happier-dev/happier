import Constants from 'expo-constants';

import bundledManifestRaw from './manifest.generated.json';
import {
    parseReleaseNotesManifest,
} from './schema';
import {
    emitReleaseNotesRuntimeChanged,
    getCachedManifestRaw,
    setCachedManifestRaw,
} from './storage';
import type { ReleaseNotesManifest, ReleaseNotesRelease } from './types';

let inMemoryManifest: ReleaseNotesManifest | null | undefined = undefined;

function loadInitialManifest(): ReleaseNotesManifest | null {
    // Prefer cached remote manifest if it parses; fall back to bundled.
    const cached = getCachedManifestRaw();
    if (cached) {
        try {
            const parsed = parseReleaseNotesManifest(JSON.parse(cached));
            if (parsed) return parsed;
        } catch {
            // fall through to bundled
        }
    }
    return parseReleaseNotesManifest(bundledManifestRaw);
}

export function getActiveManifest(): ReleaseNotesManifest | null {
    if (inMemoryManifest === undefined) {
        inMemoryManifest = loadInitialManifest();
    }
    return inMemoryManifest;
}

export function commitRemoteManifest(rawJsonText: string): ReleaseNotesManifest | null {
    let parsed: ReleaseNotesManifest | null = null;
    try {
        parsed = parseReleaseNotesManifest(JSON.parse(rawJsonText));
    } catch {
        parsed = null;
    }
    if (!parsed) {
        return null;
    }
    setCachedManifestRaw(rawJsonText);
    inMemoryManifest = parsed;
    emitReleaseNotesRuntimeChanged();
    return parsed;
}

export function resetManifestRuntimeCacheForTests(): void {
    inMemoryManifest = undefined;
}

/**
 * Resolve the current "release id" for the installed app.
 *
 * Convention: `v<semverlike-version>` derived from `Constants.expoConfig?.version`.
 * Authors must use the same convention in their release source files.
 */
export function getCurrentReleaseId(): string | null {
    const rawVersion =
        (Constants?.expoConfig as { version?: string } | null | undefined)?.version
        ?? (Constants as unknown as { manifest?: { version?: string } } | null | undefined)?.manifest?.version
        ?? null;
    if (!rawVersion || typeof rawVersion !== 'string') {
        return null;
    }
    const trimmed = rawVersion.trim();
    if (!trimmed) {
        return null;
    }
    return trimmed.startsWith('v') ? trimmed : `v${trimmed}`;
}

export function findReleaseForId(
    manifest: ReleaseNotesManifest | null,
    releaseId: string | null,
): ReleaseNotesRelease | null {
    if (!manifest || !releaseId) return null;
    const found = manifest.releases.find((release) => release.releaseId === releaseId);
    return found ?? null;
}

export function getCurrentReleaseEntry(): ReleaseNotesRelease | null {
    const manifest = getActiveManifest();
    const releaseId = getCurrentReleaseId();
    return findReleaseForId(manifest, releaseId);
}
