import { PageHeader, PageShell } from '../components/PageShell';
import { SupporterWall } from '../components/SupporterWall';
import { useSiteData } from '../i18n/siteData';
import { Island } from '../islands';

/**
 * /supporters, and every pass QR at /s/<n> (rewritten here by public/_redirects).
 *
 * The intro is prerendered prose; the wall is one island reading
 * supporters.json, and on /s/<n> it puts that holder's entry first. Canonical
 * stays /supporters.
 */
export function SupportersPage() {
    const {
        plans: { SUPPORTERS_PAGE },
    } = useSiteData();

    return (
        <PageShell>
            <PageHeader
                eyebrow={SUPPORTERS_PAGE.eyebrow}
                title={SUPPORTERS_PAGE.title}
                standfirst={SUPPORTERS_PAGE.intro}
            >
                <p className="mt-4 text-[16px] leading-[1.65]" style={{ color: 'var(--muted)' }}>
                    {SUPPORTERS_PAGE.openLead}{' '}
                    <a href="/open" className="underline underline-offset-2" style={{ color: 'var(--fg)' }}>
                        {SUPPORTERS_PAGE.openLinkText}
                    </a>
                    .
                </p>
                <div className="mt-[26px]">
                    <a href="/plans#any-server" className="plan-pill plan-pill--pri">
                        {SUPPORTERS_PAGE.cta}
                    </a>
                </div>
            </PageHeader>

            <section data-section="supporters-wall" className="relative">
                <div className="mx-auto max-w-[1400px] px-6 pb-24 pt-10 md:px-10 md:pb-32 md:pt-14">
                    <div className="max-w-[1100px]">
                        <Island name="supporter-wall" component={SupporterWall} />
                    </div>
                </div>
            </section>
        </PageShell>
    );
}
