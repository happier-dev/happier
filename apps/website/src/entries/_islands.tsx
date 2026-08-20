import { lazyIsland, type IslandMap } from '../islands';

import { DownloadBadges } from '../components/DownloadBadges';
import { HandoffToComputer } from '../components/HandoffToComputer';
import { InstallCommand } from '../components/InstallCommand';
import { ProviderMarkRow } from '../components/ProviderMarkRow';
import { Footer } from '../sections/Footer';
import { HeroBackdrop } from '../sections/HeroBackdrop';
import { Nav } from '../sections/Nav';

/**
 * Every island the site has, in one map shared by all 21 entries.
 *
 * WHY ONE MAP AND NOT ONE PER PAGE. mountIslands only mounts containers the
 * page actually rendered, so a map naming an island that is not on this page
 * costs nothing at runtime — but a STATIC name does cost bytes, because it puts
 * the component in the entry's import graph. The trade is deliberate: the
 * alternative is 21 hand-maintained maps that drift from the pages they serve,
 * and the failure when they drift is a dead button — exactly the class of bug
 * this codebase spends its guards on. So: one map, with everything that is not
 * chrome behind `lazyIsland`.
 *
 * THE LAZY ONES ARE NOT IMPORTED AT THE TOP. That is the whole mechanism, and
 * it is easy to undo by accident — the first version of this file imported them
 * statically *as well*, which puts them in the entry chunk and makes the
 * dynamic import() a second copy rather than a saving.
 *
 * WHAT IS NOT HERE. ThemeToggle, HappierMark, LocaleSwitcher and
 * AnalyticsNotice are all interactive, and all live INSIDE Nav or Footer.
 * mountIslands skips a container with an island ancestor (see isNested), so the
 * outer island's React tree renders them and a second root never fights it for
 * the same nodes. Do not add them here.
 *
 * LocaleSuggestion is absent for a different reason: it renders nothing on the
 * server, so there is no container to find. src/entries/_mount.tsx gives it a
 * root of its own.
 */
export const ISLANDS: IslandMap = {
    // Chrome — on every route, above the fold, needed for the first interaction.
    nav: Nav,
    footer: Footer,
    'install-command': InstallCommand,
    'handoff-to-computer': HandoffToComputer,
    'download-badges': DownloadBadges,
    'provider-mark-row': ProviderMarkRow,
    'hero-backdrop': HeroBackdrop,

    /*
     * Below the fold or purely decorative: behind a dynamic import(), so it is
     * off the critical path and out of the route's budget by the same rule that
     * already excludes posthog-js. TerminalBackground is the clearest case —
     * 293 lines of canvas animation painting behind the whole page, none of
     * which needs to exist before the visitor has read the first screen.
     */
    'terminal-background': lazyIsland(() =>
        import('../components/TerminalBackground').then((m) => m.TerminalBackground),
    ),
    'hero-stage': lazyIsland(() => import('../sections/HeroStage').then((m) => m.HeroStage)),
    'hero-showcase': lazyIsland(() => import('../sections/HeroShowcase').then((m) => m.HeroShowcase)),
    'tabbed-explorer': lazyIsland(() =>
        import('../sections/TabbedExplorer').then((m) => m.TabbedExplorer),
    ),
    'self-host': lazyIsland(() => import('../sections/SelfHost').then((m) => m.SelfHost)),
    'call-to-action': lazyIsland(() => import('../sections/CallToAction').then((m) => m.CallToAction)),
};
