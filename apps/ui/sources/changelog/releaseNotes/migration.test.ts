import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runReleaseNotesMigrationSeeding } from './migration';

const legacyState = vi.hoisted(() => ({
    lastViewedReleaseId: null as string | null,
}));

const manifestState = vi.hoisted(() => ({
    currentEntry: null as { releaseId: string } | null,
}));

const storageState = vi.hoisted(() => ({
    lastSeenReleaseId: null as string | null,
    migrationSeededReleaseId: null as string | null,
    legacyChangelogAutoSeenBaseline: null as string | null,
    setLastSeen: vi.fn<(id: string) => void>(),
    setMigrationSeeded: vi.fn<(id: string) => void>(),
}));

vi.mock('@/changelog', () => ({
    getLastViewedReleaseId: () => legacyState.lastViewedReleaseId,
}));

vi.mock('./manifestRuntime', () => ({
    getCurrentReleaseEntry: () => manifestState.currentEntry,
}));

vi.mock('./storage', () => ({
    getLastSeenReleaseId: () => storageState.lastSeenReleaseId,
    getMigrationSeededReleaseId: () => storageState.migrationSeededReleaseId,
    getLegacyChangelogAutoSeenBaseline: () => storageState.legacyChangelogAutoSeenBaseline,
    setLastSeenReleaseId: (id: string) => {
        storageState.setLastSeen(id);
        storageState.lastSeenReleaseId = id;
    },
    setMigrationSeededReleaseId: (id: string) => {
        storageState.setMigrationSeeded(id);
        storageState.migrationSeededReleaseId = id;
    },
}));

describe('runReleaseNotesMigrationSeeding (dev release-id model)', () => {
    beforeEach(() => {
        legacyState.lastViewedReleaseId = null;
        manifestState.currentEntry = null;
        storageState.lastSeenReleaseId = null;
        storageState.migrationSeededReleaseId = null;
        storageState.legacyChangelogAutoSeenBaseline = null;
        storageState.setLastSeen.mockReset();
        storageState.setMigrationSeeded.mockReset();
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    it('does nothing when there is no current release', () => {
        runReleaseNotesMigrationSeeding();
        expect(storageState.setLastSeen).not.toHaveBeenCalled();
        expect(storageState.setMigrationSeeded).not.toHaveBeenCalled();
    });

    it('does nothing when a release-notes seen marker already exists', () => {
        manifestState.currentEntry = { releaseId: 'v1.0.0' };
        storageState.lastSeenReleaseId = 'something';
        runReleaseNotesMigrationSeeding();
        expect(storageState.setLastSeen).not.toHaveBeenCalled();
    });

    it('marks the current release as seen for legacy string users who already viewed changelog updates', () => {
        manifestState.currentEntry = { releaseId: 'v1.0.0' };
        legacyState.lastViewedReleaseId = 'ui-v0.5.0';
        runReleaseNotesMigrationSeeding();
        expect(storageState.setLastSeen).toHaveBeenCalledWith('v1.0.0');
        expect(storageState.setMigrationSeeded).toHaveBeenCalledWith('v1.0.0');
    });

    it('does not seed for fresh installs (legacy id null)', () => {
        manifestState.currentEntry = { releaseId: 'v1.0.0' };
        legacyState.lastViewedReleaseId = null;
        runReleaseNotesMigrationSeeding();
        expect(storageState.setLastSeen).not.toHaveBeenCalled();
        expect(storageState.setMigrationSeeded).toHaveBeenCalledWith('v1.0.0');
    });

    it('does not mark seen when legacy changelog was auto-marked for a fresh install', () => {
        manifestState.currentEntry = { releaseId: 'v1.0.0' };
        legacyState.lastViewedReleaseId = '0.2.1';
        storageState.legacyChangelogAutoSeenBaseline = '0.2.1';
        runReleaseNotesMigrationSeeding();
        expect(storageState.setLastSeen).not.toHaveBeenCalled();
        expect(storageState.setMigrationSeeded).toHaveBeenCalledWith('v1.0.0');
    });

    it('is idempotent across runs for the same baseline', () => {
        manifestState.currentEntry = { releaseId: 'v1.0.0' };
        legacyState.lastViewedReleaseId = 'ui-v0.5.0';
        runReleaseNotesMigrationSeeding();
        expect(storageState.setMigrationSeeded).toHaveBeenCalledTimes(1);
        runReleaseNotesMigrationSeeding();
        expect(storageState.setMigrationSeeded).toHaveBeenCalledTimes(1);
        expect(storageState.setLastSeen).toHaveBeenCalledTimes(1);
    });
});
