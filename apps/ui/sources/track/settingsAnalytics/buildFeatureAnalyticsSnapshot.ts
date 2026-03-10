import type { FeatureId } from '@happier-dev/protocol';

import type { ServerFeaturesMainSelectionSnapshot } from '@/sync/domains/features/featureDecisionRuntime';
import { resolveMainSelectionFeatureDecision } from '@/sync/domains/features/featureDecisionRuntime';
import {
    shouldTrackUiFeatureEffective,
    shouldTrackUiFeaturePreference,
    UI_FEATURE_REGISTRY,
} from '@/sync/domains/features/registry/uiFeatureRegistry';
import { resolveUiFeatureToggleEnabled } from '@/sync/domains/features/registry/uiFeatureToggles';
import type { Settings } from '@/sync/domains/settings/settings';

import type { SettingsAnalyticsSnapshot } from './types';

export function buildFeaturePreferenceAnalyticsSnapshot(settings: Settings): SettingsAnalyticsSnapshot {
    const properties: SettingsAnalyticsSnapshot['properties'] = {};

    for (const featureIdRaw of Object.keys(UI_FEATURE_REGISTRY)) {
        const featureId = featureIdRaw as FeatureId;
        if (!shouldTrackUiFeaturePreference(featureId)) continue;
        properties[`feature_pref__${featureId}`] = resolveUiFeatureToggleEnabled(settings, featureId);
    }

    return { properties };
}

export function buildFeatureAnalyticsSnapshot(params: {
    settings: Settings;
    mainSelectionSnapshot: ServerFeaturesMainSelectionSnapshot;
}): SettingsAnalyticsSnapshot {
    const properties: SettingsAnalyticsSnapshot['properties'] = {
        ...buildFeaturePreferenceAnalyticsSnapshot(params.settings).properties,
    };

    for (const featureIdRaw of Object.keys(UI_FEATURE_REGISTRY)) {
        const featureId = featureIdRaw as FeatureId;
        if (!shouldTrackUiFeatureEffective(featureId)) continue;
        const decision = resolveMainSelectionFeatureDecision({
            featureId,
            settings: params.settings,
            snapshot: params.mainSelectionSnapshot,
        });
        properties[`feature_effective__${featureId}`] = decision?.state === 'enabled';
    }

    return { properties };
}
