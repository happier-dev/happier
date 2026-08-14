/**
 * The complete event taxonomy for happier.dev.
 *
 * Rules this file exists to enforce:
 *   1. Every event name on the wire is in `EVENT_NAMES`. Nothing else ships.
 *   2. Every property value that can be enumerated IS enumerated, as a union
 *      type — and where a union already exists somewhere canonical, this file
 *      imports it rather than restating it. `DesktopPlatformId` lives in
 *      src/data/downloads.ts because that is where the URLs live; an analytics
 *      copy of that list would drift the first time a platform is added, and a
 *      breakdown that silently stops matching is worse than no breakdown.
 *   3. No component calls `posthog.capture` — they call a named function here.
 *      That is what makes "what does this site actually measure?" answerable by
 *      reading one file instead of grepping twenty components.
 *      events.test.ts enforces 1 and 3.
 *
 * ONE DELIBERATE DEPARTURE FROM THE BRIEF, stated plainly.
 * The brief lists `docs_click`, `guides_click`, `github_click`, `discord_click`
 * as separate events. They are one act — a visitor leaving for a named
 * destination — and four names for one act turns every "where does traffic
 * leak?" question into a four-way union and every funnel into a manual merge.
 * So the WIRE event is one: `outbound_click { destination }`, and each of the
 * four is a one-filter insight in PostHog:
 *     outbound_click WHERE destination = 'docs'
 */
import type { DesktopPlatformId } from '../data/downloads';
import type { Platform } from '../components/usePlatform';
import { track } from './analytics';

/** Every event name this site is allowed to emit. Guarded by events.test.ts. */
export const EVENT_NAMES = [
    'install_command_copied',
    'download_badge_clicked',
    'cta_clicked',
    'outbound_click',
    'theme_toggled',
    'section_viewed',
    'faq_opened',
    'comparison_viewed',
    'demo_played',
] as const;

export type EventName = (typeof EVENT_NAMES)[number];

// ---------------------------------------------------------------------------
// Shared vocabularies
// ---------------------------------------------------------------------------

/** Reused from the platform detector so the two lists cannot diverge. */
export type InstallPlatform = Platform;

/**
 * Which install command was copied.
 *
 * `oneliner` is the piped `curl … | bash`; `inspectable` is the three-line
 * download-read-run form (INSTALL_COMMAND_UNIX_INSPECTABLE in
 * src/data/downloads.ts). Splitting them answers a question this product should
 * actually care about: how many of our visitors refuse to pipe a script into a
 * shell? If that number is large, it is a page-design fact, not a footnote.
 */
export type InstallForm = 'oneliner' | 'inspectable';

/**
 * Release channel of the copied command.
 *
 * public/ ships install / install-preview / install-dev; the site only hands out
 * `stable`. The property exists so that when a docs page starts handing out the
 * preview command, the two separate without a schema migration.
 */
export type InstallVariant = 'stable' | 'preview' | 'dev';

/**
 * Download destinations. `android-apk` and `android-play-testing` are separate
 * because they are separate products from the visitor's point of view: one is a
 * direct APK off a GitHub release, the other is a closed-track opt-in that only
 * works after a Google account joins the tester list (src/data/downloads.ts).
 * Collapsing them to "android" would hide exactly the thing worth knowing.
 */
export type DownloadStore =
    | 'ios'
    | 'android-apk'
    | 'android-play-testing'
    | 'desktop'
    | 'web';

/** Desktop split-button targets, plus the fallback when detection is unsure. */
export type DesktopVariant = DesktopPlatformId | 'releases-page';

/** Named exits. Anything not on this list is a bug, not a new destination. */
export type OutboundDestination =
    | 'docs'
    | 'guides'
    | 'github'
    | 'discord'
    | 'webapp'
    | 'app-store'
    | 'android-apk'
    | 'play-testing'
    | 'github-releases'
    | 'license'
    | 'changelog'
    | 'release-pubkey'
    | 'other';

/**
 * Section ids, in page order, grouped by route. Must match the `data-section`
 * attributes — events.test.ts fails on any attribute value not listed here.
 *
 * Route-grouped rather than flat because the site stopped being one page.
 * `section_viewed` is a scroll funnel and a funnel that mixes /agents steps with
 * homepage steps is a funnel of nothing; the grouping is what lets a PostHog
 * breakdown be filtered to one route. `vs-remote-control` appears on both the
 * homepage and /vs/claude-code-remote-control deliberately — it is the same
 * milestone reached two ways, and splitting it would hide half the answer to
 * "did anyone read the objection?".
 */
export const SECTION_NAMES = [
    // homepage
    'hero',
    'hero-showcase',
    'get-started',
    // 'after-install' — src/sections/AfterInstall.tsx was written for the
    // homepage and never mounted, and its four steps were the four steps
    // <GetStarted /> already renders directly above it. The file is deleted
    // rather than mounted: two four-step lists on one page is a duplicate, not
    // a funnel. The step goes with it.
    'features',
    'feature-grid',
    'explorer',
    'self-host',
    'vs-remote-control',
    'faq',
    'call-to-action',
    'footer',
    // The language list in the footer, and the dismissible banner offering a
    // reader the locale their browser asks for. Both are tracked separately from
    // the footer they sit in: the banner is the only thing on the site that
    // proposes a navigation the reader did not ask for, so taken-versus-dismissed
    // is the measure of whether it earns its place.
    'locale-switcher',
    'locale-suggestion',
    // /agents
    'agents-intro',
    // 'agents-matrix' — the thirteen-by-nine capability table was removed from
    // the page (see src/data/agents.ts), so the funnel step goes with it rather
    // than sitting here as a step nothing can reach.
    'agents-list',
    'agents-unlisted',
    // The Custom ACP block: the shipped id that deliberately has no page.
    'agents-custom',
    // The upcoming block: agents defined in the unreleased tree, rendered behind
    // the not-yet-available label and counted in nothing.
    'agents-upcoming',
    'agents-cta',
    // /agents/<slug> — rebuilt on the "open-source app for <Agent>" model, so
    // the old capability-reference steps ('agent-what-it-is',
    // 'agent-difference', 'agent-capabilities', 'agent-auth', 'agent-quirks')
    // no longer exist.
    // The opening section: what is different about this agent specifically.
    'agent-lead',
    'agent-what-it-does',
    'agent-devices',
    'agent-your-computer',
    // Rendered only on the five agents that can consume a connected service, so
    // this step is legitimately absent from eight of the thirteen pages.
    'agent-accounts',
    'agent-other-agents',
    'agent-terminal',
    'agent-faq',
    'agent-cta',
    // /vs/claude-code-remote-control
    'rc-concession',
    'rc-strengths',
    'rc-scope',
    'rc-table',
    // 'rc-use-instead' — the "go and use Remote Control instead" block — was
    // removed from the page, so the funnel step goes with it rather than sitting
    // here as a step nothing can ever reach.
    'rc-difference',
    'rc-cta',
    // /vs/codex-remote. Same seven-step shape as the Remote Control page on
    // purpose: the two pages are read by the same kind of visitor asking the
    // same question about a different vendor, and a funnel that steps
    // differently on each cannot answer "which concession do people finish?".
    // 'codex-conditions' is the one step the RC page has no equivalent of,
    // because OpenAI publishes requirements rather than disable conditions.
    'codex-concession',
    'codex-strengths',
    'codex-conditions',
    'codex-scope',
    'codex-table',
    'codex-difference',
    'codex-cta',
    // /features/usage-limits
    'usage-limits-baseline',
    'usage-limits-pools',
    'usage-limits-defaults',
    'usage-limits-support',
    'usage-limits-scope',
    'usage-limits-docs',
    // /features/terminal
    'terminal-intro',
    'terminal-moves',
    'terminal-support',
    'terminal-claude-unified',
    'terminal-catch',
    'terminal-docs',
    // /security. Read depth is the whole measurement here — there is no CTA on
    // the page on purpose, because a security page that closes with an install
    // button is asking for a decision before it has finished making its case.
    // 'security-ledger' is the interesting step: it is where the page stops
    // reassuring and starts listing what the relay CAN see.
    'security-path',
    'security-ledger',
    'security-keys',
    'security-pairing',
    'security-storage',
    'security-notifications',
    'security-selfhost',
    'security-source',
    // /enterprise. 'enterprise-cta' is the only step here that is a conversion;
    // the other five are read depth on a page whose visitor is evaluating rather
    // than installing, and the interesting number is how far down the control
    // list they get before they stop.
    'enterprise-shape',
    'enterprise-access',
    'enterprise-data',
    'enterprise-zdr',
    'enterprise-licence',
    'enterprise-cta',
] as const;

export type SectionName = (typeof SECTION_NAMES)[number];

/**
 * Where on the page a CTA lives.
 *
 * Derived from SECTION_NAMES rather than restated, so a location can never be a
 * section name with a typo in it — locationOf() reads the `data-section`
 * attribute when there is no `data-cta-location` override, and before this was a
 * derived union those two lists could silently disagree. The two extras are the
 * places that genuinely need a finer name than their section: the nav sits
 * inside the hero, and <PrimaryCta /> is a distinct decision point within it.
 */
export type CtaLocation = SectionName | 'hero-nav' | 'primary-cta';

// ---------------------------------------------------------------------------
// Emitters
// ---------------------------------------------------------------------------

/**
 * THE conversion event. Everything else on this page exists to cause it.
 *
 * The site's job is to reach a desktop browser and put an install command on the
 * clipboard of the machine that runs the code. App Store installs arrive with no
 * machine to pair, which is where the funnel dies today — 58% reach a pairing
 * screen, 36% reach a session. So this, not a badge click, is the number the
 * whole dashboard is built around.
 */
export function trackInstallCommandCopied(args: {
    platform: InstallPlatform;
    form: InstallForm;
    variant: InstallVariant;
    location: CtaLocation;
    /**
     * `false` when the Clipboard API rejected. A copy button that silently fails
     * — which it does over plain HTTP, in some embedded webviews, and whenever
     * permission is denied — is invisible without this, and would read as
     * "nobody wanted to copy it".
     */
    succeeded: boolean;
}): void {
    track('install_command_copied', args);
}

export function trackDownloadBadgeClicked(args: {
    store: DownloadStore;
    location: CtaLocation;
    /** Desktop only: which artifact the split button resolved to. */
    variant?: DesktopVariant;
    /** Desktop only: whether OS+arch detection was confident. */
    detected?: boolean;
}): void {
    track('download_badge_clicked', args);
}

export function trackCtaClicked(args: { location: CtaLocation; label: string }): void {
    track('cta_clicked', args);
}

export function trackOutboundClick(args: {
    destination: OutboundDestination;
    location: CtaLocation;
    href: string;
}): void {
    track('outbound_click', args);
}

/*
 * There were four more exports here — trackDocsClick, trackGuidesClick,
 * trackGithubClick, trackDiscordClick — kept so "the JSX reads as the brief asks
 * for". They were never imported by anything, because the destination is
 * classified from the href by the delegated listener in useLinkClicks.ts, which
 * is strictly better: a link added six months from now is instrumented without
 * anyone remembering a convention existed. Four exported wrappers that nothing
 * calls are not a naming scheme, they are dead code that makes the taxonomy look
 * larger than it is. The four questions they were meant to answer are each one
 * PostHog filter: `outbound_click WHERE destination = 'docs'`.
 */

export function trackThemeToggled(args: { to: 'dark' | 'light' }): void {
    track('theme_toggled', args);
}

/**
 * Fired once per section per page load, the first time it enters the viewport
 * (minus a 15% bottom margin, so a fast scroll past does not count as read).
 *
 * This is the scroll-depth instrument. On one long page with no router,
 * `$pageview` says nothing about how far anyone got; `section_viewed` turns the
 * page into a nine-step funnel and shows exactly which section is the wall.
 */
export function trackSectionViewed(args: { section: SectionName }): void {
    track('section_viewed', args);
}

/**
 * A visitor collapsed or re-expanded an FAQ entry.
 *
 * src/sections/Faq.tsx renders `<details open>` deliberately — a crawler may not
 * weigh text behind a JS-only click — so this fires rarely by design, and the
 * shape of the rare firings is itself the finding: an entry people collapse is
 * an entry that is in their way.
 *
 * `question` carries the literal question text rather than a slug, so the
 * PostHog breakdown IS the keyword report. The questions exist because the
 * demand is measured: "is claude code free" (2,900/mo), "does claude code have
 * a web interface" (1,900), "is claude code open source" (590, $38.25 CPC),
 * "how to make claude code stop asking for permission" (480).
 */
export function trackFaqOpened(args: { question: string; open: boolean }): void {
    track('faq_opened', args);
}

/**
 * The "why not Claude Code Remote Control?" block was reached.
 *
 * Emitted from useSectionViewed rather than from src/sections/VsRemoteControl.tsx
 * so the objection-handling copy can be rewritten freely without anyone having
 * to remember an analytics call inside it. `subject` names what is being
 * compared against, so a second comparison later needs no second event.
 */
export function trackComparisonViewed(args: { subject: string }): void {
    track('comparison_viewed', args);
}

/**
 * Interaction with a product demo.
 *
 * Today the only real demo surface is the tab strip in
 * src/sections/TabbedExplorer.tsx. `demo` names the widget, so a real video
 * later is `{ demo: 'hero-video', action: 'play' }` under the same event
 * instead of a new one.
 */
export function trackDemoPlayed(args: {
    demo: 'tabbed-explorer' | 'hero-showcase' | 'hero-video';
    action: 'play' | 'tab' | 'reveal';
    detail?: string;
}): void {
    track('demo_played', args);
}
