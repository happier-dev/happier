import { ChangelogData, ChangelogEntry } from './types';

// This will be populated by the build-time script
let changelogData: ChangelogData | null = null;

export function getChangelogData(): ChangelogData {
    if (!changelogData) {
        // Fallback to require the generated JSON file
        try {
            changelogData = require('./changelog.json') as ChangelogData;
        } catch (error) {
            console.warn('Changelog data not found, returning empty changelog');
            changelogData = { entries: [], latestReleaseId: null };
        }
    }
    return changelogData;
}

export function getChangelogEntries(): ChangelogEntry[] {
    return getChangelogData().entries;
}

export function getLatestReleaseId(): string | null {
    return getChangelogData().latestReleaseId;
}

export function getUnreadEntries(lastViewedReleaseId: string | null): ChangelogEntry[] {
    const entries = getChangelogEntries();
    const lastViewedIndex = entries.findIndex((entry) => entry.id === lastViewedReleaseId);
    return lastViewedIndex < 0 ? entries : entries.slice(0, lastViewedIndex);
}
