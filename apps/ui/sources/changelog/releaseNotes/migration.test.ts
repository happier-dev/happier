import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Constants from 'expo-constants';

import { setLastViewedReleaseId } from '@/changelog/storage';
import { resetMmkvStoresForTests } from '@/dev/reactNativeMmkvStub';

import { commitRemoteManifest, getCurrentReleaseEntry, resetManifestRuntimeCacheForTests } from './manifestRuntime';
import { runReleaseNotesMigrationSeeding } from './migration';
import {
    getLastSeenReleaseId,
    getMigrationSeededReleaseId,
    getReleaseNotesRuntimeVersion,
    setLastSeenReleaseId,
    setLegacyChangelogAutoSeenBaseline,
    setMigrationSeededReleaseId,
} from './storage';

const originalExpoConfig = Constants.expoConfig;

function admitRelease(releaseId = 'v1.0.0'): void {
    expect(commitRemoteManifest(JSON.stringify({
        schemaVersion: 'v1',
        latestReleaseId: releaseId,
        generatedAt: '2026-01-01T00:00:00.000Z',
        assetBaseUrl: 'https://cdn.example/releases/',
        releases: [{
            releaseId,
            versionLabel: releaseId,
            publishedAt: '2026-01-01T00:00:00.000Z',
            titleKey: 'releaseNotes.title',
            cards: [{
                kind: 'list',
                titleKey: 'releaseNotes.card.title',
                rows: [{ iconId: 'sparkles', titleKey: 'releaseNotes.row.title', bodyKey: 'releaseNotes.row.body' }],
            }],
        }],
    }))).not.toBeNull();
}

describe('runReleaseNotesMigrationSeeding (dev release-id model)', () => {
    beforeEach(() => {
        // Reset only the native persistence boundary; migration and both stores stay real.
        resetMmkvStoresForTests();
        resetManifestRuntimeCacheForTests();
        Object.defineProperty(Constants, 'expoConfig', { configurable: true, value: { ...originalExpoConfig, version: '1.0.0' } });
    });

    afterEach(() => {
        resetMmkvStoresForTests();
        resetManifestRuntimeCacheForTests();
        Object.defineProperty(Constants, 'expoConfig', { configurable: true, value: originalExpoConfig });
    });

    it('does nothing when there is no current release', () => {
        admitRelease('v0.9.0');
        setLastViewedReleaseId('ui-v0.5.0');
        expect(getCurrentReleaseEntry()).toBeNull();
        const before = getReleaseNotesRuntimeVersion();
        runReleaseNotesMigrationSeeding();
        expect(getLastSeenReleaseId()).toBeNull();
        expect(getMigrationSeededReleaseId()).toBeNull();
        expect(getReleaseNotesRuntimeVersion()).toBe(before);
    });

    it('does nothing when a release-notes seen marker already exists', () => {
        admitRelease();
        setLastSeenReleaseId('existing-seen-release');
        setMigrationSeededReleaseId('v0.9.0');
        setLastViewedReleaseId('ui-v0.5.0');
        const before = getReleaseNotesRuntimeVersion();
        runReleaseNotesMigrationSeeding();
        expect(getLastSeenReleaseId()).toBe('existing-seen-release');
        expect(getMigrationSeededReleaseId()).toBe('v0.9.0');
        expect(getReleaseNotesRuntimeVersion()).toBe(before);
    });

    it('marks the current release as seen for legacy string users who already viewed changelog updates', () => {
        admitRelease();
        setLastViewedReleaseId('ui-v0.5.0');
        runReleaseNotesMigrationSeeding();
        expect(getLastSeenReleaseId()).toBe('v1.0.0');
        expect(getMigrationSeededReleaseId()).toBe('v1.0.0');
    });

    it('does not seed for fresh installs (legacy id null)', () => {
        admitRelease();
        runReleaseNotesMigrationSeeding();
        expect(getLastSeenReleaseId()).toBeNull();
        expect(getMigrationSeededReleaseId()).toBe('v1.0.0');
    });

    it('does not mark seen when legacy changelog was auto-marked for a fresh install', () => {
        admitRelease();
        setLastViewedReleaseId('0.2.1');
        setLegacyChangelogAutoSeenBaseline('0.2.1');
        runReleaseNotesMigrationSeeding();
        expect(getLastSeenReleaseId()).toBeNull();
        expect(getMigrationSeededReleaseId()).toBe('v1.0.0');
    });

    it('is idempotent across runs for the same baseline', () => {
        admitRelease();
        const before = getReleaseNotesRuntimeVersion();
        runReleaseNotesMigrationSeeding();
        expect(getLastSeenReleaseId()).toBeNull();
        expect(getMigrationSeededReleaseId()).toBe('v1.0.0');
        const afterFirst = getReleaseNotesRuntimeVersion();
        expect(afterFirst).toBeGreaterThan(before);

        // Keep seen null: the second run must hit the baseline guard, not the seen guard.
        setLastViewedReleaseId('ui-v0.5.0');
        runReleaseNotesMigrationSeeding();
        expect(getLastSeenReleaseId()).toBeNull();
        expect(getMigrationSeededReleaseId()).toBe('v1.0.0');
        expect(getReleaseNotesRuntimeVersion()).toBe(afterFirst);
    });
});
