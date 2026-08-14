import { useLinkClicks } from './useLinkClicks';
import { useSectionViewed } from './useSectionViewed';

/**
 * The site's entire passive instrumentation, in one mount.
 *
 * Between them these two hooks cover `outbound_click`, `download_badge_clicked`,
 * `section_viewed` and `comparison_viewed` without a single line inside a
 * section or CTA component — the page's content can be rewritten freely and the
 * measurement follows it. Only the events that are genuinely tied to a specific
 * interaction need a call site of their own:
 *
 *   install_command_copied  → the copy handler in components/InstallCommand.tsx
 *   theme_toggled           → components/ThemeToggle.tsx
 *   faq_opened              → the <details onToggle> in sections/Faq.tsx
 *   demo_played             → the tab buttons in sections/TabbedExplorer.tsx
 *
 * Mounted from src/App.tsx. Both hooks are `useEffect`-only, so the prerenderer
 * (src/entry-server.tsx) never runs them and the emitted HTML is unaffected.
 */
export function useSiteAnalytics(): void {
    useSectionViewed();
    useLinkClicks();
}
