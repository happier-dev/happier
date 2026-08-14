import { RevealText } from '../components/RevealText';
import { useSiteData } from '../i18n/siteData';
import { rich } from '../i18n/rich';
import type { ReactNode } from 'react';

export const VS_REMOTE_CONTROL_SECTION_ID = 'vs-remote-control';

/**
 * The positioning section.
 *
 * It used to be an objection-handling block with a feature table in it, which
 * put a competitor's axes on our own homepage and invited the visitor to score
 * us on them. The table now lives only on /vs/claude-code-remote-control, where
 * a reader has self-selected into wanting it.
 *
 * What is left is the six things that only exist because one client runs every
 * agent. Layout intent: the headline states the landscape in three short
 * sentences, the sub-line names the product, and the six arguments are a plain
 * grid — no table, no ticks, no column labelled with someone else's brand.
 *
 * THE COUNT IS A LAYOUT CONSTRAINT AS WELL AS AN EDITORIAL ONE. The grid below
 * is two columns at sm and three at lg. Five cards left a hole in the second
 * row on every wide screen, which reads as a rendering bug rather than as a
 * deliberate list. Six fills both rows at three columns and both rows at two.
 * If a seventh card is ever added, add an eighth with it.
 */
export function VsRemoteControl() {
    const { pageProse: { PAGE_PROSE } } = useSiteData();

    const { comparison: { RC_SECTION } } = useSiteData();

    return (
        <section id={VS_REMOTE_CONTROL_SECTION_ID} data-section="vs-remote-control" className="relative">
            <div className="section-y mx-auto max-w-[1400px] px-6 md:px-10">
                <div className="section-head mx-auto max-w-[900px] text-center">
                    <div
                        className="mb-5 text-[11.5px] font-semibold uppercase tracking-[0.18em]"
                        style={{ color: 'var(--muted)' }}
                    >
                        {RC_SECTION.eyebrow}
                    </div>
                    <RevealText
                        as="h2"
                        text={RC_SECTION.title}
                        className="font-display text-[32px] font-normal leading-[1.08] tracking-[-0.025em] md:text-[44px] lg:text-[52px]"
                        stagger={60}
                        inView
                    />
                    <p
                        className="mx-auto mt-6 max-w-[720px] text-[17px] leading-[1.62] md:text-[18px]"
                        style={{ color: 'var(--muted)' }}
                    >
                        {RC_SECTION.subline}
                    </p>
                </div>

                <div className="mx-auto mt-14 grid max-w-[1100px] gap-px sm:grid-cols-2 lg:grid-cols-3">
                    {RC_SECTION.arguments.map((item) => (
                        <div
                            key={item.id}
                            className="border p-6 md:p-7"
                            style={{ borderColor: 'var(--card-border)' }}
                        >
                            <h3
                                className="text-[17px] font-semibold leading-[1.3]"
                                style={{ color: 'var(--fg)' }}
                            >
                                {item.title}
                            </h3>
                            <p
                                className="mt-3 text-[14px] leading-[1.55]"
                                style={{ color: 'var(--muted)' }}
                            >
                                {item.body}
                            </p>
                        </div>
                    ))}
                </div>

                <p
                    className="mx-auto mt-10 max-w-[760px] text-center text-[15px] leading-[1.6]"
                    style={{ color: 'var(--muted)' }}
                >{rich(PAGE_PROSE.vsRemoteControl.p0, { 1: (c: ReactNode) => <a
                        href="/vs/claude-code-remote-control"
                        className="underline underline-offset-2"
                        style={{ color: 'var(--fg)' }}
                    >{c}</a> })}</p>
            </div>
        </section>
    );
}
