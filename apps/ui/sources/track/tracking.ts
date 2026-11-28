import { config } from '@/config';
import PostHog, { type PostHogOptions } from 'posthog-react-native';
import type { FeatureId } from '@happier-dev/protocol';
import { getFeatureBuildPolicyDecision } from '@/sync/domains/features/featureBuildPolicy';

const ANALYTICS_FEATURE_ID = 'app.analytics' as const satisfies FeatureId;

/**
 * Ingest region, as a compile-time constant rather than an environment variable.
 *
 * PostHog Cloud US and EU are SEPARATE deployments: a project key issued in one
 * region is not valid in the other, and posting to the wrong host loses the
 * event without an error anyone sees. Our project (129992) is EU.
 *
 * This used to default to `https://us.i.posthog.com`, and app.config.js sets
 * `postHogKey` but never `postHogHost` — so unless EXPO_PUBLIC_POSTHOG_HOST was
 * exported into the build, every event from the app went to the wrong continent
 * and was dropped. `EXPO_PUBLIC_POSTHOG_HOST` still overrides this for a fork or
 * a self-hosted PostHog; the difference is that forgetting it is no longer a
 * silent data loss. apps/website/src/analytics/config.ts pins its region the
 * same way, for the same reason.
 */
const POSTHOG_DEFAULT_HOST = 'https://eu.i.posthog.com';

type BeforeSendHook = Extract<NonNullable<PostHogOptions['before_send']>, (event: never) => unknown>;
type CaptureEvent = Parameters<BeforeSendHook>[0];

/**
 * Screen views are counted, not attached to the person: `$screen` is sent personless. The SDK's
 * capture() sets `$process_person_profile` itself after reading event properties, so it can only
 * be overridden here, in the before_send hook that runs after it.
 */
function sendScreenViewsPersonless(event: CaptureEvent): CaptureEvent {
    if (!event || event.event !== '$screen') return event;
    return { ...event, properties: { ...event.properties, $process_person_profile: false } };
}

function createTrackingClient(apiKey: string): PostHog {
    const client = new PostHog(apiKey, {
        host: (config.postHogHost ?? POSTHOG_DEFAULT_HOST).trim() || POSTHOG_DEFAULT_HOST,
        // Lifecycle events are off: `Application Opened` carries the launch URL, which can hold a
        // pairing secret, a share token or a self-hosted server address.
        captureAppLifecycleEvents: false,
        // Nothing is sent until the account's analytics setting is applied (applyAnalyticsOptOut).
        defaultOptIn: false,
        // The app reads no PostHog feature flags or remote config; do not fetch them at startup.
        // (This SDK version still reloads flags on identify, group changes and reset.)
        preloadFeatureFlags: false,
        disableRemoteConfig: true,
        before_send: sendScreenViewsPersonless,
    });
    // A previous launch may have opted in; start every launch opted out until the setting is applied.
    client.optOut();
    return client;
}

export const tracking = (config.postHogKey && getFeatureBuildPolicyDecision(ANALYTICS_FEATURE_ID) !== 'deny')
    ? createTrackingClient(config.postHogKey)
    : null;
