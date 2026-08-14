import { P, PageHeader, PageShell, Prose } from '../components/PageShell';
import {
    POOL_DEFAULTS,
    SERVICE_SUPPORT,
    USAGE_LIMITS_DOCS_URL,
    USAGE_LIMITS_POOL_SCOPE,
    USAGE_LIMITS_SCOPE,
    USAGE_LIMITS_SETUP,
    USAGE_LIMITS_SUPPORT_NOTES,
    USAGE_LIMITS_SWITCHING,
} from '../data/usageLimits';

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
    return (
        <PageShell>
            <PageHeader
                eyebrow="Feature"
                title="A usage limit should not end your session."
                standfirst="Every provider stops you eventually, and Happier cannot change that. What it can do is hold the session at the limit, show you when it resets, and start the work again from where it stopped. Turn on “Always wait and resume” and it does the whole thing unattended — one setting, and you come back to a session that carried on instead of one that stopped. That is on one account. Own several subscriptions and there is a better answer below: pool them, and let Happier load-balance across them."
            />

            <Prose heading="With one account, Happier waits out the reset and resumes the session" data-section="usage-limits-baseline">
                <P>
                    A provider refuses a turn and Happier shows “Usage limit reached”, with the reset
                    time when the provider supplied one. From there: wait — “Resume when limit
                    resets” keeps the session and picks it up on its own — or “Check limit now” to
                    re-probe, or stop waiting. Waiting is the one that keeps your afternoon: Happier
                    holds the reset time, re-checks it for you, starts the session again if it had
                    exited in the meantime, and sends a prompt to carry on from the interrupted
                    context. Tick “Always wait and resume” once and you stop being asked — every
                    limit after that is handled the same way with nobody watching. A Codex session
                    goes one further and arms the wait by itself once “Continue automatically” is
                    set.
                </P>
                <P>
                    That banner appears for Claude Code, Codex, OpenCode, Gemini and Pi. No other
                    agent in the registry reports usage limits to Happier in a form it can act on,
                    so what you get there is whatever the provider’s own CLI prints.
                </P>
            </Prose>

            <Prose heading="Pool & load-balance the accounts you own, and the session carries on across them" data-section="usage-limits-pools">
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
                        <h2 className="font-display text-[26px] font-normal leading-[1.14] tracking-[-0.025em] md:text-[34px]">
                            How a pool falls back: the account it picks, and how often
                        </h2>
                        <p
                            className="mt-4 max-w-[720px] text-[16px] leading-[1.65]"
                            style={{ color: 'var(--muted)' }}
                        >
                            The defaults a new pool starts with. All of them are editable per pool.
                        </p>
                        <div
                            className="mt-6 overflow-x-auto rounded-2xl border"
                            style={{ borderColor: 'var(--card-border)' }}
                        >
                            <table className="w-full min-w-[640px] border-collapse text-left text-[14px]">
                                <thead>
                                    <tr>
                                        <th scope="col" className="px-4 py-3 font-semibold" style={{ color: 'var(--fg)' }}>
                                            Setting
                                        </th>
                                        <th scope="col" className="px-4 py-3 font-semibold" style={{ color: 'var(--fg)' }}>
                                            Default
                                        </th>
                                        <th scope="col" className="px-4 py-3 font-semibold" style={{ color: 'var(--fg)' }}>
                                            Why
                                        </th>
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
                        <h2 className="font-display text-[26px] font-normal leading-[1.14] tracking-[-0.025em] md:text-[34px]">
                            Which accounts you can pool, and which agents can use them
                        </h2>
                        <p
                            className="mt-4 max-w-[720px] text-[16px] leading-[1.65]"
                            style={{ color: 'var(--muted)' }}
                        >
                            One row per account you can connect. Being able to use a pool and being
                            able to change account inside a running turn are two different
                            capabilities, and the second one is rarer.
                        </p>
                        <div
                            className="mt-6 overflow-x-auto rounded-2xl border"
                            style={{ borderColor: 'var(--card-border)' }}
                        >
                            <table className="w-full min-w-[720px] border-collapse text-left text-[14px]">
                                <thead>
                                    <tr>
                                        <th scope="col" className="px-4 py-3 font-semibold" style={{ color: 'var(--fg)' }}>
                                            Account you connect
                                        </th>
                                        <th scope="col" className="px-4 py-3 font-semibold" style={{ color: 'var(--fg)' }}>
                                            Agents that can use it
                                        </th>
                                        <th scope="col" className="px-4 py-3 font-semibold" style={{ color: 'var(--fg)' }}>
                                            Switches mid-session
                                        </th>
                                        <th scope="col" className="px-4 py-3 font-semibold" style={{ color: 'var(--fg)' }}>
                                            Quota meter
                                        </th>
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

            <Prose heading="Your own accounts, and what your provider’s terms allow" data-section="usage-limits-scope">
                {USAGE_LIMITS_SCOPE.map((paragraph) => (
                    <P key={paragraph.slice(0, 32)}>{paragraph}</P>
                ))}
            </Prose>

            <Prose heading="Build a pool in the app, start a session on it from the CLI" data-section="usage-limits-docs">
                <P>{USAGE_LIMITS_SETUP[0]}</P>
                <P>
                    Connecting the accounts comes first, and that part has a{' '}
                    <a
                        href={USAGE_LIMITS_DOCS_URL}
                        className="underline underline-offset-2"
                        style={{ color: 'var(--fg)' }}
                    >
                        configuration reference
                    </a>
                    : how each provider’s sign-in works, which agent can consume which credential,
                    and where the quota snapshots come from.
                </P>
                <P>{USAGE_LIMITS_SETUP[1]}</P>
            </Prose>
        </PageShell>
    );
}
