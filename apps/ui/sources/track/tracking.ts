import { config } from '@/config';
import PostHog from 'posthog-react-native';
import type { FeatureId } from '@happier-dev/protocol';
import { getFeatureBuildPolicyDecision } from '@/sync/domains/features/featureBuildPolicy';

const ANALYTICS_FEATURE_ID = 'app.analytics' as const satisfies FeatureId;

export const tracking = (config.postHogKey && getFeatureBuildPolicyDecision(ANALYTICS_FEATURE_ID) !== 'deny') ? new PostHog(config.postHogKey, {
    host: 'https://us.i.posthog.com',
    captureAppLifecycleEvents: true,
}) : null;
