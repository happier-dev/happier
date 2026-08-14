import { HappierMark } from '../components/HappierMark';
import { DISCORD_INVITE_URL } from '../data/community';
import { CHANGELOG_URL, DOCS_URL, GUIDES_URL, GITHUB_REPO_URL, LICENSE_URL, WEB_APP_URL } from '../data/downloads';

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
 * Footer link set.
 *
 * Two fixes over the shipped set, both of them link-equity problems rather than
 * taste:
 *   - guides.happier.dev had NO inbound link from any Happier surface. 53
 *     guides were orphaned — uncrawlable except by sitemap, and invisible to a
 *     visitor. It is now the first Resources entry — and since the nav slot
 *     Guides briefly held went to Enterprise (src/sections/Nav.tsx), this link
 *     is the ONLY thing on any Happier surface pointing at those 53 pages.
 *     Removing it re-orphans the lot; it is not a taste call.
 *   - the licence file in the repo is spelled `LICENCE`; the footer pointed at
 *     `/blob/main/LICENSE`, which GitHub answers with a 404 on a case-sensitive
 *     path. Pinned to the real filename and to `MIT license` as the label, since
 *     the licence NAME is the thing a visitor is checking for.
 *
 * The two new on-page sections are linked from Product so they are reachable
 * from every scroll position, and so "vs Remote Control" gets an internal
 * anchor rather than depending on a visitor scrolling to it.
 *
 * Third fix, same class as the licence one: "Changelog" pointed at
 * docs.happier.dev/changelog, which answers 404. src/data/downloads.ts already
 * exported the URL that works (`/releases`) and nothing was using it. Every
 * external URL in this file now comes from downloads.ts, so the link and the
 * analytics classification in useLinkClicks cannot disagree — a hand-typed href
 * here would silently land as `destination: 'other'`.
 *
 * `/agents` and `/vs/claude-code-remote-control` are real routes now, not
 * fragments, so they move out of the fragment list. `hrefFor` below is what
 * keeps the remaining fragments working from a non-home page.
 */
export const FOOTER_COLUMNS = [
    {
        title: 'Product',
        links: [
            { label: 'Agents we run', href: '/agents' },
            { label: 'vs Remote Control', href: '/vs/claude-code-remote-control' },
            // The Codex comparison is the same class of page and needs the same
            // treatment: a route reachable only from the sitemap is a route
            // Google finds and no visitor does. Labelled by the vendor's own
            // feature name, never by a product name we invented — there is no
            // "Codex Mobile".
            { label: 'vs Codex Remote', href: '/vs/codex-remote' },
            // The two feature pages and /enterprise are real routes, and a route
            // with no inbound link from any surface is a route Google finds in
            // the sitemap and nobody else finds at all — the exact failure that
            // orphaned 53 guides before the Resources column existed.
            { label: 'Usage limits', href: '/features/usage-limits' },
            { label: 'Terminal & TUIs', href: '/features/terminal' },
            { label: 'Features', href: '#features' },
            { label: 'FAQ', href: '#faq' },
            { label: 'Get started', href: '#get-started' },
            { label: 'Web app', href: WEB_APP_URL, external: true },
        ],
    },
    {
        title: 'Open source',
        links: [
            { label: 'GitHub', href: GITHUB_REPO_URL, external: true },
            // /enterprise sits under Open source, not Product, because the thing
            // it is really selling to a security reviewer is the licence.
            { label: 'Self-host for a team', href: '/enterprise' },
            { label: 'Self-host', href: 'https://docs.happier.dev/deployment/self-host-runtime', external: true },
            { label: 'MIT license', href: LICENSE_URL, external: true },
            // Was https://docs.happier.dev/security — the same class of defect
            // as the licence and changelog links above, and the most expensive
            // of the three. It took the single most evaluative visitor on the
            // site off it before they had read one sentence we wrote about the
            // thing they came to check. /security is a real route now, and it
            // is the page that links onward to the docs.
            { label: 'Security & encryption', href: '/security' },
        ],
    },
    {
        title: 'Resources',
        links: [
            { label: 'Guides', href: GUIDES_URL, external: true },
            { label: 'Docs', href: DOCS_URL, external: true },
            { label: 'Changelog', href: CHANGELOG_URL, external: true },
            { label: 'Discord', href: DISCORD_INVITE_URL, external: true },
        ],
    },
] as const;

/** `#faq` is a real target on the homepage and a dead scroll anywhere else. */
function hrefFor(href: string, isHome: boolean): string {
    return !isHome && href.startsWith('#') ? `/${href}` : href;
}

export function Footer({ isHome = true }: { isHome?: boolean } = {}) {
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
                        >
                            One open-source client for every coding agent — thirteen of them, run on
                            your own computer, with your own subscriptions or API keys, end-to-end
                            encrypted.
                        </p>
                    </div>

                    {FOOTER_COLUMNS.map((col) => (
                        <div key={col.title}>
                            <div
                                className="mb-4 text-[12px] font-semibold uppercase tracking-[0.16em]"
                                style={{ color: 'var(--muted)' }}
                            >
                                {col.title}
                            </div>
                            <ul className="space-y-2.5">
                                {col.links.map((link) => (
                                    <li key={link.label}>
                                        <a
                                            href={hrefFor(link.href, isHome)}
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
                    <span>© {BUILD_YEAR} Happier. Open source. Made with care.</span>
                    <span className="font-mono text-[12px]">happier.dev</span>
                </div>
            </div>
        </footer>
    );
}
