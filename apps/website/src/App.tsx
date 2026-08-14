import { findRoute } from './routes';
import { LocaleProvider } from './i18n';
import { localeFromPathname } from './i18n/locales';
import { useSiteAnalytics } from './analytics/useSiteAnalytics';

/**
 * The router, and nothing else.
 *
 * `path` is passed in rather than read from `location` so the same component
 * renders under the build-time prerenderer (src/entry-server.tsx), which has no
 * `window`, and in the browser (src/main.tsx), which does. Both hand it the same
 * string, which is what keeps hydration matching.
 *
 * An unknown path throws. That is deliberate: the only caller that can produce
 * one is the prerenderer looping over ROUTES, so a throw here is a BUILD
 * failure. In the browser the path always came from a file Pages served, and if
 * that file exists the route exists. A visitor never sees this.
 */
export function App({ path }: { path: string }) {
    // Effect-only: never runs in src/entry-server.tsx, so the prerendered HTML
    // is byte-identical with and without analytics.
    useSiteAnalytics();

    const route = findRoute(path);
    if (!route) {
        throw new Error(
            `No route for "${path}". Add it to ROUTES in src/routes.tsx, or the build ` +
                'will keep emitting a page nothing links to.',
        );
    }

    // The locale is derived from the SAME `path` both callers already agree on,
    // which is what makes it hydration-safe. LocaleProvider used to infer it
    // from `window.location` when no prop was passed — a branch the server could
    // not take, so the two sides disagreed by construction on every prefixed
    // URL. One input, one answer, both sides.
    return (
        <LocaleProvider locale={localeFromPathname(path)}>{route.render()}</LocaleProvider>
    );
}
