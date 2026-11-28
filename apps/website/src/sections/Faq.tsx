import { RevealText } from '../components/RevealText';
import { FaqList } from '../components/FaqList';
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

                <FaqList className="mx-auto max-w-[820px]" items={FAQ_ITEMS} />
            </div>
        </section>
    );
}
