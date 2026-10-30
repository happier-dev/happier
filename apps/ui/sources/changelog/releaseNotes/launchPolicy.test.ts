import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Constants from 'expo-constants';

import { resolveReleaseNotesLaunchOutcome } from './launchPolicy';
import { commitRemoteManifest, getCurrentReleaseEntry, resetManifestRuntimeCacheForTests } from './manifestRuntime';
import { clearCachedManifest, clearLastSeenReleaseId, setLastSeenReleaseId } from './storage';

const originalExpoConfig = Constants.expoConfig;

function manifestJson(releaseId: string, cardCount = 1): string {
    // Network-shaped input enters through the real schema/persistence owner.
    return JSON.stringify({
        schemaVersion: 'v1',
        latestReleaseId: releaseId,
        generatedAt: '2026-01-01T00:00:00.000Z',
        assetBaseUrl: 'https://cdn.example/releases/',
        releases: [{
            releaseId,
            versionLabel: releaseId,
            publishedAt: '2026-01-01T00:00:00.000Z',
            titleKey: 'releaseNotes.title',
            cards: Array.from({ length: cardCount }, (_, i) => ({
                kind: 'list',
                titleKey: `releaseNotes.cards.${i}.title`,
                rows: [{ iconId: 'sparkles', titleKey: 'a', bodyKey: 'b' }],
            })),
        }],
    });
}

describe('resolveReleaseNotesLaunchOutcome', () => {
    beforeEach(() => {
        // Installed app version is an Expo/platform boundary, not a fake release selector.
        Object.defineProperty(Constants, 'expoConfig', { configurable: true, value: { ...originalExpoConfig, version: '1.0.0' } });
        clearLastSeenReleaseId();
        clearCachedManifest();
        resetManifestRuntimeCacheForTests();
    });

    afterEach(() => {
        clearLastSeenReleaseId();
        clearCachedManifest();
        resetManifestRuntimeCacheForTests();
        Object.defineProperty(Constants, 'expoConfig', { configurable: true, value: originalExpoConfig });
    });

    it('returns none when there is no current release', () => {
        expect(commitRemoteManifest(manifestJson('v0.9.0'))).not.toBeNull();
        expect(getCurrentReleaseEntry()).toBeNull();
        expect(resolveReleaseNotesLaunchOutcome().kind).toBe('none');
    });

    it('does not admit or launch a current release with no cards', () => {
        expect(commitRemoteManifest(manifestJson('v0.9.0'))).not.toBeNull();
        expect(commitRemoteManifest(manifestJson('v1.0.0', 0))).toBeNull();
        expect(getCurrentReleaseEntry()).toBeNull();
        expect(resolveReleaseNotesLaunchOutcome().kind).toBe('none');

        expect(commitRemoteManifest(manifestJson('v1.0.0'))).not.toBeNull();
        expect(resolveReleaseNotesLaunchOutcome()).toMatchObject({ kind: 'open-story', release: { releaseId: 'v1.0.0' } });
    });

    it('returns open-story when there is unread current release', () => {
        expect(commitRemoteManifest(manifestJson('v1.0.0'))).not.toBeNull();
        const outcome = resolveReleaseNotesLaunchOutcome();
        expect(outcome).toMatchObject({ kind: 'open-story', release: { releaseId: 'v1.0.0', cards: [{ titleKey: 'releaseNotes.cards.0.title' }] } });
    });

    it('returns none when the current release is already seen', () => {
        expect(commitRemoteManifest(manifestJson('v1.0.0'))).not.toBeNull();
        setLastSeenReleaseId('v1.0.0');
        expect(resolveReleaseNotesLaunchOutcome().kind).toBe('none');
    });

    it('returns open-story when the seen marker is for an older release', () => {
        expect(commitRemoteManifest(manifestJson('v1.0.0'))).not.toBeNull();
        setLastSeenReleaseId('v0.9.0');
        const outcome = resolveReleaseNotesLaunchOutcome();
        expect(outcome).toMatchObject({ kind: 'open-story', release: { releaseId: 'v1.0.0' } });
    });
});
