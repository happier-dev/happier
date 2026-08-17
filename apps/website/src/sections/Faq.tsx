import { RevealText } from '../components/RevealText';
import { trackFaqOpened } from '../analytics/events';
import { useSiteData } from '../i18n/siteData';
import { rich } from '../i18n/rich';

export const FAQ_SECTION_ID = 'faq';

/**
 * FAQ.
 *
 * Rendered as always-open <details> rather than a JS accordion for one reason:
 * the answers are the section's whole SEO value, and content hidden behind a
 * click that only exists in JS is content a crawler may not weigh. `open` by
 * default keeps the text in the first paint; the disclosure affordance is still
 * there for anyone who wants to collapse a long answer.
 */
export function Faq() {
    const { pageProse: { PAGE_PROSE } } = useSiteData();

    const { faq: { FAQ_ITEMS } } = useSiteData();

    return (
        <section id={FAQ_SECTION_ID} data-section="faq" className="relative">
            <div className="section-y mx-auto max-w-[1400px] px-6 md:px-10">
                <div className="section-head mx-auto max-w-[760px] text-center">
                    <div
                        className="mb-5 text-[11.5px] font-semibold uppercase tracking-[0.18em]"
                        style={{ color: 'var(--muted)' }}
                    >{rich(PAGE_PROSE.faq.p0)}</div>
                    <RevealText
                        as="h2"
                        text={PAGE_PROSE.faq.p1}
                        className="font-display text-[36px] font-normal leading-[1.06] tracking-[-0.025em] md:text-[48px] lg:text-[56px]"
                        stagger={60}
                        inView
                    />
                </div>

                <div className="mx-auto max-w-[820px]">
                    {FAQ_ITEMS.map((item) => (
                        <details
                            key={item.id}
                            open
                            className="border-b py-6"
                            style={{ borderColor: 'var(--card-border)' }}
                            /* These render `open`, so in practice this fires when
                               someone COLLAPSES an answer — and that is the useful
                               signal: an entry people close is an entry that is in
                               their way. `question` carries the literal text rather
                               than a slug, so the PostHog breakdown is the keyword
                               report. */
                            onToggle={(event) =>
                                trackFaqOpened({
                                    question: item.q,
                                    open: (event.currentTarget as HTMLDetailsElement).open,
                                })
                            }
                        >
                            <summary
                                className="cursor-pointer list-none"
                                style={{ color: 'var(--fg)' }}
                            >
                                {/* The question is a heading, not a styled span.
                                    Ten question-shaped H3s is exactly what passage
                                    ranking eats, and inside a bare <summary> these
                                    were absent from the document outline entirely. */}
                                <h3 className="inline text-[18px] font-semibold leading-[1.35] md:text-[20px]">
                                    {item.q}
                                </h3>
                            </summary>
                            {item.a.map((paragraph, i) => (
                                <p
                                    key={i}
                                    className="mt-4 text-[15px] leading-[1.62] md:text-[16px]"
                                    style={{ color: 'var(--muted)' }}
                                >
                                    {paragraph}
                                </p>
                            ))}
                        </details>
                    ))}
                </div>
            </div>
        </section>
    );
}
