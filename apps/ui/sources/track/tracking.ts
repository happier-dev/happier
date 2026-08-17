import { config } from '@/config';
import PostHog from 'posthog-react-native';
import type { FeatureId } from '@happier-dev/protocol';
import { getFeatureBuildPolicyDecision } from '@/sync/domains/features/featureBuildPolicy';
import { loadSettings } from '@/sync/domains/state/persistence';
import { settingsParse } from '@/sync/domains/settings/settings';

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

function readInitialAnalyticsOptOut(): boolean {
    try {
        const { settings } = loadSettings();
        return settingsParse(settings).analyticsOptOut;
    } catch {
        return false;
    }
}

function createTrackingClient(): PostHog {
    const postHogKey = config.postHogKey?.trim() ?? '';
    if (!postHogKey) {
        throw new Error('PostHog key is required when tracking is enabled');
    }

    const analyticsOptOut = readInitialAnalyticsOptOut();
    const client = new PostHog(postHogKey, {
        host: (config.postHogHost ?? POSTHOG_DEFAULT_HOST).trim() || POSTHOG_DEFAULT_HOST,
        captureAppLifecycleEvents: true,
        defaultOptIn: !analyticsOptOut,
    });

    if (analyticsOptOut) {
        void client.optOut();
    } else {
        void client.optIn();
    }
    return client;
}

export const tracking = ((config.postHogKey?.trim() ?? '') && getFeatureBuildPolicyDecision(ANALYTICS_FEATURE_ID) !== 'deny')
    ? createTrackingClient()
    : null;
