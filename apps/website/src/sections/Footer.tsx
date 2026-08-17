import { AnalyticsNotice } from '../components/AnalyticsNotice';
import { HappierMark } from '../components/HappierMark';
import { useLocalePath } from '../i18n';
import { rich } from '../i18n/rich';
import { useSiteData } from '../i18n/siteData';
import { LocaleSwitcher } from '../components/LocaleSwitcher';

/**
 * Read once at module scope, not per render.
 *
 * The page is prerendered at build time and hydrated in the browser, so a live
 * `new Date().getFullYear()` in JSX is evaluated twice — on 31 December it bakes
 * one year into the HTML and hydrates a different one, which React 19 reports as
 * a hydration text mismatch. A build-time constant cannot mismatch; the copyright
 * line simply refreshes on the next deploy.
 */
const BUILD_YEAR = new Date().getFullYear();


/**
 * `#faq` is a real target on the homepage and a dead scroll anywhere else, so
 * off-home it becomes an absolute link back to the homepage's anchor.
 *
 * `localeHref` then puts the reader's language back on the front of it. Both
 * steps are needed and they are not the same step: the first decides WHICH page
 * the link goes to, the second decides which language that page is in. A footer
 * that did only the first sent every reader of every translated page to the
 * English site — which is what it did.
 */
function hrefFor(href: string, isHome: boolean, localeHref: (href: string) => string): string {
    return localeHref(!isHome && href.startsWith('#') ? `/${href}` : href);
}

export function Footer({ isHome = true }: { isHome?: boolean } = {}) {
    // FOOTER_COLUMNS comes from the hook, not from an import. The link set moved
    // to src/data/navigation.ts precisely so the overlay could translate it, and
    // `import { FOOTER_COLUMNS }` would reach the English module directly and
    // undo that — silently, since the labels would still render.
    const { pageProse: { PAGE_PROSE }, navigation: { FOOTER_COLUMNS } } = useSiteData();
    const localeHref = useLocalePath();

    return (
        <footer
            className="relative border-t"
            style={{ borderColor: 'var(--card-border)' }}
            data-section="footer"
        >
            <div className="mx-auto max-w-[1400px] px-6 py-16 md:px-10 md:py-20">
                <div className="grid gap-12 md:grid-cols-[1.4fr_1fr_1fr_1fr]">
                    <div>
                        <HappierMark />
                        <p
                            className="mt-5 max-w-[320px] text-[14px] leading-[1.6]"
                            style={{ color: 'var(--muted)' }}
                        >{rich(PAGE_PROSE.footer.p0)}</p>
                    </div>

                    {FOOTER_COLUMNS.map((col) => (
                        <div key={col.id}>
                            <div
                                className="mb-4 text-[12px] font-semibold uppercase tracking-[0.16em]"
                                style={{ color: 'var(--muted)' }}
                            >
                                {col.title}
                            </div>
                            <ul className="space-y-2.5">
                                {col.links.map((link) => (
                                    <li key={link.id}>
                                        <a
                                            href={hrefFor(link.href, isHome, localeHref)}
                                            {...('external' in link && link.external
                                                ? { target: '_blank', rel: 'noreferrer' }
                                                : {})}
                                            className="text-[14px] transition-opacity hover:opacity-100"
                                            style={{ color: 'var(--fg)', opacity: 0.7 }}
                                        >
                                            {link.label}
                                        </a>
                                    </li>
                                ))}
                            </ul>
                        </div>
                    ))}
                </div>

                <div
                    className="mt-14 flex flex-col items-start justify-between gap-4 border-t pt-8 text-[13px] sm:flex-row sm:items-center"
                    style={{ borderColor: 'var(--card-border)', color: 'var(--muted)' }}
                >
                    <span className="flex flex-col items-start gap-2">
                        {rich(PAGE_PROSE.footer.p1, undefined, { BUILD_YEAR })}
                        {/*
                            The analytics disclosure and its switch. See the
                            docblock in AnalyticsNotice: it is deliberately a
                            footer line rather than a banner, because a modal
                            asking consent for something we do not do — no
                            cookie, no identifier — is worse than a true
                            sentence and a working control. It was written for
                            this spot and had never been mounted anywhere, so
                            the site was collecting with no reachable opt-out.
                        */}
                        <AnalyticsNotice />
                    </span>
                    {/*
                        The switcher lives in the bottom bar rather than as a
                        fifth column: it is one control with ten settings, not
                        ten more destinations competing with Product / Open
                        source / Resources. Its panel opens UPWARD for the same
                        reason — there is nothing below it but the page edge.
                    */}
                    <div className="flex items-center gap-5">
                        <LocaleSwitcher />
                        <span className="font-mono text-[12px]">happier.dev</span>
                    </div>
                </div>
            </div>
        </footer>
    );
}
