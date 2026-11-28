import { PageShell } from '../components/PageShell';
import { SupporterCode } from '../components/SupporterCode';
import { useSiteData } from '../i18n/siteData';
import { Island } from '../islands';

/**
 * /thanks — Polar's success URL. noindex, English only, and no third-party
 * script on this page: its client entry mounts the islands without starting
 * analytics (src/entries/thanks.tsx). The code comes from local storage, never
 * from the query string, so a shared link shows nothing personal.
 */
export function ThanksPage() {
    const {
        plans: { THANKS_PAGE },
    } = useSiteData();

    return (
        <PageShell>
            <section className="relative">
                <div className="mx-auto max-w-[1400px] px-6 pb-28 pt-16 md:px-10 md:pb-36 md:pt-24">
                    <div className="max-w-[880px]">
                        <h1 className="font-display text-[36px] font-normal leading-[1.05] tracking-[-0.03em] [text-wrap:balance] md:text-[52px]">
                            {THANKS_PAGE.title}
                        </h1>
                        <p className="mb-8 mt-6 max-w-[640px] text-[17px] leading-[1.62] [text-wrap:pretty] md:text-[19px]" style={{ color: 'var(--muted)' }}>
                            {THANKS_PAGE.lead}
                        </p>
                        <Island name="supporter-code" component={SupporterCode} />
                    </div>
                </div>
            </section>
        </PageShell>
    );
}
