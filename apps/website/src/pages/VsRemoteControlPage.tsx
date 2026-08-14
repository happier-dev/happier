import { P, PageHeader, PageShell, Prose } from '../components/PageShell';
import { InstallCommand } from '../components/InstallCommand';
import { useSiteData } from '../i18n/siteData';
import { rich } from '../i18n/rich';
import { PAGE_PROSE } from '../data/pageProse';
import type { ReactNode } from 'react';

/**
 * /vs/claude-code-remote-control
 *
 * Structure is deliberate and the order is the argument:
 *   1. concede, in detail, before qualifying anything
 *   2. what Remote Control does well, specifically — corrected against the docs
 *   3. the documented conditions under which it is unavailable
 *   4. the scope limit, stated SEPARATELY because it is not a disable condition
 *   5. the table, including the two rows Anthropic wins
 *   6. what a client that runs every agent can do that a vendor remote cannot
 *   7. install
 *
 * WHAT IS NOT ON THIS PAGE ANY MORE, AND MUST NOT COME BACK:
 *   • A "when you should use Remote Control instead of Happier" section. The
 *     honesty stays — it is in the concession, in the imperative, once. A whole
 *     block telling the reader to go and use the other thing was the page
 *     arguing itself out of existence.
 *   • "No vendor will ship a client for a rival's CLI." Zed does exactly that,
 *     over ACP. It was the load-bearing sentence of the old scope-limit block
 *     and it was false.
 */
export function VsRemoteControlPage() {
    const { comparison: { COMPARISON_ROWS, RC_SCOPE_LIMIT, RC_SECTION, RC_STRENGTHS }, agents: { AGENTS } } = useSiteData();

    return (
        <PageShell>
            {/*
              * TWO WRONG EYEBROWS, IN ORDER, SO NEITHER COMES BACK.
              *
              * It read "Honest comparison" first. Calling your own comparison
              * honest is a claim the reader cannot check and that every
              * dishonest comparison also makes.
              *
              * It then read "Sourced from Anthropic's docs", which is the same
              * defect wearing evidence: a label that says where the page got
              * its facts rather than what the page is about. Sourcing is real
              * and it belongs in comments — the rule is stated in full in the
              * docblock at the top of src/data/comparison.ts — and it is made
              * to the reader in body copy, where the standfirst, RC_SECTION.turn
              * and the dek above the five-conditions list all attribute to
              * Anthropic explicitly. An eyebrow has three or four words and its
              * job is to tell a stranger arriving cold from search which
              * product this page is about. So it names the product.
              */}
            {/*
              * THE H1 USED TO END "…and where Happier fits", as did the Codex
              * page's. "Fits" names no outcome, and the phrase only means
              * anything to a reader who already knows what Happier is — which
              * is nobody arriving on a page whose whole job is to be found by
              * someone searching for the other product. The pair now leads on
              * the thing the visitor typed (their agent, from their phone) and
              * then says plainly what the page does with it.
              */}
            <PageHeader
                eyebrow="Claude Code Remote Control"
                title="Claude Code from your phone: Remote Control and Happier, compared"
                standfirst="Anthropic ships a remote for its own agent, it is free with a subscription you probably already pay for, and it is good. Here is exactly what it does, the situations its own documentation says it will not run in, and the workflow it was never built for."
            />

            <Prose data-section="rc-concession">
                <P>{RC_SECTION.concession}</P>
                <P>{RC_SECTION.turn}</P>
            </Prose>

            <section className="relative" data-section="rc-strengths">
                <div className="mx-auto max-w-[1400px] px-6 py-10 md:px-10 md:py-14">
                    <div className="max-w-[860px]">
                        <h2 className="font-display text-[26px] font-normal leading-[1.14] tracking-[-0.025em] md:text-[34px]">
                            What Remote Control does well, specifically
                        </h2>
                        <p className="mt-4 max-w-[720px] text-[16px] leading-[1.65]" style={{ color: 'var(--muted)' }}>{rich(PAGE_PROSE.vsRemoteControlPage.p0)}</p>
                        <dl className="mt-7 grid gap-6 md:grid-cols-2">
                            {RC_STRENGTHS.map((item) => (
                                <div key={item.id}>
                                    <dt className="text-[16px] font-semibold" style={{ color: 'var(--fg)' }}>
                                        {item.title}
                                    </dt>
                                    <dd className="mt-2 text-[15px] leading-[1.62]" style={{ color: 'var(--muted)' }}>
                                        {item.body}
                                    </dd>
                                </div>
                            ))}
                        </dl>
                    </div>
                </div>
            </section>

            <section className="relative" data-section="vs-remote-control">
                <div className="mx-auto max-w-[1400px] px-6 py-10 md:px-10 md:py-14">
                    <div className="max-w-[860px]">
                        <h2 className="font-display text-[26px] font-normal leading-[1.14] tracking-[-0.025em] md:text-[34px]">
                            The five situations where Remote Control turns itself off
                        </h2>
                        <p className="mt-4 max-w-[720px] text-[16px] leading-[1.65]" style={{ color: 'var(--muted)' }}>{rich(PAGE_PROSE.vsRemoteControlPage.p1)}</p>
                        <ol className="mt-8 space-y-8">
                            {RC_SECTION.cases
                                .filter((item) => item.id !== 'otherAgents')
                                .map((item, index) => (
                                    <li key={item.id}>
                                        <h3 className="text-[18px] font-semibold" style={{ color: 'var(--fg)' }}>
                                            {index + 1}. {item.when}
                                        </h3>
                                        <p
                                            className="mt-2 text-[16px] leading-[1.68]"
                                            style={{ color: 'var(--muted)' }}
                                        >
                                            {item.rc}
                                        </p>
                                        <p
                                            className="mt-2 border-l-2 pl-4 text-[16px] leading-[1.68]"
                                            style={{ borderColor: 'var(--card-border)', color: 'var(--fg)' }}
                                        >
                                            {item.happier}
                                        </p>
                                    </li>
                                ))}
                        </ol>
                    </div>
                </div>
            </section>

            <Prose heading={RC_SCOPE_LIMIT.heading} data-section="rc-scope">
                <P>{RC_SCOPE_LIMIT.body}</P>
                <P>{rich(PAGE_PROSE.vsRemoteControlPage.p2)}</P>
            </Prose>

            <section className="relative" data-section="rc-table">
                <div className="mx-auto max-w-[1400px] px-6 py-10 md:px-10 md:py-14">
                    <div className="max-w-[900px]">
                        <h2 className="font-display text-[26px] font-normal leading-[1.14] tracking-[-0.025em] md:text-[34px]">
                            Will it run in your setup?
                        </h2>
                        <p className="mt-4 max-w-[720px] text-[16px] leading-[1.65]" style={{ color: 'var(--muted)' }}>{rich(PAGE_PROSE.vsRemoteControlPage.p3)}</p>
                        <div
                            className="mt-6 overflow-x-auto rounded-2xl border"
                            style={{ borderColor: 'var(--card-border)' }}
                        >
                            <table className="w-full min-w-[640px] border-collapse text-left text-[14px]">
                                <caption className="px-4 pb-3 pt-4 text-left text-[13px]" style={{ color: 'var(--muted)' }}>
                                    The Remote Control column restates Anthropic’s published
                                    documentation at code.claude.com/docs/en/remote-control.
                                    Verified August 2026.
                                </caption>
                                <thead>
                                    <tr>
                                        <th scope="col" className="px-4 py-3 font-semibold" style={{ color: 'var(--fg)' }}>
                                            Capability
                                        </th>
                                        <th scope="col" className="px-4 py-3 font-semibold" style={{ color: 'var(--fg)' }}>
                                            Claude Code Remote Control
                                        </th>
                                        <th scope="col" className="px-4 py-3 font-semibold" style={{ color: 'var(--fg)' }}>
                                            Happier
                                        </th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {COMPARISON_ROWS.map((row) => (
                                        <tr key={row.id} className="border-t" style={{ borderColor: 'var(--card-border)' }}>
                                            <th
                                                scope="row"
                                                className="px-4 py-3 text-left font-medium"
                                                style={{ color: 'var(--fg)' }}
                                            >
                                                {row.capability}
                                            </th>
                                            <td className="px-4 py-3" style={{ color: 'var(--muted)' }}>
                                                {row.rc}
                                            </td>
                                            <td className="px-4 py-3" style={{ color: 'var(--muted)' }}>
                                                {row.happier}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </div>
                </div>
            </section>

            <section className="relative" data-section="rc-difference">
                <div className="mx-auto max-w-[1400px] px-6 py-10 md:px-10 md:py-14">
                    <div className="max-w-[860px]">
                        <h2 className="font-display text-[26px] font-normal leading-[1.14] tracking-[-0.025em] md:text-[34px]">
                            What one client for {AGENTS.length} agents buys you
                        </h2>
                        <p className="mt-4 max-w-[720px] text-[16px] leading-[1.65]" style={{ color: 'var(--muted)' }}>{rich(PAGE_PROSE.vsRemoteControlPage.p4)}</p>
                        <dl className="mt-7 grid gap-6 md:grid-cols-2">
                            {RC_SECTION.arguments.map((item) => (
                                <div key={item.id}>
                                    <dt className="text-[16px] font-semibold" style={{ color: 'var(--fg)' }}>
                                        {item.title}
                                    </dt>
                                    <dd className="mt-2 text-[15px] leading-[1.62]" style={{ color: 'var(--muted)' }}>
                                        {item.body}
                                    </dd>
                                </div>
                            ))}
                        </dl>
                        <p className="mt-7 max-w-[720px] text-[16px] leading-[1.68]" style={{ color: 'var(--muted)' }}>{rich(PAGE_PROSE.vsRemoteControlPage.p5, { 1: (c: ReactNode) => <code className="font-mono">{c}</code> })}</p>
                        <p className="mt-4 max-w-[720px] text-[16px] leading-[1.68]" style={{ color: 'var(--muted)' }}>{rich(PAGE_PROSE.vsRemoteControlPage.p6, { 1: (c: ReactNode) => <a href="/agents" className="underline underline-offset-2" style={{ color: 'var(--fg)' }}>{c}</a> }, { length: AGENTS.length })}</p>
                    </div>
                </div>
            </section>

            <Prose heading="Trying it" data-section="rc-cta">
                <P>{rich(PAGE_PROSE.vsRemoteControlPage.p7)}</P>
                <div data-cta-location="call-to-action">
                    <InstallCommand />
                </div>
                {/*
                  * This used to end "…that is a correct conclusion and the first
                  * paragraph said so before you did." Candour about where the
                  * other product fits belongs in the concession at the top,
                  * where it is; a closing line that scores a point off the
                  * reader for having read the page is self-deprecation, and the
                  * editorial contract is honest but never self-defeating. The
                  * CTA ends on what the reader does next instead.
                  */}
                <P>
                    Then <code className="font-mono">happier claude</code> in a repository — or{' '}
                    <code className="font-mono">happier codex</code>, or any of the other{' '}
                    {AGENTS.length - 2} subcommands. The conditions above are the ones that decide
                    it; everything else on this page is the detail behind them.
                </P>
            </Prose>
        </PageShell>
    );
}
