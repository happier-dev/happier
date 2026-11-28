import { useEffect, useState } from 'react';

import { SUPPORTERS_PAGE as SUPPORTERS_SOURCE } from '../data/plans';
import { useSiteData } from '../i18n/siteData';
import { statsUrl, usePublicStat } from './publicStats';

const SUPPORTERS_LINKED = SUPPORTERS_SOURCE.linked;

/**
 * The supporter wall, from plan 05's `supporters.json`
 * (`{ schemaVersion, generatedAt, total, entries: [{ number, name, link?, since }] }`).
 *
 * `entries` holds opted-in rows only. The file is third-party input to this
 * bundle like every other public stat, so it is validated rather than trusted:
 * names render through React as text, a link is kept only when it is https and
 * carries `rel="nofollow ugc noopener"`, and any malformed document keeps the
 * compiled empty wall whole.
 *
 * Two uses: `limit={6}` is the strip inside the /open money sheet (latest six
 * and a link to the wall); no limit is the /supporters page, which also reads
 * `/s/<n>` (a pass QR, rewritten to this page) and `?linked=`. Both are read
 * after mount so the prerendered markup and the first client render match.
 */

export type SupporterEntry = { number: number; name: string; link: string | null; since: number };
export type Supporters = { total: number; entries: SupporterEntry[] };

/** Plan 06's bound for plan 05: three columns of a 1,100 px sheet at 14 px Inter. */
export const SUPPORTER_NAME_MAX = 40;

const EMPTY: Supporters = { total: 0, entries: [] };

function parseEntry(raw: unknown): SupporterEntry | null {
    if (typeof raw !== 'object' || raw === null) return null;
    const { number, name, link, since } = raw as Record<string, unknown>;
    if (typeof number !== 'number' || !Number.isInteger(number) || number < 1) return null;
    if (typeof name !== 'string' || name.trim().length === 0) return null;
    if (typeof since !== 'number' || !Number.isInteger(since) || since < 2024 || since > 9999) return null;
    let safeLink: string | null = null;
    if (typeof link === 'string') {
        try {
            const url = new URL(link);
            if (url.protocol === 'https:') safeLink = url.toString();
        } catch {
            safeLink = null;
        }
    }
    return { number, name: name.trim(), link: safeLink, since };
}

export function parseSupporters(raw: unknown): Supporters | null {
    if (typeof raw !== 'object' || raw === null) return null;
    const { schemaVersion, total, entries } = raw as Record<string, unknown>;
    if (typeof schemaVersion !== 'number' || !Array.isArray(entries)) return null;
    const parsed = entries.map(parseEntry);
    if (parsed.some((e) => e === null)) return null;
    const list = (parsed as SupporterEntry[]).slice().sort((a, b) => a.number - b.number);
    const count = typeof total === 'number' && Number.isInteger(total) && total >= list.length ? total : list.length;
    return { total: count, entries: list };
}

const padded = (n: number) => String(n).padStart(4, '0');

function fill(template: string, values: Record<string, string | number>): string {
    return template.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? ''));
}

function Name({ entry, wrap = false }: { entry: SupporterEntry; wrap?: boolean }) {
    const cls = wrap ? '[overflow-wrap:anywhere]' : 'min-w-0 truncate';
    if (!entry.link) return <span className={cls}>{entry.name}</span>;
    return (
        <a href={entry.link} rel="nofollow ugc noopener" target="_blank" className={`${cls} underline-offset-2 hover:underline`}>
            {entry.name}
        </a>
    );
}

function Grid({ entries }: { entries: SupporterEntry[] }) {
    return (
        <ul className="grid grid-cols-1 gap-x-6 gap-y-2.5 text-[14px] sm:grid-cols-2 lg:grid-cols-3">
            {entries.map((entry) => (
                <li key={entry.number} className="flex min-w-0 items-baseline gap-2.5" title={entry.name.length > SUPPORTER_NAME_MAX ? entry.name : undefined}>
                    <span className="w-10 shrink-0 font-mono text-[12px] tabular-nums" style={{ color: 'var(--muted)' }}>
                        {padded(entry.number)}
                    </span>
                    <span className="flex min-w-0" style={{ color: 'var(--fg)' }}>
                        <Name entry={entry} />
                    </span>
                </li>
            ))}
        </ul>
    );
}

/** The `?linked=` results, read off the copy's own keys so the two cannot drift. */
type Linked = keyof typeof SUPPORTERS_LINKED;
const LINKED = Object.keys(SUPPORTERS_LINKED) as Linked[];
type WallLocation = { pass: number | null; linked: Linked | null; discord: boolean; retry: boolean };

/** Pass number from `/s/<n>` (the `_redirects` rewrite keeps the path), and `?linked=`. */
function readLocation(): WallLocation {
    const match = /^\/s\/(\d{1,7})\/?$/.exec(window.location.pathname);
    const params = new URLSearchParams(window.location.search);
    return {
        pass: match ? Number(match[1]) : null,
        linked: LINKED.find((value) => value === params.get('linked')) ?? null,
        discord: params.get('via') === 'discord',
        retry: params.get('retry') === '1',
    };
}

export function SupporterWall({ limit }: { limit?: number }) {
    const { open: { OPEN_MONEY }, plans: { SUPPORTERS_PAGE } } = useSiteData();
    const wall = usePublicStat(statsUrl('supporters.json'), parseSupporters, EMPTY);
    const [where, setWhere] = useState<WallLocation>({ pass: null, linked: null, discord: false, retry: false });
    useEffect(() => {
        if (limit === undefined) setWhere(readLocation());
    }, [limit]);

    if (limit !== undefined) {
        const latest = wall.entries.slice(-limit).reverse();
        return (
            <div>
                {latest.length > 0 ? (
                    <Grid entries={latest} />
                ) : (
                    <p className="text-[14px]" style={{ color: 'var(--muted)' }}>
                        {OPEN_MONEY.wallEmpty}
                    </p>
                )}
                <a href="/supporters" hrefLang="en" className="mt-4 inline-block text-[13px] font-medium underline underline-offset-2" style={{ color: 'var(--fg)' }}>
                    {OPEN_MONEY.wallMore}
                </a>
            </div>
        );
    }

    const holder = where.pass !== null ? wall.entries.find((e) => e.number === where.pass) ?? null : null;
    const { linked, discord, retry } = where;
    const linkedMessage = linked && (discord && linked !== 'sponsor'
        ? retry && linked === 'none'
            ? SUPPORTERS_PAGE.discordLinked.retry
            : SUPPORTERS_PAGE.discordLinked[linked]
        : SUPPORTERS_PAGE.linked[linked]);
    return (
        <div>
            {linkedMessage ? (
                <p role="status" className="mb-6 rounded-xl px-4 py-3 text-[15px] surface-card" style={{ boxShadow: 'inset 0 0 0 1px var(--card-border)', color: 'var(--fg)' }}>
                    {linkedMessage}
                    {discord && retry && linked === 'supporter' ? ` ${SUPPORTERS_PAGE.discordLinked.retry}` : null}
                </p>
            ) : null}
            {where.pass !== null ? (
                <div className="mb-8 rounded-2xl p-5 md:p-6 surface-card" style={{ boxShadow: 'inset 0 0 0 1px var(--card-border)' }}>
                    {holder ? (
                        <p className="font-display text-[22px] leading-[1.3] tracking-[-0.02em] [text-wrap:balance] md:text-[26px]" style={{ color: 'var(--fg)' }}>
                            {SUPPORTERS_PAGE.entry.split('{name}').flatMap((part, i, parts) => {
                                const text = fill(part, { n: holder.number, since: holder.since });
                                return i < parts.length - 1 ? [text, <Name key={i} entry={holder} wrap />] : [text];
                            })}
                        </p>
                    ) : (
                        <p className="text-[17px] leading-[1.55]" style={{ color: 'var(--fg)' }}>
                            {SUPPORTERS_PAGE.unknown}
                        </p>
                    )}
                </div>
            ) : null}
            <div className="money-sheet">
                <section className="money-full">
                    {wall.total > 0 ? (
                        <div className="mb-4 text-[13px] tabular-nums" style={{ color: 'var(--muted)' }}>
                            {fill(wall.total === 1 ? SUPPORTERS_PAGE.countOne : SUPPORTERS_PAGE.countMany, { count: wall.total.toLocaleString('en-US') })}
                        </div>
                    ) : null}
                    {wall.entries.length > 0 ? (
                        <Grid entries={wall.entries} />
                    ) : (
                        <p className="text-[16px]" style={{ color: 'var(--muted)' }}>
                            {SUPPORTERS_PAGE.empty}
                        </p>
                    )}
                </section>
            </div>
        </div>
    );
}
