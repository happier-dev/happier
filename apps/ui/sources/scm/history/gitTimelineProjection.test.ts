import { describe, expect, it } from 'vitest';
import type { ScmLogEntry } from '@happier-dev/protocol/scm';
import { projectGitTimeline, selectScmIncomingLogEntries } from './gitTimelineProjection';

const commit = (sha: string, timestamp: number): ScmLogEntry => ({
    sha, shortSha: sha.slice(0, 7), authorName: 'Ada', authorEmail: 'ada@example.com',
    timestamp, subject: `Commit ${sha}`, body: '',
});

describe('projectGitTimeline', () => {
    it('accepts incoming entries only when the daemon acknowledges the range', () => {
        const entries = [commit('incoming', Date.now())];
        expect(selectScmIncomingLogEntries({ success: true, entries })).toBeNull();
        expect(selectScmIncomingLogEntries({ success: true, entries, rangeApplied: true })).toEqual(entries);
    });
    it('places a diverged origin at the incoming tip, marks incoming commits, and groups by local calendar day', () => {
        const now = new Date(2026, 8, 30, 13, 0).getTime();
        const today = new Date(2026, 8, 30, 10, 0).getTime();
        const yesterday = new Date(2026, 8, 29, 23, 0).getTime();
        const timeline = projectGitTimeline({
            now, changedCount: 3, ahead: 2, behind: 1, upstream: 'origin/feature',
            current: [commit('local-2', today), commit('local-1', today - 1), commit('shared', yesterday)],
            incoming: [commit('incoming', today + 1)],
        });

        expect(timeline.now).toEqual({ changedCount: 3 });
        expect(timeline.origin).toEqual({ kind: 'incoming', sha: 'incoming', name: 'origin/feature' });
        expect(timeline.groups.map((group) => group.label)).toEqual(['earlier-today', 'yesterday']);
        expect(timeline.groups[0]?.commits.map((item) => [item.sha, item.relation])).toEqual([
            ['incoming', 'incoming'], ['local-2', 'local'], ['local-1', 'local'],
        ]);
        expect(timeline.groups[1]?.commits[0]).toMatchObject({ sha: 'shared', relation: 'shared', authorName: 'Ada' });
        expect(timeline.incomingAvailable).toBe(true);
    });

    it('does not imply an origin marker or complete incoming list when upstream data is unavailable', () => {
        const timeline = projectGitTimeline({ now: Date.now(), changedCount: 0, ahead: 5, behind: 2,
            upstream: null, current: [commit('head', Date.now())], incoming: null });
        expect(timeline.origin).toBeNull();
        expect(timeline.incomingAvailable).toBe(false);
    });

    it('leaves a marker beyond loaded history when behind commits are not available', () => {
        const timeline = projectGitTimeline({ now: Date.now(), changedCount: 0, ahead: 1, behind: 2,
            upstream: 'origin/main', current: [commit('local', Date.now())], incoming: null });
        expect(timeline.origin).toEqual({ kind: 'beyond-loaded', name: 'origin/main' });
    });

    it('keeps incoming commits above the current branch even when commit clocks are skewed', () => {
        const now = new Date(2026, 8, 30, 13, 0).getTime();
        const timeline = projectGitTimeline({
            now, changedCount: 0, ahead: 0, behind: 1, upstream: 'origin/main',
            current: [commit('head', new Date(2026, 8, 30, 12, 0).getTime())],
            incoming: [commit('incoming', new Date(2026, 8, 29, 23, 0).getTime())],
        });
        expect(timeline.groups.flatMap((group) => group.commits.map((item) => item.sha))).toEqual(['incoming', 'head']);
    });
});
