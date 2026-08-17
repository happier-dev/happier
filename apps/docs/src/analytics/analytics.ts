/**
 * Product analytics for docs.happier.dev.
 *
 * This is the marketing site's analytics module (apps/website/src/analytics)
 * reduced to what a documentation site needs, and it keeps every one of that
 * module's promises. Read the long header there for the reasoning; the short
 * version, because the privacy policy now states all of it as fact:
 *
 *   - cookieless_mode: 'always'. No cookie, no stored visitor id, no profile
 *     that survives a page load. This is what lets the policy say the sites set
 *     nothing on your device except your own refusal.
 *   - Do Not Track and Global Privacy Control are checked BEFORE init, so a
 *     browser that refuses is never even loaded into.
 *   - api_host is a path on this origin. The `/ingest` route handler forwards to
 *     PostHog EU, so the page makes no third-party request.
 *   - No session recording, no surveys, no autocapture, no feature-flag round
 *     trip. A docs page has nothing behind a flag and nothing worth replaying.
 *
 * REGION IS A COMPILE-TIME CONSTANT. PostHog Cloud US and EU are separate
 * deployments and a key from one is not valid in the other; posting to the wrong
 * host loses the event silently. Project 129992 is EU. apps/ui shipped with a US
 * fallback for exactly this reason and lost data until it was corrected.
 */
import type { PostHog } from 'posthog-js';

/** First-party path, proxied to PostHog EU by src/app/ingest/[...path]/route.ts. */
export const INGEST_PATH = '/ingest';

/** PostHog app host, so "open in PostHog" links and the toolbar resolve. */
export const UI_ORIGIN = 'https://eu.posthog.com';

/**
 * Stamped on every event so happier.dev, docs.*, guides.* and app.* can share
 * one project and still be told apart, without sharing an identity.
 */
export const SITE = 'docs.happier.dev' as const;

/** The visitor's refusal. The only key this site ever writes. */
export const OPT_OUT_STORAGE_KEY = 'happier:analytics';

const POSTHOG_KEY = process.env.NEXT_PUBLIC_POSTHOG_KEY ?? '';

let client: PostHog | null = null;
let started = false;
let loading = false;

/**
 * `navigator.globalPrivacyControl` is the CCPA/CPRA-recognised successor to DNT
 * and is what Firefox and Brave actually send; `doNotTrack` is kept for the
 * browsers and extensions that still only set it.
 */
function browserRefuses(): boolean {
    if (typeof navigator === 'undefined') return true;
    const nav = navigator as Navigator & {
        globalPrivacyControl?: boolean;
        msDoNotTrack?: string;
    };
    if (nav.globalPrivacyControl === true) return true;
    const dnt = nav.doNotTrack ?? nav.msDoNotTrack ?? (window as { doNotTrack?: string }).doNotTrack;
    return dnt === '1' || dnt === 'yes';
}

/** Reads the visitor's stored refusal. Storage failures mean "not opted out". */
export function readOptOut(): boolean {
    try {
        return window.localStorage.getItem(OPT_OUT_STORAGE_KEY) === 'off';
    } catch {
        return false;
    }
}

function shouldCapture(): boolean {
    return Boolean(POSTHOG_KEY) && !browserRefuses() && !readOptOut();
}

export function isAnalyticsActive(): boolean {
    return started;
}

/**
 * Turn analytics off, now and for future visits.
 *
 * `opt_out_capturing()` is a no-op under cookieless_mode, so the kill switch is
 * a `before_send` that drops every event before it is queued.
 */
export function optOut(): void {
    try {
        window.localStorage.setItem(OPT_OUT_STORAGE_KEY, 'off');
    } catch {
        /* a browser that refuses storage still gets the in-memory switch below */
    }
    client?.set_config({ before_send: () => null });
}

export function optIn(): void {
    try {
        window.localStorage.removeItem(OPT_OUT_STORAGE_KEY);
    } catch {
        /* ignore */
    }
    client?.set_config({ before_send: undefined });
    void start();
}

/** Boots PostHog once, lazily. Safe to call on every navigation. */
export async function start(): Promise<void> {
    if (started || loading || typeof window === 'undefined') return;
    if (!shouldCapture()) return;
    loading = true;
    try {
        const { default: posthog } = await import('posthog-js');
        loading = false;
        // The visitor may have opted out while the chunk was loading.
        if (!shouldCapture()) return;
        client = posthog;
        posthog.init(POSTHOG_KEY, {
            api_host: INGEST_PATH,
            ui_host: UI_ORIGIN,

            cookieless_mode: 'always',
            persistence: 'memory',
            person_profiles: 'never',

            defaults: '2026-06-25',
            autocapture: false,
            rageclick: false,
            // Handled by capturePageview() below. The App Router changes the URL
            // without a document load, and an implicit history hook is one more
            // behaviour to verify per posthog-js upgrade; an explicit call on
            // pathname change is the same data and reads as what it is.
            capture_pageview: false,
            capture_pageleave: true,
            capture_dead_clicks: false,
            capture_exceptions: false,
            capture_performance: { web_vitals: true, network_timing: false },
            mask_personal_data_properties: true,

            disable_session_recording: true,
            disable_surveys: true,
            disable_web_experiments: true,
            advanced_disable_feature_flags: true,
            advanced_disable_flags: true,
            disable_external_dependency_loading: true,

            loaded: () => {
                started = true;
            },
        });
        posthog.register({ site: SITE });
    } catch {
        loading = false;
    }
}

/** One `$pageview` per route. Called by the client component on pathname change. */
export function capturePageview(): void {
    if (!client || !started) return;
    client.capture('$pageview', { site: SITE });
}
