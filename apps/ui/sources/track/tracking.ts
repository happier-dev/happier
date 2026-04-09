import { config } from '@/config';
import PostHog from 'posthog-react-native';
import type { FeatureId } from '@happier-dev/protocol';
import { getFeatureBuildPolicyDecision } from '@/sync/domains/features/featureBuildPolicy';
import { loadSettings } from '@/sync/domains/state/persistence';
import { settingsParse } from '@/sync/domains/settings/settings';

const ANALYTICS_FEATURE_ID = 'app.analytics' as const satisfies FeatureId;

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
        host: (config.postHogHost ?? 'https://us.i.posthog.com').trim() || 'https://us.i.posthog.com',
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
