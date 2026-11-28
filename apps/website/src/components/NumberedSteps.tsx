import type { ReactNode } from 'react';

export type NumberedStep = {
    id: string;
    title: ReactNode;
    body: ReactNode;
    /** Optional action beside the step on desktop, under it on a phone. */
    aside?: ReactNode;
};

/**
 * The numbered rail: a timeline the eye follows top to bottom, with a hairline
 * connector running down through the numbers so the sequence is unmistakable.
 *
 * One component for the homepage's "Get started" (`size="lg"`, each step with a
 * CTA beside it) and the promises on /open (`size="sm"`, prose only, the lab's
 * 26 px rail). The two sizes differ only in scale; the structure, the connector
 * and the min-width guards are shared so they cannot drift.
 */
export function NumberedSteps({
    steps,
    size = 'lg',
    className = '',
}: {
    steps: ReadonlyArray<NumberedStep>;
    size?: 'lg' | 'sm';
    className?: string;
}) {
    const lg = size === 'lg';
    return (
        <ol className={`list-none p-0 ${className}`.trim()}>
            {steps.map((step, idx) => {
                const isLast = idx === steps.length - 1;
                return (
                    <li
                        key={step.id}
                        className={lg ? 'grid grid-cols-[40px_1fr] gap-x-5 sm:gap-x-8' : 'grid grid-cols-[26px_1fr] gap-x-[22px]'}
                    >
                        {/* Left rail: number + vertical connector line */}
                        <div className="flex flex-col items-center">
                            <div
                                aria-hidden
                                className={
                                    lg
                                        ? 'flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-[15px] font-bold'
                                        : 'flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-full text-[12px] font-semibold tabular-nums'
                                }
                                style={{ background: 'var(--fg)', color: 'var(--bg)' }}
                            >
                                {idx + 1}
                            </div>
                            {!isLast && (
                                <div
                                    aria-hidden
                                    className={lg ? 'mt-2 w-px flex-1' : 'mb-1 mt-1 w-px flex-1'}
                                    style={{
                                        background: lg
                                            ? 'linear-gradient(to bottom, var(--card-border) 0%, var(--card-border) 72%, transparent 100%)'
                                            : 'var(--card-border)',
                                    }}
                                />
                            )}
                        </div>

                        {/* Content: text, and this step's aside to its right on desktop.
                            min-w-0 on both this track and the aside cell: a grid item
                            defaults to min-width:auto, which would let a wide aside (the
                            install command) push the page wider than a phone instead of
                            letting it truncate. */}
                        <div
                            className={`grid min-w-0 ${step.aside ? 'gap-y-5 md:grid-cols-[minmax(0,1fr)_auto] md:items-start md:gap-x-10' : ''} ${
                                isLast ? 'pb-0' : lg ? 'pb-14' : 'pb-[30px]'
                            }`}
                        >
                            <div className={lg ? 'pt-[7px]' : ''}>
                                <h3
                                    className={
                                        lg
                                            ? 'text-[18px] font-semibold leading-[1.3] md:text-[20px]'
                                            : 'mb-1 text-[18px] font-semibold leading-[26px] [text-wrap:balance]'
                                    }
                                    style={{ color: 'var(--fg)' }}
                                >
                                    {step.title}
                                </h3>
                                <p
                                    className={
                                        lg
                                            ? 'mt-2 max-w-[440px] text-[14px] leading-[1.55] md:text-[15px]'
                                            : 'max-w-[760px] text-[16px] leading-[1.65] [text-wrap:pretty]'
                                    }
                                    style={{ color: 'var(--muted)' }}
                                >
                                    {step.body}
                                </p>
                            </div>
                            {step.aside ? <div className="min-w-0 md:justify-self-end">{step.aside}</div> : null}
                        </div>
                    </li>
                );
            })}
        </ol>
    );
}
