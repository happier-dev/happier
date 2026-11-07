import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Constants from 'expo-constants';
import { MMKV } from 'react-native-mmkv';

import { setLastViewedReleaseId } from '@/changelog';
import { commitRemoteManifest, resetManifestRuntimeCacheForTests } from './manifestRuntime';
import { runReleaseNotesMigrationSeeding } from './migration';
import {
    getLastSeenReleaseId, getMigrationSeededReleaseId,
    setLastSeenReleaseId, setLegacyChangelogAutoSeenBaseline,
} from './storage';
import type { ReleaseNotesManifest } from './types';

const originalExpoConfig = Constants.expoConfig;

const manifest = {
    schemaVersion: 'v1', latestReleaseId: 'v0.0.0', generatedAt: '2026-02-15',
    assetBaseUrl: 'https://example.test/',
    releases: [{
        releaseId: 'v0.0.0', versionLabel: '0.0.0', publishedAt: '2026-02-15', titleKey: 'release.title',
        cards: [{ kind: 'list', titleKey: 'release.card', rows: [{ iconId: 'sparkles', titleKey: 'release.row', bodyKey: 'release.body' }] }],
    }],
} satisfies ReleaseNotesManifest;

describe('runReleaseNotesMigrationSeeding', () => {
    beforeEach(() => {
        Object.defineProperty(Constants, 'expoConfig', { configurable: true, value: { ...originalExpoConfig, version: '0.0.0' } });
        new MMKV().clearAll();
        resetManifestRuntimeCacheForTests();
        expect(commitRemoteManifest(JSON.stringify(manifest))).not.toBeNull();
    });

    afterEach(() => {
        Object.defineProperty(Constants, 'expoConfig', { configurable: true, value: originalExpoConfig });
    });

    it('does nothing without a matching installed release or when already acknowledged', () => {
        commitRemoteManifest(JSON.stringify({ ...manifest, releases: [] }));
        runReleaseNotesMigrationSeeding();
        expect(getMigrationSeededReleaseId()).toBeNull();
        commitRemoteManifest(JSON.stringify(manifest));
        setLastSeenReleaseId('already-seen');
        runReleaseNotesMigrationSeeding();
        expect(getLastSeenReleaseId()).toBe('already-seen');
        expect(getMigrationSeededReleaseId()).toBeNull();
    });

    it.each(['numeric', 'release-id'] as const)('preserves explicit acknowledgements from %s history', (format) => {
        if (format === 'numeric') new MMKV().set('changelog-last-viewed-version', 1);
        else setLastViewedReleaseId('2026-09-29.2');
        runReleaseNotesMigrationSeeding();
        expect(getLastSeenReleaseId()).toBe('v0.0.0');
        expect(getMigrationSeededReleaseId()).toBe('v0.0.0');
    });

    it.each([null, '1', '2026-09-29.2'])('keeps fresh-install stories available with baseline %s', (baseline) => {
        if (baseline === '1') new MMKV().set('changelog-last-viewed-version', 1);
        else if (baseline) setLastViewedReleaseId(baseline);
        if (baseline) setLegacyChangelogAutoSeenBaseline(baseline);
        runReleaseNotesMigrationSeeding();
        expect(getLastSeenReleaseId()).toBeNull();
        expect(getMigrationSeededReleaseId()).toBe('v0.0.0');
        setLastViewedReleaseId('another-release');
        runReleaseNotesMigrationSeeding();
        expect(getLastSeenReleaseId()).toBeNull();
    });
});
