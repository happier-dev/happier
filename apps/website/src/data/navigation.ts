import { DISCORD_INVITE_URL } from './community';
import { CHANGELOG_URL, DOCS_URL, GUIDES_URL, GITHUB_REPO_URL, LICENSE_URL, WEB_APP_URL } from './downloads';

/**
 * The footer link set.
 *
 * IT LIVES IN src/data/ SO THAT IT IS TRANSLATED. It used to be a `const` inside
 * src/sections/Footer.tsx, which put twenty-two labels — three column headings
 * and nineteen links — outside every mechanism the locale lane has. The
 * extractor only reads src/data/*.ts, so they were never in the catalogue; the
 * overlay only rewrites what the extractor found, so they were never
 * translated; and the coverage report only counts ids that exist, so nothing
 * ever said they were missing. Every page on the site, in all nine languages,
 * ended in an English footer.
 *
 * Each column and each link carries an `id`. That is not decoration either:
 * walkStrings (src/i18n/overlay.ts) addresses an array element by its natural
 * key when it has one and by its INDEX when it does not, so without these ids
 * reordering the Product column would silently move nine translations onto the
 * wrong links. `id` is itself on the do-not-translate field list, so it costs a
 * translator nothing.
 *
 * Two fixes here are link-equity problems rather than taste, and both predate
 * the move:
 *   - guides.happier.dev had NO inbound link from any Happier surface. 53
 *     guides were orphaned — uncrawlable except by sitemap, and invisible to a
 *     visitor. It is the first Resources entry — and since the nav slot Guides
 *     briefly held went to Enterprise (src/sections/Nav.tsx), this link is the
 *     ONLY thing on any Happier surface pointing at those 53 pages. Removing it
 *     re-orphans the lot; it is not a taste call.
 *   - the licence file in the repo is spelled `LICENCE`; the footer pointed at
 *     `/blob/main/LICENSE`, which GitHub answers with a 404 on a case-sensitive
 *     path. Pinned to the real filename and to `MIT license` as the label, since
 *     the licence NAME is the thing a visitor is checking for.
 *
 * Third fix, same class: "Changelog" pointed at docs.happier.dev/changelog,
 * which answers 404. ./downloads.ts already exported the URL that works
 * (`/releases`) and nothing was using it. Every external URL here comes from
 * ./downloads.ts, so the link and the analytics classification in useLinkClicks
 * cannot disagree — a hand-typed href would silently land as
 * `destination: 'other'`.
 *
 * The two on-page sections are linked from Product so they are reachable from
 * every scroll position. `/agents` and `/vs/claude-code-remote-control` are real
 * routes, not fragments; `hrefFor` in Footer.tsx is what keeps the remaining
 * fragments working from a non-home page.
 */
export const FOOTER_COLUMNS = [
    {
        id: 'product',
        title: 'Product',
        links: [
            { id: 'agents', label: 'Agents we run', href: '/agents' },
            { id: 'vs-remote-control', label: 'vs Remote Control', href: '/vs/claude-code-remote-control' },
            // The Codex comparison is the same class of page and needs the same
            // treatment: a route reachable only from the sitemap is a route
            // Google finds and no visitor does. Labelled by the vendor's own
            // feature name, never by a product name we invented — there is no
            // "Codex Mobile".
            { id: 'vs-codex-remote', label: 'vs Codex Remote', href: '/vs/codex-remote' },
            // The two feature pages and /enterprise are real routes, and a route
            // with no inbound link from any surface is a route Google finds in
            // the sitemap and nobody else finds at all — the exact failure that
            // orphaned 53 guides before the Resources column existed.
            { id: 'usage-limits', label: 'Usage limits', href: '/features/usage-limits' },
            { id: 'terminal', label: 'Terminal & TUIs', href: '/features/terminal' },
            { id: 'features', label: 'Features', href: '#features' },
            { id: 'faq', label: 'FAQ', href: '#faq' },
            { id: 'get-started', label: 'Get started', href: '#get-started' },
            { id: 'web-app', label: 'Web app', href: WEB_APP_URL, external: true },
        ],
    },
    {
        id: 'open-source',
        title: 'Open source',
        links: [
            { id: 'github', label: 'GitHub', href: GITHUB_REPO_URL, external: true },
            // /enterprise sits under Open source, not Product, because the thing
            // it is really selling to a security reviewer is the licence.
            { id: 'enterprise', label: 'Self-host for a team', href: '/enterprise' },
            {
                id: 'self-host-docs',
                label: 'Self-host',
                href: 'https://docs.happier.dev/deployment/self-host-runtime',
                external: true,
            },
            { id: 'licence', label: 'MIT license', href: LICENSE_URL, external: true },
            // Was https://docs.happier.dev/security — the same class of defect
            // as the licence and changelog links above, and the most expensive
            // of the three. It took the single most evaluative visitor on the
            // site off it before they had read one sentence we wrote about the
            // thing they came to check. /security is a real route now, and it
            // is the page that links onward to the docs.
            { id: 'security', label: 'Security & encryption', href: '/security' },
        ],
    },
    {
        id: 'resources',
        title: 'Resources',
        links: [
            { id: 'guides', label: 'Guides', href: GUIDES_URL, external: true },
            { id: 'docs', label: 'Docs', href: DOCS_URL, external: true },
            { id: 'changelog', label: 'Changelog', href: CHANGELOG_URL, external: true },
            { id: 'discord', label: 'Discord', href: DISCORD_INVITE_URL, external: true },
        ],
    },
] as const;
