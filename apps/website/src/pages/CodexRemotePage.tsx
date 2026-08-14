import { P, PageHeader, PageShell, Prose } from '../components/PageShell';
import { InstallCommand } from '../components/InstallCommand';
import { useSiteData } from '../i18n/siteData';
import { rich } from '../i18n/rich';
import type { ReactNode } from 'react';

/**
 * /vs/codex-remote
 *
 * The Codex half of the comparison pair, and deliberately the SAME structure and
 * register as /vs/claude-code-remote-control. Two comparison pages that argue in
 * different shapes read as two different arguments about the same product; a
 * reader who lands on both should recognise the second one immediately.
 *
 *   1. concede, in detail, before qualifying anything
 *   2. what Codex's own remote does well, specifically — from OpenAI's docs
 *   3. the documented conditions it runs under
 *   4. the scope limit, stated SEPARATELY because it is not a condition
 *   5. the table, including the three rows OpenAI wins
 *   6. what a client that runs every agent can do that a vendor remote cannot
 *   7. install
 *
 * SEARCH INTENT. This page answers "codex mobile" and "codex remote" — two
 * shapes of the same question, which is "can I drive Codex from my phone". It
 * answers them by describing OpenAI's surface accurately, because the visitor
 * asking that question is usually a Codex user, and a Codex user who reads one
 * wrong sentence about Codex closes the tab. The H1 uses OpenAI's own noun
 * ("Remote") and the standfirst uses the reader's ("from your phone").
 *
 * WHAT MUST NOT APPEAR HERE:
 *   • A product called "Codex Mobile". It does not exist. OpenAI put Codex
 *     inside the ChatGPT mobile app.
 *   • An imperative sending the reader to the competitor. The concession is
 *     accurate and unhedged and that is the whole of the honesty budget;
 *     instructing the reader to go and set up the other thing is a different
 *     act, and it was a blocker the last time it shipped.
 */
export function CodexRemotePage() {
    const { pageProse: { PAGE_PROSE } } = useSiteData();

    const { codexRemote: { CODEX_COMPARISON_ROWS, CODEX_SCOPE_LIMIT, CODEX_SECTION }, agents: { AGENTS } } = useSiteData();

    return (
        <PageShell>
            {/*
              * TWO WRONG EYEBROWS, IN ORDER, SO NEITHER COMES BACK — the same
              * pair as the Claude page, and for the same reasons.
              *
              * "Honest comparison": self-praise the reader cannot check, and the
              * two words every unsourced comparison page also uses.
              *
              * "Sourced from OpenAI's docs": the same defect wearing evidence. A
              * label that names where the facts came from tells a stranger
              * nothing about what is on the page. The sourcing rule is stated in
              * the docblock at the top of src/data/codexRemote.ts, and the
              * attribution is made to the reader in body copy — the standfirst,
              * CODEX_SECTION.turn and the dek above the conditions list all name
              * OpenAI outright. The eyebrow names OpenAI's feature instead,
              * which is what someone arriving from search typed.
              */}
            {/*
              * The same H1 edit as the Claude page, in the same shape on
              * purpose: "…and where Happier fits" named no outcome and meant
              * nothing cold. "Codex from your phone" is the query this page
              * exists for; the rest of the line says what it does with it.
              * "Codex Remote" is OpenAI's own label, not a name we minted.
              */}
            <PageHeader
                eyebrow="Codex Remote"
                title="Codex from your phone: Codex Remote and Happier, compared"
                standfirst="OpenAI put Codex inside the ChatGPT mobile app and calls the feature Remote: you pair a phone to a Mac or Windows PC and drive the Codex session running on it. Here is what that covers, the conditions OpenAI’s own documentation puts on it, and the workflow it was never built for."
            />

            <Prose data-section="codex-concession">
                <P>{CODEX_SECTION.concession}</P>
                <P>{CODEX_SECTION.turn}</P>
            </Prose>

            <section className="relative" data-section="codex-strengths">
                <div className="mx-auto max-w-[1400px] px-6 py-10 md:px-10 md:py-14">
                    <div className="max-w-[860px]">
                        <h2 className="font-display text-[26px] font-normal leading-[1.14] tracking-[-0.025em] md:text-[34px]">
                            What Codex’s own remote does well, specifically
                        </h2>
                        <p className="mt-4 max-w-[720px] text-[16px] leading-[1.65]" style={{ color: 'var(--muted)' }}>{rich(PAGE_PROSE.codexRemotePage.p0)}</p>
                        <dl className="mt-7 grid gap-6 md:grid-cols-2">
                            {CODEX_SECTION.strengths.map((item) => (
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

            <section className="relative" data-section="codex-conditions">
                <div className="mx-auto max-w-[1400px] px-6 py-10 md:px-10 md:py-14">
                    <div className="max-w-[860px]">
                        <h2 className="font-display text-[26px] font-normal leading-[1.14] tracking-[-0.025em] md:text-[34px]">
                            The five conditions it runs under
                        </h2>
                        <p className="mt-4 max-w-[720px] text-[16px] leading-[1.65]" style={{ color: 'var(--muted)' }}>{rich(PAGE_PROSE.codexRemotePage.p1)}</p>
                        <ol className="mt-8 space-y-8">
                            {CODEX_SECTION.conditions.map((item, index) => (
                                <li key={item.id}>
                                    <h3 className="text-[18px] font-semibold" style={{ color: 'var(--fg)' }}>
                                        {index + 1}. {item.when}
                                    </h3>
                                    <p className="mt-2 text-[16px] leading-[1.68]" style={{ color: 'var(--muted)' }}>
                                        {item.codex}
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

            <Prose heading={CODEX_SCOPE_LIMIT.heading} data-section="codex-scope">
                <P>{CODEX_SCOPE_LIMIT.body}</P>
                <P>{rich(PAGE_PROSE.codexRemotePage.p2)}</P>
            </Prose>

            <section className="relative" data-section="codex-table">
                <div className="mx-auto max-w-[1400px] px-6 py-10 md:px-10 md:py-14">
                    <div className="max-w-[900px]">
                        <h2 className="font-display text-[26px] font-normal leading-[1.14] tracking-[-0.025em] md:text-[34px]">
                            Will it run in your setup?
                        </h2>
                        <p className="mt-4 max-w-[720px] text-[16px] leading-[1.65]" style={{ color: 'var(--muted)' }}>{rich(PAGE_PROSE.codexRemotePage.p3)}</p>
                        <div
                            className="mt-6 overflow-x-auto rounded-2xl border"
                            style={{ borderColor: 'var(--card-border)' }}
                        >
                            <table className="w-full min-w-[640px] border-collapse text-left text-[14px]">
                                <caption className="px-4 pb-3 pt-4 text-left text-[13px]" style={{ color: 'var(--muted)' }}>
                                    The Codex column restates OpenAI’s published documentation at
                                    learn.chatgpt.com/docs/remote, /docs/remote-connections,
                                    /docs/cloud and /docs/pricing. Verified August 2026.
                                </caption>
                                <thead>
                                    <tr>
                                        <th scope="col" className="px-4 py-3 font-semibold" style={{ color: 'var(--fg)' }}>
                                            Fact
                                        </th>
                                        <th scope="col" className="px-4 py-3 font-semibold" style={{ color: 'var(--fg)' }}>
                                            Codex Remote &amp; Codex cloud
                                        </th>
                                        <th scope="col" className="px-4 py-3 font-semibold" style={{ color: 'var(--fg)' }}>
                                            Happier
                                        </th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {CODEX_COMPARISON_ROWS.map((row) => (
                                        <tr key={row.id} className="border-t" style={{ borderColor: 'var(--card-border)' }}>
                                            <th
                                                scope="row"
                                                className="px-4 py-3 text-left font-medium"
                                                style={{ color: 'var(--fg)' }}
                                            >
                                                {row.capability}
                                            </th>
                                            <td className="px-4 py-3" style={{ color: 'var(--muted)' }}>
                                                {row.codex}
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

            <section className="relative" data-section="codex-difference">
                <div className="mx-auto max-w-[1400px] px-6 py-10 md:px-10 md:py-14">
                    <div className="max-w-[860px]">
                        <h2 className="font-display text-[26px] font-normal leading-[1.14] tracking-[-0.025em] md:text-[34px]">
                            What one client for {AGENTS.length} agents buys you
                        </h2>
                        <p className="mt-4 max-w-[720px] text-[16px] leading-[1.65]" style={{ color: 'var(--muted)' }}>{rich(PAGE_PROSE.codexRemotePage.p4)}</p>
                        <dl className="mt-7 grid gap-6 md:grid-cols-2">
                            {CODEX_SECTION.arguments.map((item) => (
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
                        <p className="mt-7 max-w-[720px] text-[16px] leading-[1.68]" style={{ color: 'var(--muted)' }}>{rich(PAGE_PROSE.codexRemotePage.p5, { 1: (c: ReactNode) => <code className="font-mono">{c}</code> })}</p>
                        <p className="mt-4 max-w-[720px] text-[16px] leading-[1.68]" style={{ color: 'var(--muted)' }}>{rich(PAGE_PROSE.codexRemotePage.p6, { 1: (c: ReactNode) => <a
                                href="/agents/codex"
                                className="underline underline-offset-2"
                                style={{ color: 'var(--fg)' }}
                            >{c}</a>, 2: (c: ReactNode) => <a
                                href="/vs/claude-code-remote-control"
                                className="underline underline-offset-2"
                                style={{ color: 'var(--fg)' }}
                            >{c}</a> })}</p>
                    </div>
                </div>
            </section>

            <Prose heading="Trying it" data-section="codex-cta">
                <P>{rich(PAGE_PROSE.codexRemotePage.p7)}</P>
                <div data-cta-location="call-to-action">
                    <InstallCommand />
                </div>
                <P>{rich(PAGE_PROSE.codexRemotePage.p8, { 1: (c: ReactNode) => <code className="font-mono">{c}</code>, 2: (c: ReactNode) => <code className="font-mono">{c}</code> })}</P>
            </Prose>
        </PageShell>
    );
}
