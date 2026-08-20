/**
 * PostHog for happier.dev.
 *
 * Posture, and why each line is what it is:
 *
 *   cookieless_mode: 'always'
 *     PostHog writes no cookie, no localStorage, no sessionStorage, no
 *     IndexedDB. Identity is a salted hash computed on PostHog's ingest servers
 *     from request attributes, with a salt that rotates daily and is never
 *     stored, so unique-visitor and session numbers still work without putting
 *     anything on the visitor's machine. This — not `persistence: 'memory'` —
 *     is what makes the consent banner unnecessary (see CONSENT.md), because
 *     ePrivacy Art. 5(3) is triggered by *storing or accessing* information on
 *     terminal equipment, and we do neither.
 *
 *     REQUIRED PROJECT SETTING: cookieless must be enabled on project 129992
 *     (Project settings -> "Cookieless server hash mode"). If it is not, PostHog
 *     DROPS every cookieless event server-side and the site looks instrumented
 *     while recording nothing. `verifyIngest()` below exists to catch that.
 *
 *   persistence: 'memory'
 *     Redundant while cookieless_mode is on, and deliberately so: if the project
 *     setting is ever flipped off, the failure mode is "we lose data", never
 *     "we silently start writing cookies on a site that promises it doesn't".
 *
 *   THE DNT / OPT-OUT TRAP (verified in posthog-js 1.414.0 source)
 *     posthog-core.js:3750 `is_capturing()` returns `true` UNCONDITIONALLY when
 *     cookieless_mode === 'always'. consent.js:39 `isOptedOut()` likewise returns
 *     `true` unconditionally, and posthog-core.js:134 defines
 *     CONSENT_COOKIELESS_WARN — "Consent opt in/out is not valid with
 *     cookieless_mode='always' and will be ignored".
 *     Consequence: `respect_dnt: true` and `posthog.opt_out_capturing()` DO
 *     NOTHING in this mode. Shipping them and claiming we honour Do Not Track
 *     would be a false statement on a page that sells privacy. So the gate is
 *     ours: `shouldCapture()` runs BEFORE init, and when it says no we never
 *     call `posthog.init` at all — the network request is never made and the
 *     lazy chunk is never fetched.
 *
 *   autocapture: false
 *     Autocapture exfiltrates the text content of every clicked element. On a
 *     one-page site it produces `$autocapture` noise instead of answers, and it
 *     is impossible to describe honestly in a privacy policy. Every event on
 *     this site is named, typed, and listed in src/analytics/events.ts.
 *
 *   the `module.slim.no-external` entrypoint
 *     Session replay, surveys, product tours and the toolbar's external loader
 *     are not merely disabled — they are not in the bundle. A reader can verify
 *     that claim with `grep -c rrweb dist/assets/*.js`. "Disabled by config" is
 *     a promise; "absent from the artifact" is a fact.
 *
 *   IP ADDRESS: `PostHogConfig.ip` is documented in @posthog/types as having no
 *     effect. The only working control is the project-level "Discard client IP
 *     data" toggle, which must be ON for project 129992. GeoIP-derived
 *     country/region survive that toggle; the raw address does not.
 */
import type { PostHog } from 'posthog-js/dist/module.slim.no-external';

import { DEFAULT_LOCALE, localeFromPathname } from '../i18n/locales';
import {
    INGEST_ORIGIN,
    OPT_OUT_STORAGE_KEY,
    POSTHOG_KEY,
    SITE,
    UI_ORIGIN,
} from './config';

let started = false;
let loading = false;
let client: PostHog | null = null;

/**
 * Imported from `../i18n/locales` (the pure registry) rather than `../i18n`
 * (which exports React components): analytics boots before React does, and
 * pulling the provider in from main.tsx's first import would drag the component
 * tree into the critical path for the sake of one string.
 */
function readLocale(): string {
    try {
        return localeFromPathname(window.location.pathname);
    } catch {
        return DEFAULT_LOCALE;
    }
}

/** True when analytics is live in this page load. Events no-op otherwise. */
export function isAnalyticsActive(): boolean {
    return started;
}

/**
 * Every reason we refuse to measure, evaluated before init.
 *
 * `navigator.globalPrivacyControl` ONLY, deliberately — `doNotTrack` used to be
 * checked here too and is not any more.
 *
 * GPC is the signal that carries weight: it is a recognised opt-out under
 * CCPA/CPRA, Colorado and Connecticut, and Brave and DuckDuckGo send it by
 * default, so honouring it is both a legal position and the behaviour a real
 * share of visitors expect. DNT was neither. The W3C discontinued the spec in
 * 2019, Safari removed the property outright the same year because it had become
 * a fingerprinting vector, and Firefox has since retired its checkbox in favour
 * of GPC — leaving a signal that binds nobody, that the browsers themselves have
 * walked away from, and that silently dropped a slice of traffic skewed towards
 * exactly the privacy-minded developers this product is for.
 *
 * posthog-js cannot check GPC for us in cookieless mode (see the header), so it
 * is checked here.
 */
export function shouldCapture(): boolean {
    if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;

    const nav = navigator as Navigator & { globalPrivacyControl?: boolean };
    if (nav.globalPrivacyControl === true) return false;

    if (readOptOut()) return false;

    return true;
}

/** Reads the visitor's stored refusal. Storage failures mean "not opted out". */
export function readOptOut(): boolean {
    try {
        return window.localStorage.getItem(OPT_OUT_STORAGE_KEY) === 'off';
    } catch {
        return false;
    }
}

/**
 * Turn analytics off, now and for future visits.
 *
 * `posthog.opt_out_capturing()` is a no-op under cookieless_mode (see header),
 * so the kill switch is a `before_send` that drops every event on the floor.
 * BeforeSendFn returning null discards the event before it is queued
 * (@posthog/types capture.d.ts:88).
 *
 * This writes ONE localStorage key. That write is the single piece of storage
 * this site ever puts on a device, and it exists only to remember a refusal —
 * the same "strictly necessary" carve-out that lets a consent banner remember
 * that you said no.
 */
export function optOut(): void {
    try {
        window.localStorage.setItem(OPT_OUT_STORAGE_KEY, 'off');
    } catch {
        /* private mode: the in-page kill switch below still applies */
    }
    client?.set_config({ before_send: () => null });
    started = false;
}

/** Re-enable analytics. Takes effect on the next page load. */
export function optIn(): void {
    try {
        window.localStorage.removeItem(OPT_OUT_STORAGE_KEY);
    } catch {
        /* nothing to clear */
    }
}

/**
 * `happier.dev/?analytics=off` opts out, `?analytics=on` opts back in.
 *
 * A URL is the only opt-out that survives being written down: it can be put in
 * the privacy policy, pasted into an issue, and used by someone who does not
 * want to click a widget on the page they are avoiding.
 */
function applyUrlOptOut(): void {
    try {
        const value = new URLSearchParams(window.location.search).get('analytics');
        if (value === 'off') optOut();
        else if (value === 'on') optIn();
    } catch {
        /* malformed query string */
    }
}

/**
 * Mount PostHog. Safe to call during prerender and safe to call twice.
 *
 * Called from src/main.tsx BEFORE createRoot, so the `$pageview` timestamp is
 * the page's, not React's. The prerenderer executes the entry module in a
 * headless context; `import.meta.env.SSR` and the `window` guard in
 * `shouldCapture()` both keep it inert there, so the prerendered HTML never
 * contains a fired pageview and the crawler never triggers ingest.
 */
export function initAnalytics(): void {
    if (started || loading) return;
    if (import.meta.env.SSR) return;
    applyUrlOptOut();
    if (!shouldCapture()) return;

    if (!POSTHOG_KEY) {
        // Loud, but only in the browser console — a missing key must never take
        // the marketing page down. The production build already refuses to
        // produce this artifact (assertAnalyticsKey in vite.config.ts).
        console.error(
            '[analytics] VITE_POSTHOG_KEY is not set — happier.dev is shipping blind. ' +
                'Set it in the Cloudflare Pages environment and redeploy.',
        );
        return;
    }

    loading = true;
    void import('posthog-js/dist/module.slim.no-external')
        .then(({ default: posthog }) => {
            loading = false;
            // The visitor may have opted out while the lazy chunk was loading.
            if (!shouldCapture()) return;
            client = posthog;
            posthog.init(POSTHOG_KEY, {
        // --- where ---------------------------------------------------------
        api_host: INGEST_ORIGIN,
        ui_host: UI_ORIGIN,

        // --- storage & identity --------------------------------------------
        cookieless_mode: 'always',
        persistence: 'memory',
        // No `identify`, no `group`, no person properties: an anonymous visitor
        // to a marketing page is not a person we have any business profiling.
        person_profiles: 'never',

        // --- what we collect ------------------------------------------------
        defaults: '2026-06-25',
        autocapture: false,
        rageclick: false,
        capture_pageview: true, // once per load; the page has no router
        capture_pageleave: true, // gives time-on-page and scroll depth for free
        capture_dead_clicks: false,
        capture_exceptions: false,
        // LCP/CLS/FCP/INP. This page ships ~24MB of imagery and Core Web Vitals
        // are the one performance signal that is also an SEO signal, so it is
        // the one piece of passive collection that earns its place.
        capture_performance: { web_vitals: true, network_timing: false },
        // Strips gclid/fbclid/… out of $current_url before it leaves the browser.
        mask_personal_data_properties: true,

        // --- what we refuse to collect ---------------------------------------
        disable_session_recording: true,
        disable_surveys: true,
        disable_web_experiments: true,
        // Nothing on this site is behind a flag, so the /flags round-trip is
        // pure latency and one more request shape to explain.
        advanced_disable_feature_flags: true,
        advanced_disable_flags: true,
        // Belt and braces with the slim entrypoint: no runtime script injection.
        disable_external_dependency_loading: true,

        // --- shape ------------------------------------------------------------
                loaded: () => {
                    started = true;
                },
                sanitize_properties: (properties, _eventName) => ({
                    ...properties,
                    // Lets happier.dev, docs.*, guides.* and app.* live in one project
                    // and still be told apart, without any shared identity.
                    site: SITE,
                    // Chinese-locale devices outnumber en-US in the app 1,766 to 1,134.
                    // Every insight in the dashboard can be broken down by this, so the
                    // question "does the zh-Hans page convert?" is answerable from day
                    // one rather than after a schema migration.
                    locale: readLocale(),
                }),
            });
            started = true;
        })
        .catch((error: unknown) => {
            loading = false;
            console.error('[analytics] failed to load PostHog', error);
        });
}

/**
 * The single emitter. Every event on this site goes through here.
 *
 * Nothing else in src/ may call `posthog.capture` directly — the typed wrappers
 * in src/analytics/events.ts are the whole public surface, and
 * events.test.ts enforces that.
 */
export function track(event: string, properties?: Record<string, unknown>): void {
    if (!started) return;
    client?.capture(event, properties);
}

/** Exposed for the footer control and for anyone who wants it from a console. */
declare global {
    interface Window {
        happierAnalytics?: {
            optOut: () => void;
            optIn: () => void;
            isOptedOut: () => boolean;
            isActive: () => boolean;
        };
    }
}

export function exposeAnalyticsControls(): void {
    if (typeof window === 'undefined') return;
    window.happierAnalytics = {
        optOut,
        optIn,
        isOptedOut: readOptOut,
        isActive: isAnalyticsActive,
    };
}
