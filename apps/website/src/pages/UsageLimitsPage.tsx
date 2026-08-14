import { P, PageHeader, PageShell, Prose } from '../components/PageShell';
import { USAGE_LIMITS_DOCS_URL } from '../data/usageLimits';
import { useSiteData } from '../i18n/siteData';
import { rich } from '../i18n/rich';
import type { ReactNode } from 'react';

/**
 * /features/usage-limits
 *
 * A feature page owns EVALUATION intent and nothing else: can Happier do this,
 * for which agents, and what is the catch. docs.happier.dev owns the procedure
 * and is linked once, as a configuration reference. The guides own the job
 * ("I ran out of Claude quota at 4pm, now what") and are not linked from here
 * because that is a different reader.
 *
 * The order is the argument:
 *   1. what actually happens when you hit a limit with no pool at all
 *   2. what a pool is ATTACHED TO, then what it changes
 *   3. the table of accounts, including the credentials where a switch is "not
 *      mid-session" and the agents where the answer is "not at all"
 *   4. the terms-of-service scoping, which lives here rather than in the FAQ
 *
 * Beat 2 used to start at "what it changes", with no sentence anywhere saying
 * what a pool is attached to. A pool is keyed by credential — see the header of
 * src/data/usageLimits.ts — so the page read as though pooling were something
 * Claude Code and Codex had, when in fact a Claude subscription pool is equally
 * available to OpenCode and Pi. That is now said before anything else about
 * pools, and the table is introduced as a list of accounts.
 *
 * The H1 was "Usage limits, and what happens when you hit one", which is a
 * reference-page title on a page that exists to be evaluated. The keyword still
 * carries in the <title> and the URL; the H1 now leads with the outcome, and it
 * is one that holds in both branches of the page — waiting keeps the session,
 * and so does switching.
 *
 * THE HEADINGS THEN SOLD THE POOL, AND THE POOL IS THE SMALLER HALF. "Hit a
 * usage limit. Keep the session." names a mechanism, and every H2 under it was
 * scaffolding around pooling — "Before you build a pool, you get a banner and a
 * choice", "What a pool is, and what it changes" — so the page read as though it
 * had nothing for the reader with one account. It has the larger thing: a limit
 * pauses the session, Happier waits out the reset, re-checks, restarts the
 * session process if it had exited, and sends a continuation prompt so the work
 * carries on from where it stopped. None of that needs a second account.
 *
 * WHAT THE SINGLE-ACCOUNT PATH ACTUALLY DOES, read in the shipped tree
 * (happier-dev/happier @ v0.2) rather than inferred from the feature's name:
 *   the wait is not pool-only
 *     apps/cli/src/session/usageLimitRecoveryControls/usageLimitRecoverySelectedAuth.ts
 *       — with no group and no profile the selected auth resolves to
 *       `{ kind: 'native' }`, so a plain provider login arms the same recovery
 *   who does the waiting
 *     apps/cli/src/session/actions/createCliActionDeps.ts:389-394, 1035-1049 —
 *       an armed / waiting / checking intent carrying a `nextCheckAtMs` is
 *       scheduled, and the check re-runs without the reader present
 *   what happens at the reset
 *     apps/cli/src/daemon/startDaemon.ts:818-833 —
 *       `resumeInactiveSessionWhenUsageLimitReady` re-spawns the session under
 *       its existing session id, so the session need not have stayed alive
 *   the work resumes, not just the session
 *     apps/ui/sources/text/translations/en.ts:7393-7402 — "Continuation prompt
 *       … ask the provider to continue from the interrupted context"
 *   how automatic it is, exactly
 *     packages/protocol/src/account/settings/accountSettings.ts:273-297 —
 *       `mode: 'ask' | 'auto_wait'`, DEFAULTING TO 'ask'. The first limit shows
 *       the banner and you choose; "Always wait and resume" (en.ts:4705) and the
 *       "Continue automatically" setting (en.ts:7390-7392) make it hands-off
 *       from then on. So the headings say the session waits and resumes. They do
 *       not say it arms itself, because on a default install it does not.
 */
export function UsageLimitsPage() {
    const { pageProse: { PAGE_PROSE } } = useSiteData();

    const { usageLimits: { POOL_DEFAULTS, SERVICE_SUPPORT, USAGE_LIMITS_POOL_SCOPE, USAGE_LIMITS_SCOPE, USAGE_LIMITS_SETUP, USAGE_LIMITS_SUPPORT_NOTES, USAGE_LIMITS_SWITCHING } } = useSiteData();

    return (
        <PageShell>
            <PageHeader
                eyebrow={PAGE_PROSE.usageLimitsPage.p5}
                title={PAGE_PROSE.usageLimitsPage.p6}
                standfirst={PAGE_PROSE.usageLimitsPage.p7}
            />

            <Prose heading={PAGE_PROSE.usageLimitsPage.p8} data-section="usage-limits-baseline">
                <P>{rich(PAGE_PROSE.usageLimitsPage.p0)}</P>
                <P>{rich(PAGE_PROSE.usageLimitsPage.p1)}</P>
            </Prose>

            <Prose heading={PAGE_PROSE.usageLimitsPage.p9} data-section="usage-limits-pools">
                {USAGE_LIMITS_POOL_SCOPE.map((paragraph) => (
                    <P key={paragraph.slice(0, 32)}>{paragraph}</P>
                ))}
                {USAGE_LIMITS_SWITCHING.map((paragraph) => (
                    <P key={paragraph.slice(0, 32)}>{paragraph}</P>
                ))}
            </Prose>

            <section className="relative" data-section="usage-limits-defaults">
                <div className="mx-auto max-w-[1400px] px-6 py-10 md:px-10 md:py-14">
                    <div className="max-w-[900px]">
                        <h2 className="font-display text-[26px] font-normal leading-[1.14] tracking-[-0.025em] md:text-[34px]">{rich(PAGE_PROSE.usageLimitsPage.p10)}</h2>
                        <p
                            className="mt-4 max-w-[720px] text-[16px] leading-[1.65]"
                            style={{ color: 'var(--muted)' }}
                        >{rich(PAGE_PROSE.usageLimitsPage.p2)}</p>
                        <div
                            className="mt-6 overflow-x-auto rounded-2xl border"
                            style={{ borderColor: 'var(--card-border)' }}
                        >
                            <table className="w-full min-w-[640px] border-collapse text-left text-[14px]">
                                <thead>
                                    <tr>
                                        <th scope="col" className="px-4 py-3 font-semibold" style={{ color: 'var(--fg)' }}>{rich(PAGE_PROSE.usageLimitsPage.p11)}</th>
                                        <th scope="col" className="px-4 py-3 font-semibold" style={{ color: 'var(--fg)' }}>{rich(PAGE_PROSE.usageLimitsPage.p12)}</th>
                                        <th scope="col" className="px-4 py-3 font-semibold" style={{ color: 'var(--fg)' }}>{rich(PAGE_PROSE.usageLimitsPage.p13)}</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {POOL_DEFAULTS.map((row) => (
                                        <tr key={row.id} className="border-t" style={{ borderColor: 'var(--card-border)' }}>
                                            <th
                                                scope="row"
                                                className="px-4 py-3 text-left font-medium"
                                                style={{ color: 'var(--fg)' }}
                                            >
                                                {row.setting}
                                            </th>
                                            <td className="px-4 py-3 whitespace-nowrap" style={{ color: 'var(--fg)' }}>
                                                {row.value}
                                            </td>
                                            <td className="px-4 py-3" style={{ color: 'var(--muted)' }}>
                                                {row.note}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </div>
                </div>
            </section>

            <section className="relative" data-section="usage-limits-support">
                <div className="mx-auto max-w-[1400px] px-6 py-10 md:px-10 md:py-14">
                    <div className="max-w-[900px]">
                        <h2 className="font-display text-[26px] font-normal leading-[1.14] tracking-[-0.025em] md:text-[34px]">{rich(PAGE_PROSE.usageLimitsPage.p14)}</h2>
                        <p
                            className="mt-4 max-w-[720px] text-[16px] leading-[1.65]"
                            style={{ color: 'var(--muted)' }}
                        >{rich(PAGE_PROSE.usageLimitsPage.p3)}</p>
                        <div
                            className="mt-6 overflow-x-auto rounded-2xl border"
                            style={{ borderColor: 'var(--card-border)' }}
                        >
                            <table className="w-full min-w-[720px] border-collapse text-left text-[14px]">
                                <thead>
                                    <tr>
                                        <th scope="col" className="px-4 py-3 font-semibold" style={{ color: 'var(--fg)' }}>{rich(PAGE_PROSE.usageLimitsPage.p15)}</th>
                                        <th scope="col" className="px-4 py-3 font-semibold" style={{ color: 'var(--fg)' }}>{rich(PAGE_PROSE.usageLimitsPage.p16)}</th>
                                        <th scope="col" className="px-4 py-3 font-semibold" style={{ color: 'var(--fg)' }}>{rich(PAGE_PROSE.usageLimitsPage.p17)}</th>
                                        <th scope="col" className="px-4 py-3 font-semibold" style={{ color: 'var(--fg)' }}>{rich(PAGE_PROSE.usageLimitsPage.p18)}</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {SERVICE_SUPPORT.map((row) => (
                                        <tr key={row.id} className="border-t" style={{ borderColor: 'var(--card-border)' }}>
                                            <th
                                                scope="row"
                                                className="px-4 py-3 text-left font-medium"
                                                style={{ color: 'var(--fg)' }}
                                            >
                                                {row.service}
                                            </th>
                                            <td className="px-4 py-3" style={{ color: 'var(--muted)' }}>
                                                {row.agents}
                                            </td>
                                            <td className="px-4 py-3" style={{ color: 'var(--fg)' }}>
                                                {row.autoSwitch}
                                            </td>
                                            <td className="px-4 py-3" style={{ color: 'var(--muted)' }}>
                                                {row.meter}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                        {USAGE_LIMITS_SUPPORT_NOTES.map((paragraph) => (
                            <p
                                key={paragraph.slice(0, 32)}
                                className="mt-5 max-w-[720px] text-[16px] leading-[1.65]"
                                style={{ color: 'var(--muted)' }}
                            >
                                {paragraph}
                            </p>
                        ))}
                    </div>
                </div>
            </section>

            <Prose heading={PAGE_PROSE.usageLimitsPage.p19} data-section="usage-limits-scope">
                {USAGE_LIMITS_SCOPE.map((paragraph) => (
                    <P key={paragraph.slice(0, 32)}>{paragraph}</P>
                ))}
            </Prose>

            <Prose heading={PAGE_PROSE.usageLimitsPage.p20} data-section="usage-limits-docs">
                <P>{USAGE_LIMITS_SETUP[0]}</P>
                <P>{rich(PAGE_PROSE.usageLimitsPage.p4, { 1: (c: ReactNode) => <a
                        href={USAGE_LIMITS_DOCS_URL}
                        className="underline underline-offset-2"
                        style={{ color: 'var(--fg)' }}
                    >{c}</a> })}</P>
                <P>{USAGE_LIMITS_SETUP[1]}</P>
            </Prose>
        </PageShell>
    );
}
