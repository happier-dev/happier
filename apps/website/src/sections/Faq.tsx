import { RevealText } from '../components/RevealText';
import { trackFaqOpened } from '../analytics/events';
import { useSiteData } from '../i18n/siteData';
import { rich } from '../i18n/rich';

export const FAQ_SECTION_ID = 'faq';

/**
 * FAQ.
 *
 * Collapsed <details>, opened by tap. Still no JS accordion — the browser's own
 * disclosure does the work, so this keeps behaving correctly in an island-free
 * prose page and cannot be broken by a bundle that fails to load.
 *
 * WHY COLLAPSED IS SAFE HERE, given this used to render `open` on purpose. The
 * original reason was that the answers are the section's whole SEO value (there
 * is deliberately no FAQPage JSON-LD — see src/data/faq.ts — so the visible text
 * is all there is), and hidden content might be weighed less. Two things make
 * that not apply. A closed <details> still carries its answers in the HTML
 * SOURCE — this is native disclosure, not JS that injects on click, so a crawler
 * parses the same bytes either way; assert:crawlable would catch it if that ever
 * stopped being true. And discounting collapsed content is pre-mobile-first
 * guidance: an accordion is the normal way a phone shows a long FAQ, which is
 * exactly why indexing stopped penalising it.
 *
 * What collapsing does change is the reading: fourteen open answers is a wall
 * the reader has to scroll past to find their question. The questions are the
 * index, and an index works by being scannable.
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
                            className="faq__item"
                            /* Now that these start closed this fires on OPEN, which
                               is the more direct signal than the collapse it used to
                               record: an entry people open is an entry the page left
                               them wondering about. `question` carries the literal
                               text rather than a slug, so the PostHog breakdown is
                               the keyword report. */
                            onToggle={(event) =>
                                trackFaqOpened({
                                    question: item.q,
                                    open: (event.currentTarget as HTMLDetailsElement).open,
                                })
                            }
                        >
                            <summary className="faq__q" style={{ color: 'var(--fg)' }}>
                                {/* The question is a heading, not a styled span.
                                    Ten question-shaped H3s is exactly what passage
                                    ranking eats, and inside a bare <summary> these
                                    were absent from the document outline entirely. */}
                                <h3 className="text-[18px] font-semibold leading-[1.35] md:text-[20px]">
                                    {item.q}
                                </h3>
                                {/* A closed row with no affordance is just text that
                                    mysteriously does something when pressed. Inline
                                    SVG rather than a glyph so it inherits colour and
                                    rotates on the compositor. */}
                                <svg
                                    aria-hidden
                                    className="faq__chev"
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="1.6"
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                >
                                    <path d="m6 9 6 6 6-6" />
                                </svg>
                            </summary>
                            <div className="faq__a">
                                {item.a.map((paragraph, i) => (
                                    <p
                                        key={i}
                                        className="mt-4 text-[15px] leading-[1.62] md:text-[16px]"
                                        style={{ color: 'var(--muted)' }}
                                    >
                                        {paragraph}
                                    </p>
                                ))}
                            </div>
                        </details>
                    ))}
                </div>
            </div>
        </section>
    );
}
