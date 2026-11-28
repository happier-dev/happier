import type { ReactNode } from 'react';

import { GitHubStarPill } from '../components/GitHubStarPill';
import { MoneySheet } from '../components/MoneySheet';
import { NumberedSteps } from '../components/NumberedSteps';
import { PageHeader, PageShell, Prose } from '../components/PageShell';
import { SELF_HOST_DOCS_URL } from '../data/downloads';
import { DISCORD_INVITE_URL } from '../data/community';
import { plansRelease } from '../data/plansRelease';
import { useLocalePath } from '../i18n';
import { rich } from '../i18n/rich';
import { useSiteData } from '../i18n/siteData';
import { Island } from '../islands';

/**
 * /open — how Happier stays free: the promises, how it is funded, the money.
 *
 * Order is the owner's: promises first, then the two funding pillars, then
 * coverage and what people paid, with the monthly operating and development
 * costs sitting calmly below in the same sheet. No year-to-date headline, no
 * scroll reveals on figures, and no limit-change log: the notice period lives
 * in the Terms of Sale (owner, 2026-11-27).
 *
 * Only two leaves are islands: the star pill (github.json) and the money sheet
 * (finances.json + supporters.json). Everything else is prerendered prose.
 */
export function OpenPage() {
    const localeHref = useLocalePath();
    const {
        open: { OPEN_INTRO, OPEN_PILLS, OPEN_PROMISES_HEADING, OPEN_PROMISES, OPEN_FUNDING, OPEN_MONEY, OPEN_WONT_DO, OPEN_FOUNDER },
    } = useSiteData();

    return (
        <PageShell>
            <PageHeader eyebrow={OPEN_INTRO.eyebrow} title={OPEN_INTRO.title} standfirst={OPEN_INTRO.description}>
                <p className="mt-4 max-w-[720px] text-[16px] leading-[1.65] [text-wrap:pretty]" style={{ color: 'var(--muted)' }}>
                    {OPEN_INTRO.goal}
                </p>
                <div className="mt-[26px] flex flex-wrap gap-2.5">
                    {plansRelease.purchasesLive ? (
                        <a href={localeHref('/plans#plan-supporter')} className="plan-pill plan-pill--pri">
                            {OPEN_PILLS.supporter}
                        </a>
                    ) : null}
                    <Island name="github-star-pill" component={GitHubStarPill} />
                    <a href={SELF_HOST_DOCS_URL} className="plan-pill">
                        {OPEN_PILLS.selfHost}
                    </a>
                </div>
            </PageHeader>

            <Prose heading={OPEN_PROMISES_HEADING} rhythm="chapter" data-section="open-promises">
                <NumberedSteps
                    size="sm"
                    className="mt-1"
                    steps={OPEN_PROMISES.map((promise) => ({ id: promise.id, title: promise.title, body: promise.body }))}
                />
            </Prose>

            <Prose id="funding" heading={OPEN_FUNDING.heading} rhythm="chapter" data-section="open-funding">
                <p className="text-[16px] leading-[1.65] [text-wrap:pretty]" style={{ color: 'var(--muted)' }}>
                    {OPEN_FUNDING.lead}
                </p>
                <div className="grid grid-cols-1 gap-3.5 md:grid-cols-2">
                    {OPEN_FUNDING.pillars.map((pillar) => (
                        <article
                            key={pillar.id}
                            className="flex min-w-0 flex-col gap-3 rounded-[18px] p-[22px]"
                            style={{ boxShadow: 'inset 0 0 0 1px var(--card-border)' }}
                        >
                            <h3 className="font-display text-[22px] font-normal leading-[1.15] tracking-[-0.02em] [text-wrap:balance]" style={{ color: 'var(--fg)' }}>
                                {pillar.title}
                            </h3>
                            <p className="text-[15px] leading-[1.6] [text-wrap:pretty]" style={{ color: 'var(--muted)' }}>
                                {pillar.body}
                            </p>
                            <span className="flex-1" />
                            <div className="flex flex-wrap gap-2">
                                {pillar.links.map((link) => (
                                    <a key={link.href} href={localeHref(link.href)} className="plan-pill">
                                        {link.label}
                                    </a>
                                ))}
                            </div>
                        </article>
                    ))}
                </div>
            </Prose>

            <section id="money" data-section="open-money" className="relative">
                <div className="mx-auto max-w-[1400px] px-6 pt-16 md:px-10 md:pt-24">
                    <h2 className="mb-3 font-display text-[26px] font-normal leading-[1.14] tracking-[-0.025em] [text-wrap:balance] md:text-[34px]">
                        {OPEN_MONEY.heading}
                    </h2>
                    <div className="max-w-[1100px]">
                        <Island name="money-sheet" component={MoneySheet} />
                    </div>
                </div>
            </section>

            <Prose heading={OPEN_WONT_DO.heading} rhythm="chapter" data-section="open-wont-do">
                <ul className="grid grid-cols-1 gap-x-8 gap-y-2.5 md:grid-cols-2">
                    {OPEN_WONT_DO.items.map((item) => (
                        <li key={item} className="relative pl-[18px] text-[16px] leading-[1.6]" style={{ color: 'var(--muted)' }}>
                            <span aria-hidden className="absolute left-0 top-[0.8em] h-px w-2" style={{ background: 'var(--muted)' }} />
                            {item}
                        </li>
                    ))}
                </ul>
            </Prose>

            <section data-section="open-founder" className="relative">
                <div className="mx-auto max-w-[1400px] px-6 pb-24 pt-14 md:px-10 md:pb-32">
                    <p className="mb-8 max-w-[640px] font-display text-[22px] leading-[1.35] tracking-[-0.015em] [text-wrap:pretty] md:text-[24px]" style={{ color: 'var(--fg)' }}>
                        {OPEN_FOUNDER.thanks}
                    </p>
                    <figure className="max-w-[640px]">
                        <blockquote className="text-[16px] leading-[1.65] [text-wrap:pretty]" style={{ color: 'var(--fg)' }}>
                            {rich(OPEN_FOUNDER.note, {
                                1: (children: ReactNode) => (
                                    <a href={DISCORD_INVITE_URL} target="_blank" rel="noopener" className="underline underline-offset-2">
                                        {children}
                                    </a>
                                ),
                                2: (children: ReactNode) => (
                                    <a href={`mailto:${OPEN_INTRO.contact}`} className="underline underline-offset-2">
                                        {children}
                                    </a>
                                ),
                            })}
                        </blockquote>
                        <figcaption className="mt-5 flex items-center gap-3.5 text-[14px] font-medium" style={{ color: 'var(--fg)' }}>
                            <span
                                aria-hidden
                                className="grid h-10 w-10 shrink-0 place-items-center rounded-full text-[13px] font-semibold text-white"
                                style={{ background: 'conic-gradient(from 210deg, #F2994A, #E2557A, #8E6CF2, #4AA3F2, #F2994A)' }}
                            >
                                {OPEN_FOUNDER.initials}
                            </span>
                            {OPEN_FOUNDER.signature}
                        </figcaption>
                    </figure>
                </div>
            </section>
        </PageShell>
    );
}
