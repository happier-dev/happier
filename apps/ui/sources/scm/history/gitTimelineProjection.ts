import type { ScmLogEntry, ScmLogListResponse } from '@happier-dev/protocol/scm';

/** An older daemon may ignore `range: incoming`; never show its current-branch page as commits to pull. */
export function selectScmIncomingLogEntries(response: ScmLogListResponse): readonly ScmLogEntry[] | null {
    return response.success && response.rangeApplied === true ? response.entries ?? [] : null;
}

export type GitTimelineCommit = Pick<ScmLogEntry, 'sha' | 'shortSha' | 'authorName' | 'timestamp' | 'subject'> & {
    relation: 'local' | 'shared' | 'incoming';
};
export type GitTimelineGroup = Readonly<{
    label: 'earlier-today' | 'yesterday' | 'older';
    commits: readonly GitTimelineCommit[];
}>;
export type GitTimeline = Readonly<{
    now: { changedCount: number };
    origin: { kind: 'at-head' | 'after' | 'incoming' | 'beyond-loaded'; name: string; sha?: string } | null;
    groups: readonly GitTimelineGroup[];
    incomingAvailable: boolean;
}>;

export function projectGitTimeline(input: Readonly<{
    now: number;
    changedCount: number;
    ahead: number;
    behind: number;
    upstream: string | null;
    current: readonly ScmLogEntry[];
    incoming: readonly ScmLogEntry[] | null;
}>): GitTimeline {
    const origin: GitTimeline['origin'] = !input.upstream
        ? null
        : input.behind > 0
            ? input.incoming?.[0]
                ? { kind: 'incoming', sha: input.incoming[0].sha, name: input.upstream }
                : { kind: 'beyond-loaded', name: input.upstream }
        : input.ahead === 0
            ? { kind: 'at-head', name: input.upstream }
            : input.current[input.ahead - 1]
                ? { kind: 'after', sha: input.current[input.ahead - 1].sha, name: input.upstream }
                : { kind: 'beyond-loaded', name: input.upstream };

    const current: GitTimelineCommit[] = input.current.map((entry, index) => ({
        sha: entry.sha, shortSha: entry.shortSha, subject: entry.subject,
        authorName: entry.authorName, timestamp: entry.timestamp,
        relation: index < input.ahead ? 'local' : 'shared',
    }));
    const currentShas = new Set(current.map((entry) => entry.sha));
    const incoming: GitTimelineCommit[] = (input.incoming ?? [])
        .filter((entry) => !currentShas.has(entry.sha))
        .map((entry) => ({
            sha: entry.sha, shortSha: entry.shortSha, subject: entry.subject,
            authorName: entry.authorName, timestamp: entry.timestamp,
            relation: 'incoming',
        }));

    const now = new Date(input.now);
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const yesterdayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).getTime();
    const groups: Array<{ label: GitTimelineGroup['label']; commits: GitTimelineCommit[] }> = [];
    for (const commit of [...incoming, ...current]) {
        const label = commit.timestamp >= todayStart ? 'earlier-today'
            : commit.timestamp >= yesterdayStart ? 'yesterday' : 'older';
        const last = groups[groups.length - 1];
        if (last?.label === label) last.commits.push(commit);
        else groups.push({ label, commits: [commit] });
    }
    return {
        now: { changedCount: input.changedCount },
        origin,
        groups,
        incomingAvailable: input.behind === 0 || input.incoming !== null,
    };
}
