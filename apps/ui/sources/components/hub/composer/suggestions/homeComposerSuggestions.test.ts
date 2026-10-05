import { describe, expect, it } from 'vitest';

import { deriveHomeComposerSuggestions, type HomeComposerSuggestionSession } from './homeComposerSuggestions';

// Wednesday 2026-09-30 15:00 local time.
const NOW = new Date(2026, 8, 30, 15, 0, 0).getTime();
const DAY = 24 * 60 * 60 * 1000;

function session(id: string, createdAt: number, path: string | null, machineId: string | null = 'machine-1', serverId = 'home-1'): HomeComposerSuggestionSession {
    return {
        id,
        serverId,
        createdAt,
        metadata: path === null ? null : { path, machineId: machineId ?? undefined, homeDir: '/Users/leeroy', host: 'mac' },
    };
}

describe('deriveHomeComposerSuggestions (session history)', () => {
    it('suggests summarizing the busiest recent project since its first session, placed where that work happened', () => {
        const suggestions = deriveHomeComposerSuggestions({
            nowMs: NOW,
            sessions: [
                // happier: three sessions, the first on Friday.
                session('a', new Date(2026, 8, 25, 10).getTime(), '~/code/happier'),
                session('b', new Date(2026, 8, 28, 9).getTime(), '/Users/leeroy/code/happier'),
                session('c', new Date(2026, 8, 30, 11).getTime(), '/Users/leeroy/code/happier/'),
                // website: two, more recent than happier's first but fewer.
                session('d', new Date(2026, 8, 29, 9).getTime(), '/Users/leeroy/code/website'),
                session('e', new Date(2026, 8, 30, 12).getTime(), '/Users/leeroy/code/website'),
                // Older than the week: never counted.
                session('old-1', NOW - 20 * DAY, '/Users/leeroy/code/website'),
                session('old-2', NOW - 21 * DAY, '/Users/leeroy/code/website'),
            ],
        });

        expect(suggestions).toHaveLength(3);
        expect(suggestions[0]).toMatchObject({
            source: 'sessionHistory',
            project: 'happier',
            sessionCount: 3,
            since: { kind: 'weekday', atMs: new Date(2026, 8, 25, 10).getTime() },
            fill: {
                placement: { serverId: 'home-1', machineId: 'machine-1', directory: '/Users/leeroy/code/happier' },
            },
        });
    });

    it('says today or yesterday instead of a weekday for the last two days', () => {
        const today = deriveHomeComposerSuggestions({
            nowMs: NOW,
            sessions: [session('a', new Date(2026, 8, 30, 8).getTime(), '/w/app'), session('b', NOW - 60_000, '/w/app')],
        });
        expect(today[0]).toMatchObject({ since: { kind: 'today' } });

        const yesterday = deriveHomeComposerSuggestions({
            nowMs: NOW,
            sessions: [session('a', new Date(2026, 8, 29, 23).getTime(), '/w/app'), session('b', NOW - 60_000, '/w/app')],
        });
        expect(yesterday[0]).toMatchObject({ since: { kind: 'yesterday' } });
    });

    it('keeps the same folder on two machines (or two Homes) as separate projects', () => {
        const suggestions = deriveHomeComposerSuggestions({
            nowMs: NOW,
            sessions: [
                session('a', NOW - DAY, '/w/app', 'machine-1'),
                session('b', NOW - DAY, '/w/app', 'machine-2'),
                session('c', NOW - 2 * DAY, '/w/app', 'machine-2'),
            ],
        });
        expect(suggestions[0]).toMatchObject({ sessionCount: 2, fill: { placement: { machineId: 'machine-2' } } });
    });

    it('offers starter prompts without invented history or placement when there is no recent project', () => {
        const starters = deriveHomeComposerSuggestions({ nowMs: NOW, sessions: [] });
        expect(starters.map((entry) => entry.id)).toEqual(['starter:explain', 'starter:fixTest']);
        expect(starters.every((entry) => entry.source === 'starter' && entry.fill.placement === null)).toBe(true);
        expect(deriveHomeComposerSuggestions({
            nowMs: NOW,
            sessions: [session('a', NOW - DAY, null), session('b', NOW - DAY, '/w/app', null), session('c', NOW - 30 * DAY, '/w/app')],
        })).toEqual(starters);
    });

    it('offers automation authoring only when the Home supports Automations', () => {
        const suggestions = deriveHomeComposerSuggestions({ nowMs: NOW, sessions: [], automationsEnabled: true });
        expect(suggestions.map((entry) => entry.id)).toEqual(['starter:explain', 'starter:fixTest', 'starter:automation']);
    });
});
