import { FaqList } from '../components/FaqList';
import { HistoryRibbon } from '../components/HistoryRibbon';
import { PageHeader, PageShell, Prose } from '../components/PageShell';
import { PlanCard } from '../components/PlanCard';
import { useSiteData } from '../i18n/siteData';

/**
 * /plans — every feature free, pay only to keep more.
 *
 * Entirely static: the ribbon is a deterministic SVG, the cards are prose and
 * links, the questions are native disclosures. No island, no stat fetch.
 * Grouped by where a plan runs (Happier Cloud, then any server), no "Popular"
 * badge, no comparison table, monthly only.
 */
export function PlansPage() {
    const {
        plans: { LIMIT_CHANGE_NOTICE, PLANS_PAGE, PLAN_GROUPS, PLANS_FAQ },
    } = useSiteData();

    return (
        <PageShell>
            <PageHeader eyebrow={PLANS_PAGE.eyebrow} title={PLANS_PAGE.title} standfirst={PLANS_PAGE.lead}>
                <p className="mt-4 max-w-[720px] text-[16px] leading-[1.65] [text-wrap:pretty]" style={{ color: 'var(--muted)' }}>
                    {LIMIT_CHANGE_NOTICE}
                </p>
            </PageHeader>

            <div className="mx-auto max-w-[1400px] px-6 md:px-10">
                <div className="max-w-[1100px]">
                    <div className="money-sheet mt-3">
                        <section className="money-full" aria-labelledby="ribbon-title" data-section="plans-ribbon">
                            <div className="mb-4 flex flex-col gap-0.5 md:flex-row md:items-baseline md:gap-2.5">
                                <h2 id="ribbon-title" className="text-[15px] font-semibold" style={{ color: 'var(--fg)' }}>
                                    {PLANS_PAGE.ribbonTitle}
                                </h2>
                                <span className="text-[13px]" style={{ color: 'var(--muted)' }}>
                                    {PLANS_PAGE.ribbonCaption}
                                </span>
                            </div>
                            <HistoryRibbon />
                        </section>
                    </div>

                    {PLAN_GROUPS.map((group) => (
                        <section key={group.id} id={group.id} aria-labelledby={`${group.id}-title`} className="mt-12 md:mt-16" data-section={`plans-${group.id}`}>
                            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                                <h2 id={`${group.id}-title`} className="text-[18px] font-semibold" style={{ color: 'var(--fg)' }}>
                                    {group.title}
                                </h2>
                                <p className="text-[15px] [text-wrap:pretty]" style={{ color: 'var(--muted)' }}>
                                    {group.subtitle}
                                </p>
                            </div>
                            <div className={`mt-[18px] grid grid-cols-1 gap-3.5 ${group.cards.length === 3 ? 'md:grid-cols-3' : 'md:grid-cols-2'}`}>
                                {group.cards.map((card) => (
                                    <PlanCard key={card.id} card={card} />
                                ))}
                            </div>
                        </section>
                    ))}

                    <p className="mt-4 text-[13px] leading-[1.55] [text-wrap:pretty]" style={{ color: 'var(--muted)' }}>
                        {PLANS_PAGE.finePrint}
                        {PLANS_PAGE.fileStorageNote ? ` ${PLANS_PAGE.fileStorageNote}` : null}
                    </p>
                </div>
            </div>

            <Prose id="teams" heading={PLANS_PAGE.teamsHeading} rhythm="chapter" data-section="plans-teams">
                <p className="max-w-[720px] text-[16px] leading-[1.65] [text-wrap:pretty]" style={{ color: 'var(--muted)' }}>
                    {PLANS_PAGE.teamsBody}
                </p>
            </Prose>

            <Prose id="questions" heading={PLANS_PAGE.faqHeading} rhythm="chapter" data-section="plans-faq">
                <FaqList variant="compact" items={PLANS_FAQ} defaultOpenId={PLANS_FAQ[0].id} />
            </Prose>
            <div className="pb-24 md:pb-32" />
        </PageShell>
    );
}
