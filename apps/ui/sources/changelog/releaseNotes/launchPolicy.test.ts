import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveReleaseNotesLaunchOutcome } from './launchPolicy';

const manifestState = vi.hoisted(() => ({
    currentEntry: null as ReturnType<typeof makeRelease> | null,
}));

const storageState = vi.hoisted(() => ({
    lastSeen: null as string | null,
}));

vi.mock('./manifestRuntime', () => ({
    getCurrentReleaseEntry: () => manifestState.currentEntry,
    getActiveManifest: () => null,
    getCurrentReleaseId: () => manifestState.currentEntry?.releaseId ?? null,
    findReleaseForId: () => null,
}));

vi.mock('./storage', () => ({
    getLastSeenReleaseId: () => storageState.lastSeen,
    setLastSeenReleaseId: vi.fn(),
    getMigrationSeededReleaseId: () => null,
    setMigrationSeededReleaseId: vi.fn(),
}));

function makeRelease(releaseId: string, cardCount = 1) {
    return {
        releaseId,
        versionLabel: releaseId,
        publishedAt: '2026-01-01T00:00:00.000Z',
        titleKey: 'releaseNotes.title',
        cards: Array.from({ length: cardCount }).map((_, i) => ({
            kind: 'list' as const,
            titleKey: `releaseNotes.cards.${i}.title`,
            rows: [{ iconId: 'sparkles', titleKey: 'a', bodyKey: 'b' }],
        })),
    };
}

describe('resolveReleaseNotesLaunchOutcome', () => {
    beforeEach(() => {
        manifestState.currentEntry = null;
        storageState.lastSeen = null;
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    it('returns none when there is no current release', () => {
        manifestState.currentEntry = null;
        expect(resolveReleaseNotesLaunchOutcome().kind).toBe('none');
    });

    it('returns none when the current release has no cards', () => {
        manifestState.currentEntry = makeRelease('v1.0.0', 0);
        expect(resolveReleaseNotesLaunchOutcome().kind).toBe('none');
    });

    it('returns open-story when there is unread current release', () => {
        manifestState.currentEntry = makeRelease('v1.0.0');
        storageState.lastSeen = null;
        const outcome = resolveReleaseNotesLaunchOutcome();
        expect(outcome.kind).toBe('open-story');
    });

    it('returns none when the current release is already seen', () => {
        manifestState.currentEntry = makeRelease('v1.0.0');
        storageState.lastSeen = 'v1.0.0';
        expect(resolveReleaseNotesLaunchOutcome().kind).toBe('none');
    });

    it('returns open-story when the seen marker is for an older release', () => {
        manifestState.currentEntry = makeRelease('v1.1.0');
        storageState.lastSeen = 'v1.0.0';
        const outcome = resolveReleaseNotesLaunchOutcome();
        expect(outcome.kind).toBe('open-story');
    });
});
