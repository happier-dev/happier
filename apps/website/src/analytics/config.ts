/**
 * Analytics wiring constants.
 *
 * The ingest region is a COMPILE-TIME CONSTANT, not an environment variable.
 *
 * The mobile app reads its PostHog host from EXPO_PUBLIC_POSTHOG_HOST
 * (apps/ui/sources/sync/runtime/appConfig.ts:125) and falls back to
 * `https://us.i.posthog.com` (apps/ui/sources/track/tracking.ts:27) — while
 * project 129992 is on PostHog Cloud *EU*. A missing env var in that setup
 * silently ships events to the wrong continent and nothing fails. The web build
 * does not repeat that pattern: the region is part of the source, and the only
 * thing injected at build time is the (public, write-only) project key.
 *
 * `INGEST_ORIGIN` is a first-party path on this origin, reverse-proxied to
 * PostHog EU by functions/ingest/[[path]].ts. Two reasons, both load-bearing:
 *   1. The audience is developers. EasyPrivacy blocks `*.i.posthog.com`, so a
 *      direct integration measures the subset of our market least like our
 *      market.
 *   2. A first-party path means the page makes zero third-party requests. For a
 *      site whose entire pitch is sovereignty, "this page talks to nobody but
 *      happier.dev" is a claim worth being able to make literally.
 * `UI_ORIGIN` must stay the real PostHog UI host so the "view in PostHog" links
 * and the toolbar resolve.
 */

/** First-party ingest path. Proxied to PostHog Cloud EU (Frankfurt). */
export const INGEST_ORIGIN = 'https://happier.dev/ingest';

/** Where the proxy forwards to. Also used by the Pages Function. */
export const POSTHOG_EU_ORIGIN = 'https://eu.i.posthog.com';

/** PostHog EU asset host — used by the proxy for /static/*. */
export const POSTHOG_EU_ASSETS_ORIGIN = 'https://eu-assets.i.posthog.com';

/** PostHog app host, for toolbar + "open in PostHog" deep links. */
export const UI_ORIGIN = 'https://eu.posthog.com';

/**
 * Project 129992's public write key.
 *
 * PostHog project keys are designed to live in client bundles: they can write
 * events and read feature flags, and cannot read any data back. It is injected
 * rather than hard-coded only so a fork or a preview deploy can point somewhere
 * else. `assertAnalyticsKey()` in vite.config.ts fails the production build when
 * it is absent, so a silent no-analytics deploy is not reachable.
 */
export const POSTHOG_KEY = import.meta.env.VITE_POSTHOG_KEY ?? '';

/**
 * Stamped on every event so all four properties can share one PostHog project
 * without sharing an identity. See the cross-property note in
 * src/analytics/analytics.ts.
 */
export const SITE = 'happier.dev' as const;

/** localStorage key holding a visitor's refusal. The only key we ever write. */
export const OPT_OUT_STORAGE_KEY = 'happier:analytics';
