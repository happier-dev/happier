import type { ReactNode } from 'react';
import { RevealText } from '../components/RevealText';
import { InstallCommand } from '../components/InstallCommand';
import { rich } from '../i18n/rich';
import { useSiteData } from '../i18n/siteData';

/**
 * The CTA for each step, keyed by the id in GET_STARTED_STEPS.
 *
 * The step's title and description moved to src/data/pageProse.ts so the
 * overlay translates them; what stayed here is the half that is JSX and has no
 * business in a data module. Keyed rather than positional so the two halves
 * cannot drift apart when a step is added or reordered.
 */
const STEP_CTAS: Record<string, ReactNode> = {
    install: <InstallCommand />,
    setup: <CommandChip command="happier setup" />,
    pair: <QrChip />,
    session: <CommandChip command="happier claude" />,
};

export const GET_STARTED_SECTION_ID = 'get-started';

export function GetStarted() {
    const { pageProse: { PAGE_PROSE, GET_STARTED_STEPS } } = useSiteData();

    return (
        <section id={GET_STARTED_SECTION_ID} data-section="get-started" className="relative">
            <div className="section-y mx-auto max-w-[1400px] px-6 md:px-10">
                <div className="section-head mx-auto max-w-[760px] text-center">
                    <div
                        className="mb-5 text-[11.5px] font-semibold uppercase tracking-[0.18em]"
                        style={{ color: 'var(--muted)' }}
                    >{rich(PAGE_PROSE.getStarted.p0)}</div>
                    <RevealText
                        as="h2"
                        text={PAGE_PROSE.getStarted.p2}
                        className="font-display text-[36px] font-normal leading-[1.06] tracking-[-0.025em] md:text-[48px] lg:text-[56px]"
                        stagger={60}
                    />
                </div>

                {/* Vertical stepper: a timeline the eye follows top-to-bottom.
                    Each step's CTA sits to its right on desktop (using the width)
                    and stacks beneath the text on mobile. The connector line runs
                    down through the numbers so the sequence is unmistakable. */}
                <div className="mx-auto max-w-[920px]">
                    {GET_STARTED_STEPS.map((step, idx) => {
                        const isLast = idx === GET_STARTED_STEPS.length - 1;
                        return (
                            <div key={step.id} className="grid grid-cols-[40px_1fr] gap-x-5 sm:gap-x-8">
                                {/* Left rail: number + vertical connector line */}
                                <div className="flex flex-col items-center">
                                    <div
                                        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-[15px] font-bold"
                                        style={{ background: 'var(--fg)', color: 'var(--bg)' }}
                                    >
                                        {idx + 1}
                                    </div>
                                    {!isLast && (
                                        <div
                                            aria-hidden
                                            className="mt-2 w-px flex-1"
                                            style={{
                                                background:
                                                    'linear-gradient(to bottom, var(--card-border) 0%, var(--card-border) 72%, transparent 100%)',
                                            }}
                                        />
                                    )}
                                </div>

                                {/* Content: text on the left, this step's CTA on the right.
                                    min-w-0 on both this track and the CTA cell: a grid item
                                    defaults to min-width:auto, which would let the install
                                    command's min-content width push the whole page wider than
                                    the viewport on a phone instead of letting the chip truncate. */}
                                <div
                                    className={`grid min-w-0 gap-y-5 md:grid-cols-[minmax(0,1fr)_auto] md:items-start md:gap-x-10 ${isLast ? 'pb-0' : 'pb-14'}`}
                                >
                                    <div className="pt-[7px]">
                                        <h3
                                            className="text-[18px] font-semibold leading-[1.3] md:text-[20px]"
                                            style={{ color: 'var(--fg)' }}
                                        >
                                            {step.title}
                                        </h3>
                                        <p
                                            className="mt-2 max-w-[440px] text-[14px] leading-[1.55] md:text-[15px]"
                                            style={{ color: 'var(--muted)' }}
                                        >
                                            {step.description}
                                        </p>
                                    </div>
                                    <div className="min-w-0 md:justify-self-end">{STEP_CTAS[step.id]}</div>
                                </div>
                            </div>
                        );
                    })}
                </div>
            </div>
        </section>
    );
}

/** A small QR placeholder for the "pair your device" step. */
function QrChip() {
    const { pageProse: { PAGE_PROSE } } = useSiteData();

    return (
        <div className="inline-flex items-center gap-3">
            <div
                className="grid h-[72px] w-[72px] shrink-0 place-items-center rounded-xl border p-2.5"
                style={{ borderColor: 'var(--card-border)', background: 'var(--card)' }}
                aria-hidden
            >
                <svg viewBox="0 0 24 24" className="h-full w-full" style={{ color: 'var(--fg)' }}>
                    {/* Finder squares */}
                    <path
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        d="M3 3h6v6H3zM15 3h6v6h-6zM3 15h6v6H3z"
                    />
                    <rect x="5" y="5" width="2" height="2" fill="currentColor" />
                    <rect x="17" y="5" width="2" height="2" fill="currentColor" />
                    <rect x="5" y="17" width="2" height="2" fill="currentColor" />
                    {/* Data modules */}
                    <g fill="currentColor">
                        <rect x="15" y="13" width="2" height="2" />
                        <rect x="19" y="13" width="2" height="2" />
                        <rect x="13" y="15" width="2" height="2" />
                        <rect x="17" y="17" width="2" height="2" />
                        <rect x="13" y="19" width="2" height="2" />
                        <rect x="19" y="19" width="2" height="2" />
                        <rect x="15" y="21" width="2" height="2" opacity="0" />
                    </g>
                </svg>
            </div>
            <span className="text-[13px] leading-[1.4]" style={{ color: 'var(--muted)' }}>{rich(PAGE_PROSE.getStarted.p1, { 1: () => <br /> })}</span>
        </div>
    );
}

/** A literal command, shown as the CTA for a step that is just "type this". */
function CommandChip({ command }: { command: string }) {
    return (
        <div
            className="inline-flex items-center gap-2 rounded-2xl border px-4 py-3 font-mono text-[13px]"
            style={{ borderColor: 'var(--card-border)', color: 'var(--fg)' }}
        >
            <span aria-hidden style={{ color: 'var(--muted)' }}>
                $
            </span>
            <code>{command}</code>
        </div>
    );
}
