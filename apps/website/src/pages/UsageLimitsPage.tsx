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
 */
export function UsageLimitsPage() {
    return (
        <PageShell>
            <PageHeader
                eyebrow="Feature"
                title="Hit a usage limit. Keep the session."
                standfirst="Every provider stops you eventually. Happier cannot change that and does not claim to. What it can do is show you the meter before you hit it, pool the accounts you already own on that provider, and — for Claude Code and Codex — move a running session onto another one of them instead of ending your afternoon."
            />

            <Prose heading="With one account, you get a banner and a choice" data-section="usage-limits-baseline">
                <P>
                    A provider refuses a turn and Happier shows “Usage limit reached”, with the reset
                    time when the provider supplied one. From there: wait — “Resume when limit
                    resets” keeps the session and picks it up on its own — or “Check limit now” to
                    re-probe, or stop waiting. That is the whole of it, and for one account it is
                    enough.
                </P>
                <P>
                    That banner appears for Claude Code, Codex, OpenCode, Gemini and Pi. No other
                    agent in the registry reports usage limits to Happier in a form it can act on,
                    so what you get there is whatever the provider’s own CLI prints.
                </P>
            </Prose>

            <Prose heading="What a pool is, and what it changes" data-section="usage-limits-pools">
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
                            The defaults a new pool starts with
                        </h2>
                        <p
                            className="mt-4 max-w-[720px] text-[16px] leading-[1.65]"
                            style={{ color: 'var(--muted)' }}
                        >
                            All of them are editable per pool. They are listed because “three
                            switches per session hour” tells you more about how this feature behaves
                            than any sentence describing it would.
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
                            Which accounts you can pool, and who can use them
                        </h2>
                        <p
                            className="mt-4 max-w-[720px] text-[16px] leading-[1.65]"
                            style={{ color: 'var(--muted)' }}
                        >
                            One row per account you can connect, because that is what a pool is made
                            of. Being able to use a pool and being able to change account inside a
                            running turn are two different capabilities, and the second one is
                            rarer. The third column is the honest one.
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

            <Prose heading="What a pool is for" data-section="usage-limits-scope">
                {USAGE_LIMITS_SCOPE.map((paragraph) => (
                    <P key={paragraph.slice(0, 32)}>{paragraph}</P>
                ))}
            </Prose>

            <Prose heading="Setting it up" data-section="usage-limits-docs">
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
