import type { ReactNode } from 'react';

import { P, PageHeader, PageShell, Prose } from '../components/PageShell';
import { TERMINAL_DOCS_URL } from '../data/terminalFeature';
import { useSiteData } from '../i18n/siteData';
import { rich } from '../i18n/rich';

/**
 * `happier attach` in backticks → a real <code> element.
 *
 * The copy in src/data/terminalFeature.ts is a plain string so it can be
 * diffed, searched and asserted on without a JSX parser. That leaves exactly
 * one formatting need — the commands — and a two-line split is cheaper than
 * either a markdown dependency or a copy file full of fragments. Anything with
 * an odd number of backticks renders its stray one literally, which is the
 * right failure: visible, and obviously a typo.
 */
function withCode(text: string): ReactNode[] {
    return text.split('`').map((part, index) =>
        index % 2 === 1 ? (
            <code key={`${index}-${part}`} className="font-mono text-[0.94em]">
                {part}
            </code>
        ) : (
            <span key={`${index}-${part}`}>{part}</span>
        ),
    );
}

/**
 * /features/terminal
 *
 * Written for the reader who is not going to give up their TUI, because that is
 * the single most common reason someone bounces off a "code from your phone"
 * page. The claim is not "you can also use a terminal" — every tool says that.
 * The claim is that it is ONE session with two front ends, and the evidence for
 * it is that the session id, transcript and queue survive the switch.
 *
 * Evaluation intent only. The step list (enabling tmux, choosing a Windows
 * mode, docking the embedded terminal) is linked once and not repeated.
 *
 * THE H1 WAS "Keep your terminal. Or never open one.", WHICH MEANS NOTHING COLD.
 * It reads as a promise to someone who already knows what the page is about, and
 * it carries no noun anybody types: not Claude Code, not Codex, not tmux. The
 * headings now name the agents whose terminals this is about, because "Claude
 * Code terminal" and "Codex TUI" are the queries this page exists to answer, and
 * "The catch" — a heading that told the reader only that something was wrong —
 * is now the list of what attaching actually needs.
 */
export function TerminalPage() {
    const { pageProse: { PAGE_PROSE } } = useSiteData();

    const { terminalFeature: { CLAUDE_UNIFIED, CLAUDE_UNIFIED_HEADING, CONTROL_ROWS, TERMINAL_CATCH, TERMINAL_INTRO, TERMINAL_MOVES } } = useSiteData();

    return (
        <PageShell>
            <PageHeader
                eyebrow={PAGE_PROSE.terminalPage.p3}
                title={PAGE_PROSE.terminalPage.p4}
                standfirst={PAGE_PROSE.terminalPage.p5}
            />

            <Prose data-section="terminal-intro">
                {TERMINAL_INTRO.map((paragraph) => (
                    <P key={paragraph.slice(0, 32)}>{paragraph}</P>
                ))}
            </Prose>

            <section className="relative" data-section="terminal-moves">
                <div className="mx-auto max-w-[1400px] px-6 py-10 md:px-10 md:py-14">
                    <div className="max-w-[860px]">
                        <h2 className="font-display text-[26px] font-normal leading-[1.14] tracking-[-0.025em] md:text-[34px]">{rich(PAGE_PROSE.terminalPage.p6)}</h2>
                        <dl className="mt-7 grid gap-7 md:grid-cols-2">
                            {TERMINAL_MOVES.map((item) => (
                                <div key={item.id}>
                                    <dt className="text-[16px] font-semibold" style={{ color: 'var(--fg)' }}>
                                        {item.title}
                                    </dt>
                                    <dd className="mt-2 text-[15px] leading-[1.62]" style={{ color: 'var(--muted)' }}>
                                        {withCode(item.body)}
                                    </dd>
                                </div>
                            ))}
                        </dl>
                    </div>
                </div>
            </section>

            <section className="relative" data-section="terminal-support">
                <div className="mx-auto max-w-[1400px] px-6 py-10 md:px-10 md:py-14">
                    <div className="max-w-[900px]">
                        <h2 className="font-display text-[26px] font-normal leading-[1.14] tracking-[-0.025em] md:text-[34px]">{rich(PAGE_PROSE.terminalPage.p7)}</h2>
                        <p
                            className="mt-4 max-w-[720px] text-[16px] leading-[1.65]"
                            style={{ color: 'var(--muted)' }}
                        >{rich(PAGE_PROSE.terminalPage.p0)}</p>
                        <div
                            className="mt-6 overflow-x-auto rounded-2xl border"
                            style={{ borderColor: 'var(--card-border)' }}
                        >
                            <table className="w-full min-w-[720px] border-collapse text-left text-[14px]">
                                <thead>
                                    <tr>
                                        <th scope="col" className="px-4 py-3 font-semibold" style={{ color: 'var(--fg)' }}>{rich(PAGE_PROSE.terminalPage.p8)}</th>
                                        <th scope="col" className="px-4 py-3 font-semibold" style={{ color: 'var(--fg)' }}>{rich(PAGE_PROSE.terminalPage.p9)}</th>
                                        <th scope="col" className="px-4 py-3 font-semibold" style={{ color: 'var(--fg)' }}>{rich(PAGE_PROSE.terminalPage.p10)}</th>
                                        <th scope="col" className="px-4 py-3 font-semibold" style={{ color: 'var(--fg)' }}>{rich(PAGE_PROSE.terminalPage.p11)}</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {CONTROL_ROWS.map((row) => (
                                        <tr key={row.id} className="border-t" style={{ borderColor: 'var(--card-border)' }}>
                                            <th
                                                scope="row"
                                                className="px-4 py-3 text-left font-medium"
                                                style={{ color: 'var(--fg)' }}
                                            >
                                                {row.agent}
                                            </th>
                                            <td className="px-4 py-3 whitespace-nowrap" style={{ color: 'var(--fg)' }}>
                                                {row.topology}
                                            </td>
                                            <td className="px-4 py-3 whitespace-nowrap" style={{ color: 'var(--muted)' }}>
                                                {row.attach}
                                            </td>
                                            <td className="px-4 py-3" style={{ color: 'var(--muted)' }}>
                                                {row.note}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                        <p
                            className="mt-5 max-w-[720px] text-[16px] leading-[1.65]"
                            style={{ color: 'var(--muted)' }}
                        >{rich(PAGE_PROSE.terminalPage.p1, { 1: (c: ReactNode) => <code className="font-mono">{c}</code> })}</p>
                    </div>
                </div>
            </section>

            {/*
              * The Claude-specific section.
              *
              * It sits after the table because the table is what makes it
              * legible: "both at once" is the row it explains. Every claim in
              * it is sourced in the docblock at the top of
              * src/data/terminalFeature.ts, including the two things it
              * deliberately does NOT say — that the runtime is on by default,
              * and that it works on native Windows. Neither is true.
              */}
            <Prose heading={CLAUDE_UNIFIED_HEADING} data-section="terminal-claude-unified">
                {CLAUDE_UNIFIED.map((paragraph) => (
                    <P key={paragraph.slice(0, 32)}>{withCode(paragraph)}</P>
                ))}
            </Prose>

            <Prose heading={PAGE_PROSE.terminalPage.p12} data-section="terminal-catch">
                {TERMINAL_CATCH.map((paragraph) => (
                    <P key={paragraph.slice(0, 32)}>{withCode(paragraph)}</P>
                ))}
            </Prose>

            <Prose heading={PAGE_PROSE.terminalPage.p13} data-section="terminal-docs">
                <P>{rich(PAGE_PROSE.terminalPage.p2, { 1: (c: ReactNode) => <a
                        href={TERMINAL_DOCS_URL}
                        className="underline underline-offset-2"
                        style={{ color: 'var(--fg)' }}
                    >{c}</a> })}</P>
            </Prose>
        </PageShell>
    );
}
