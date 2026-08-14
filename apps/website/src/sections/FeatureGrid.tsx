import { RevealText } from '../components/RevealText';
import { useSiteData } from '../i18n/siteData';

export function FeatureGrid() {
    const { features: { GRID_FEATURES } } = useSiteData();

    return (
        <section className="relative" data-section="feature-grid">
            <div className="section-y mx-auto max-w-[1400px] px-6 md:px-10">
                <div className="section-head mx-auto max-w-[760px] text-center">
                    <div
                        className="mb-5 text-[11.5px] font-semibold uppercase tracking-[0.18em]"
                        style={{ color: 'var(--muted)' }}
                    >
                        And there&apos;s more
                    </div>
                    <RevealText
                        as="h2"
                        text={'Everything else\nyou didn\u2019t know you needed.'}
                        className="font-display text-[36px] font-normal leading-[1.06] tracking-[-0.025em] md:text-[48px] lg:text-[56px]"
                        stagger={60}
                    />
                </div>

                <div
                    className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4"
                    style={{ borderColor: 'var(--card-border)' }}
                >
                    {GRID_FEATURES.map((feature, idx) => {
                        const col = idx % 4;
                        const row = Math.floor(idx / 4);
                        const totalRows = Math.ceil(GRID_FEATURES.length / 4);
                        return (
                            <div
                                key={feature.id}
                                className="px-6 py-7 md:px-7 md:py-8"
                                style={{
                                    borderColor: 'var(--card-border)',
                                    borderTopWidth: row === 0 ? '1px' : '0',
                                    borderBottomWidth: '1px',
                                    borderLeftWidth: col === 0 ? '1px' : '0',
                                    borderRightWidth: '1px',
                                    borderStyle: 'solid',
                                    // On mobile (1-col) and sm (2-col), override the
                                    // desktop border logic with simpler rules via CSS.
                                }}
                            >
                                <h3
                                    className="text-[17px] font-semibold leading-[1.3] md:text-[18px]"
                                    style={{ color: 'var(--fg)' }}
                                >
                                    {feature.title}
                                </h3>
                                <p
                                    className="mt-2 text-[14px] leading-[1.55] md:text-[15px]"
                                    style={{ color: 'var(--muted)' }}
                                >
                                    {feature.body}
                                </p>
                            </div>
                        );
                    })}
                </div>
            </div>
        </section>
    );
}
