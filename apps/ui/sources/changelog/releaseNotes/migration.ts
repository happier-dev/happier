import { getLastViewedReleaseId } from '@/changelog';

import { getCurrentReleaseEntry } from './manifestRuntime';
import {
    getLastSeenReleaseId,
    getLegacyChangelogAutoSeenBaseline,
    getMigrationSeededReleaseId,
    setLastSeenReleaseId,
    setMigrationSeededReleaseId,
} from './storage';

/**
 * Seed `release-notes-last-seen-release-id` for users who already saw the legacy
 * release-id-based changelog UI, so we do not retroactively show them release-notes
 * story cards they have already implicitly acknowledged.
 *
 * Rules:
 *  - Run at most once per release id baseline (idempotent).
 *  - If the user already has a release-notes seen marker, do nothing.
 *  - Legacy users who already viewed changelog updates get the current curated
 *    release marked as seen so release notes do not appear retroactively.
 *  - Fresh installs only record the migration baseline, preserving the first
 *    curated story intended for the installed app version.
 */
export function runReleaseNotesMigrationSeeding(): void {
    const existingReleaseSeen = getLastSeenReleaseId();
    if (existingReleaseSeen) {
        return; // already initialized; nothing to migrate.
    }
    const currentEntry = getCurrentReleaseEntry();
    if (!currentEntry) {
        return; // no current release in manifest; nothing to seed.
    }
    if (getMigrationSeededReleaseId() === currentEntry.releaseId) {
        return; // already ran for this baseline.
    }

    const legacyLastViewedReleaseId = getLastViewedReleaseId();
    const wasAutoSeenForFreshInstall =
        legacyLastViewedReleaseId != null
        && getLegacyChangelogAutoSeenBaseline() === legacyLastViewedReleaseId;
    if (legacyLastViewedReleaseId && !wasAutoSeenForFreshInstall) {
        setLastSeenReleaseId(currentEntry.releaseId);
    }
    setMigrationSeededReleaseId(currentEntry.releaseId);
}
