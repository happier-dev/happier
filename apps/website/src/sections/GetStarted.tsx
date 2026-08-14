import type { ReactNode } from 'react';
import { RevealText } from '../components/RevealText';
import { InstallCommand } from '../components/InstallCommand';

type Step = {
    number: number;
    title: string;
    description: string;
    cta: ReactNode;
};

/**
 * Each step owns the call-to-action it describes, so the flow reads as a
 * self-contained checklist: download here, install here, pair here, run here.
 */
/**
 * Order matters here and it was backwards.
 *
 * The old step 1 was "download the app" — which sends someone to a phone store
 * before they have a machine for the phone to talk to, and that is precisely the
 * cohort that churns: 56% of installs open the app on exactly one day, median
 * lifetime two minutes. Happier does nothing until a computer is set up, so the
 * computer goes first and the phone comes third, once there is something for it
 * to connect to.
 *
 * The old step 4 read "Run happier instead of claude or codex", which is not the
 * CLI's syntax. `happier` wraps the agent, it does not replace it —
 * `happier claude`, `happier codex` (clients/cli.mdx:539-540).
 */
const STEPS: ReadonlyArray<Step> = [
    {
        number: 1,
        title: 'Install on the computer with your code',
        description: 'One command. macOS, Linux, and Windows. Signed and checksum-verified.',
        cta: <InstallCommand />,
    },
    {
        number: 2,
        title: 'Run setup',
        description:
            'Signs you in and installs the background service that keeps this machine reachable while you are away from it.',
        cta: <CommandChip command="happier setup" />,
    },
    {
        number: 3,
        title: 'Pair a device',
        description:
            'happier auth login prints a QR code. Scan it with the app, or open the URL it prints in any browser.',
        cta: <QrChip />,
    },
    {
        number: 4,
        title: 'Start a session',
        description:
            'Launch any of the 13 agents through Happier and it is live on every signed-in device at once.',
        cta: <CommandChip command="happier claude" />,
    },
];

export const GET_STARTED_SECTION_ID = 'get-started';

export function GetStarted() {
    return (
        <section id={GET_STARTED_SECTION_ID} data-section="get-started" className="relative">
            <div className="section-y mx-auto max-w-[1400px] px-6 md:px-10">
                <div className="section-head mx-auto max-w-[760px] text-center">
                    <div
                        className="mb-5 text-[11.5px] font-semibold uppercase tracking-[0.18em]"
                        style={{ color: 'var(--muted)' }}
                    >
                        Get started
                    </div>
                    <RevealText
                        as="h2"
                        text={'Up and running\nin under a minute.'}
                        className="font-display text-[36px] font-normal leading-[1.06] tracking-[-0.025em] md:text-[48px] lg:text-[56px]"
                        stagger={60}
                    />
                </div>

                {/* Vertical stepper: a timeline the eye follows top-to-bottom.
                    Each step's CTA sits to its right on desktop (using the width)
                    and stacks beneath the text on mobile. The connector line runs
                    down through the numbers so the sequence is unmistakable. */}
                <div className="mx-auto max-w-[920px]">
                    {STEPS.map((step, idx) => {
                        const isLast = idx === STEPS.length - 1;
                        return (
                            <div key={step.number} className="grid grid-cols-[40px_1fr] gap-x-5 sm:gap-x-8">
                                {/* Left rail: number + vertical connector line */}
                                <div className="flex flex-col items-center">
                                    <div
                                        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-[15px] font-bold"
                                        style={{ background: 'var(--fg)', color: 'var(--bg)' }}
                                    >
                                        {step.number}
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
                                    <div className="min-w-0 md:justify-self-end">{step.cta}</div>
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
            <span className="text-[13px] leading-[1.4]" style={{ color: 'var(--muted)' }}>
                Scan from
                <br />
                your terminal
            </span>
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
