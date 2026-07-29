import type { Settings } from '@/sync/domains/settings/settings';
import { DEMO_CLIENT_FEATURE_TOGGLES } from './serverFeatures';

export type DemoWorldSettings = Pick<
    Settings,
    | 'featureToggles'
    | 'hideInactiveSessions'
    | 'sessionListDensity'
    | 'sessionListSectionModeV1'
    | 'sessionListAttentionPromotionModeV1'
    | 'sessionListWorkingPlacementModeV1'
>;

export function buildDemoSettings(): DemoWorldSettings {
    return {
        featureToggles: {
            'execution.runs': false,
            ...DEMO_CLIENT_FEATURE_TOGGLES,
        },
        hideInactiveSessions: false,
        sessionListDensity: 'narrow',
        sessionListSectionModeV1: 'single',
        sessionListAttentionPromotionModeV1: 'global',
        sessionListWorkingPlacementModeV1: 'global',
    };
}
