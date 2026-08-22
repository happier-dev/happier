import { RevealText } from '../components/RevealText';
import { useSiteData } from '../i18n/siteData';
import { rich } from '../i18n/rich';

export function FeatureGrid() {
    const { pageProse: { PAGE_PROSE } } = useSiteData();

    const { features: { GRID_FEATURES } } = useSiteData();

    return (
        <section className="relative" data-section="feature-grid">
            <div className="section-y mx-auto max-w-[1400px] px-6 md:px-10">
                <div className="section-head mx-auto max-w-[760px] text-center">
                    <div
                        className="mb-5 text-[11.5px] font-semibold uppercase tracking-[0.18em]"
                        style={{ color: 'var(--muted)' }}
                    >{rich(PAGE_PROSE.featureGrid.p0)}</div>
                    <RevealText
                        as="h2"
                        text={PAGE_PROSE.featureGrid.p1}
                        className="font-display text-[36px] font-normal leading-[1.06] tracking-[-0.025em] md:text-[48px] lg:text-[56px]"
                        stagger={60}
                    />
                </div>

                <div className="fgrid">
                    {GRID_FEATURES.map((feature) => {
                        return (
                            <div key={feature.id} className="fgrid__cell">
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
