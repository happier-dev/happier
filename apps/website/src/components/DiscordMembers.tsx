import { DISCORD_INVITE_URL } from '../data/community';
import { RollingNumber } from './RollingNumber';
import { formatStatCount, readCount, statsUrl, usePublicStat } from './publicStats';
import { rich } from '../i18n/rich';
import { useSiteData } from '../i18n/siteData';
import type { ReactNode } from 'react';

/** Measured 2026-08-04; only shown until the published stats load. */
const FALLBACK_MEMBER_COUNT = 488;

type DiscordStatsPayload = {
    memberCount: number;
};

export function parseDiscordStats(value: unknown): DiscordStatsPayload | null {
    const memberCount = readCount(value, 'memberCount');
    if (memberCount === null) return null;
    return { memberCount };
}

type DiscordMembersProps = {
    className?: string;
    fallbackCount?: number;
    url?: string;
};

/**
 * Live-ish Discord member count, linking to the invite.
 *
 * The count comes from a published JSON document rather than a direct call to
 * discord.com, so visiting the marketing page does not hand a visitor's IP to
 * Discord — the same reason downloads are published to stats.happier.dev.
 */
export function DiscordMembers({
    className = '',
    fallbackCount = FALLBACK_MEMBER_COUNT,
    url = import.meta.env.VITE_DISCORD_STATS_URL ?? statsUrl('discord.json'),
}: DiscordMembersProps) {
    const { pageProse: { PAGE_PROSE } } = useSiteData();

    const { memberCount } = usePublicStat(url, parseDiscordStats, {
        memberCount: fallbackCount,
    });

    const exact = formatStatCount(memberCount);

    return (
        <a
            href={DISCORD_INVITE_URL}
            target="_blank"
            rel="noreferrer"
            className={`group inline-flex items-center gap-2 whitespace-nowrap text-[13px] font-medium leading-none transition-colors md:text-[14px] ${className}`}
            style={{ color: 'var(--muted)' }}
            title={`${exact} happier developers on Discord`}
        >
            <svg viewBox="0 0 24 18" aria-hidden className="h-[15px] w-[15px] shrink-0" fill="currentColor">
                <path d="M20.32 1.53A19.8 19.8 0 0 0 15.43 0c-.24.42-.5.99-.69 1.44a18.3 18.3 0 0 0-5.48 0C9.07.99 8.79.42 8.56 0a19.74 19.74 0 0 0-4.9 1.53C.55 6.15-.31 10.65.12 15.09A19.9 19.9 0 0 0 6.19 18c.49-.67.93-1.38 1.3-2.13-.71-.27-1.4-.6-2.04-.99.17-.13.34-.26.5-.4a14.2 14.2 0 0 0 12.1 0c.17.14.33.27.5.4-.65.39-1.33.72-2.05.99.38.75.81 1.46 1.3 2.13a19.86 19.86 0 0 0 6.08-2.91c.5-5.15-.86-9.61-3.56-13.56ZM8.02 12.36c-1.18 0-2.16-1.09-2.16-2.43 0-1.33.95-2.43 2.16-2.43 1.22 0 2.19 1.1 2.17 2.43 0 1.34-.96 2.43-2.17 2.43Zm7.98 0c-1.18 0-2.16-1.09-2.16-2.43 0-1.33.96-2.43 2.16-2.43 1.22 0 2.19 1.1 2.17 2.43 0 1.34-.95 2.43-2.17 2.43Z" />
            </svg>
            <span>{rich(PAGE_PROSE.discordMembers.p0, { 2: () => <RollingNumber value={exact} />, 1: (c: ReactNode) => <span className="font-semibold" style={{ color: 'var(--fg)' }}>{c}</span> })}</span>
        </a>
    );
}
