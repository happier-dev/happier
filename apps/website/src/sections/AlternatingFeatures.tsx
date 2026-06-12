import { FEATURES } from '../data/features';
import { RevealText } from '../components/RevealText';
import { DeviceVisual } from './DeviceVisual';
import clsx from 'clsx';

export function AlternatingFeatures() {
    return (
        <section id="features" className="relative">
            <div className="mx-auto max-w-[1400px] px-6 md:px-10">
                {/* Section eyebrow + heading */}
                <div className="mx-auto mb-20 max-w-[760px] text-center md:mb-28">
                    <div
                        className="mb-5 text-[11.5px] font-semibold uppercase tracking-[0.18em]"
                        style={{ color: 'var(--muted)' }}
                    >
                        What Happier does
                    </div>
                    <RevealText
                        as="h2"
                        text={'One control room\nfor every coding agent.'}
                        className="font-display text-[36px] font-normal leading-[1.06] tracking-[-0.025em] md:text-[48px] lg:text-[56px]"
                        stagger={60}
                    />
                    <p
                        className="mx-auto mt-6 max-w-[560px] text-[17px] leading-[1.55] md:text-[18px]"
                        style={{ color: 'var(--muted)' }}
                    >
                        Happier is the mobile-native control layer for the AI coding agents you already use.
                        It mirrors your terminal, syncs every session, and gives you back the things a CLI
                        can&apos;t: presence, approvals, voice, and one inbox for all of it.
                    </p>
                </div>

                <div className="space-y-32 md:space-y-44 lg:space-y-52">
                    {FEATURES.map((feature, idx) => {
                        const flip = idx % 2 === 1;
                        return (
                            <article
                                key={feature.id}
                                className={clsx(
                                    'grid items-center gap-10 md:gap-16 lg:gap-24',
                                    'md:grid-cols-2',
                                )}
                            >
                                <div className={clsx('order-2', flip ? 'md:order-2' : 'md:order-1')}>
                                    <div
                                        className="mb-4 text-[11.5px] font-semibold uppercase tracking-[0.18em]"
                                        style={{ color: 'var(--muted)' }}
                                    >
                                        {feature.eyebrow}
                                    </div>
                                    <RevealText
                                        as="h3"
                                        text={feature.title}
                                        className="font-display text-[36px] font-normal leading-[1.06] tracking-[-0.025em] md:text-[48px] lg:text-[56px]"
                                        stagger={50}
                                    />
                                    <p
                                        className="mt-5 max-w-[520px] text-[17px] leading-[1.55] md:text-[18px]"
                                        style={{ color: 'var(--muted)' }}
                                    >
                                        {feature.body}
                                    </p>
                                </div>

                                <div className={clsx('order-1', flip ? 'md:order-1' : 'md:order-2')}>
                                    <DeviceVisual
                                        kind={feature.visual}
                                        accent={feature.accent}
                                        side={flip ? 'left' : 'right'}
                                    />
                                </div>
                            </article>
                        );
                    })}
                </div>
            </div>
        </section>
    );
}
