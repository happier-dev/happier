import { GITHUB_REPO_URL, LICENSE_URL } from '../data/downloads';
import { DISCORD_INVITE_URL } from '../data/community';
import { formatStatCount, readCount, statsUrl, usePublicStat } from './publicStats';
import { useGitHubStats } from './GitHubStats';
import { RollingNumber } from './RollingNumber';
import { useSiteData } from '../i18n/siteData';

/** Measured 2026-08-08 from stats.happier.dev/downloads.json. */
const FALLBACK_DOWNLOAD_TOTAL = 36783;
/** Measured 2026-08-08 from stats.happier.dev/discord.json. */
const FALLBACK_MEMBER_COUNT = 486;

function parseDownloads(value: unknown) {
    const totalDownloads = readCount(value, 'totalDownloads');
    return totalDownloads === null ? null : { totalDownloads };
}

function parseDiscord(value: unknown) {
    const memberCount = readCount(value, 'memberCount');
    return memberCount === null ? null : { memberCount };
}

type Fact = {
    value: string;
    node?: React.ReactNode;
    label: string;
    href?: string;
};

/**
 * Five numbers, all true, all checkable by the reader in under a minute.
 *
 * Deliberately absent:
 *   - the App Store rating. It is 4.4 from 10 ratings. Ten ratings is not social
 *     proof, it is a rounding error, and printing it invites a reader to go and
 *     find the competitor with 995.
 *   - anything resembling a testimonial, logo wall, or "trusted by" line. There
 *     is nothing to put in one, and a fabricated one would be the fastest way to
 *     lose the exact audience this page is written for.
 *   - MAU / active-user counts. The durable base is ~40 people; the honest
 *     numbers to lead with are the ones that are genuinely large (downloads,
 *     stars) and the ones that are structural (agents, licence).
 *
 * Sources, all verified 2026-08-08:
 *   downloads    stats.happier.dev/downloads.json → 36,783
 *   stars/forks  api.github.com/repos/happier-dev/happier → 1,445 / 122
 *   contributors …/contributors?anon=1 → 71
 *   Discord      stats.happier.dev/discord.json → 486
 *   agents       remote-dev packages/agents/src/types.ts:10 → 13 named + custom ACP
 */
export function ProofStrip() {
    const { pageProse: { PAGE_PROSE } } = useSiteData();

    const { providers: { PROVIDERS } } = useSiteData();

    const { totalDownloads } = usePublicStat(statsUrl('downloads.json'), parseDownloads, {
        totalDownloads: FALLBACK_DOWNLOAD_TOTAL,
    });
    const { memberCount } = usePublicStat(statsUrl('discord.json'), parseDiscord, {
        memberCount: FALLBACK_MEMBER_COUNT,
    });
    const { stars, contributors } = useGitHubStats();

    const facts: ReadonlyArray<Fact> = [
        {
            value: formatStatCount(totalDownloads),
            node: <RollingNumber value={formatStatCount(totalDownloads)} />,
            label: 'downloads',
        },
        {
            value: formatStatCount(stars),
            node: <RollingNumber value={formatStatCount(stars)} />,
            label: 'GitHub stars',
            href: GITHUB_REPO_URL,
        },
        {
            value: String(contributors),
            label: 'contributors',
            href: `${GITHUB_REPO_URL}/graphs/contributors`,
        },
        {
            value: formatStatCount(memberCount),
            node: <RollingNumber value={formatStatCount(memberCount)} />,
            label: 'on Discord',
            href: DISCORD_INVITE_URL,
        },
        {
            value: String(PROVIDERS.length),
            label: 'agents supported',
            href: 'https://docs.happier.dev/providers',
        },
        {
            value: 'MIT',
            label: 'licensed, no lock-in',
            href: LICENSE_URL,
        },
    ];

    return (
        <ul className="flex flex-wrap items-center gap-x-7 gap-y-3.5" aria-label={PAGE_PROSE.proofStrip.p0}>
            {facts.map((fact) => {
                const body = (
                    <>
                        <span
                            className="text-[15px] font-semibold tabular-nums md:text-[16px]"
                            style={{ color: 'var(--fg)' }}
                        >
                            {fact.node ?? fact.value}
                        </span>{' '}
                        <span className="text-[13px] md:text-[13.5px]" style={{ color: 'var(--muted)' }}>
                            {fact.label}
                        </span>
                    </>
                );

                return (
                    <li key={fact.label} className="whitespace-nowrap leading-none">
                        {fact.href ? (
                            <a
                                href={fact.href}
                                target="_blank"
                                rel="noreferrer"
                                className="transition-opacity hover:opacity-75"
                            >
                                {body}
                            </a>
                        ) : (
                            body
                        )}
                    </li>
                );
            })}
        </ul>
    );
}
