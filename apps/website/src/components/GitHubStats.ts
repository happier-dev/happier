import { readCount, statsUrl, usePublicStat } from './publicStats';

/**
 * Repo counters, read the same way downloads and Discord members are.
 *
 * Nav.tsx called `api.github.com/repos/happier-dev/happier` directly from every
 * visitor's browser. Two problems with that, and DiscordMembers already
 * documents both in its own header comment:
 *
 *   - it hands every visitor's IP to GitHub just for loading a marketing page,
 *     which is a strange thing for the page selling end-to-end encryption to do;
 *   - unauthenticated api.github.com is 60 requests/hour per IP. Behind one
 *     office NAT or one CGNAT range the star count silently disappears, and
 *     there is no way to tell that from "the repo has no stars".
 *
 * Publishing github.json next to downloads.json and discord.json fixes both.
 * The publisher that already writes those two needs one more field group:
 *
 *     { "schemaVersion": 1, "generatedAt": "…",
 *       "stars": 1445, "forks": 122, "contributors": 71 }
 *
 * Until that document exists the fallbacks below render, which is the same
 * degradation every other counter on the page has.
 */

/** Measured 2026-08-08 via api.github.com; only shown until github.json loads. */
export const FALLBACK_GITHUB_STATS = {
    stars: 1445,
    forks: 122,
    contributors: 71,
} as const;

export type GitHubStatsPayload = {
    stars: number;
    forks: number;
    contributors: number;
};

export function parseGitHubStats(value: unknown): GitHubStatsPayload | null {
    const stars = readCount(value, 'stars');
    const forks = readCount(value, 'forks');
    const contributors = readCount(value, 'contributors');
    if (stars === null || forks === null || contributors === null) return null;
    return { stars, forks, contributors };
}

export function useGitHubStats(url = statsUrl('github.json')): GitHubStatsPayload {
    return usePublicStat(url, parseGitHubStats, FALLBACK_GITHUB_STATS);
}
