import type { FeatureId } from '@happier-dev/protocol';
import type { TranslationKeyNoParams } from '@/text';

export type UiFeatureToggleServerVisibilityScope = 'main_selection' | 'runtime';

export type UiFeatureDefinition = Readonly<{
    settingsToggle?: Readonly<{
        showInSettings: boolean;
        isExperimental: boolean;
        defaultEnabled: boolean;
        serverVisibilityScope?: UiFeatureToggleServerVisibilityScope;
        titleKey: TranslationKeyNoParams;
        subtitleKey: TranslationKeyNoParams;
    }>;
    analytics?: Readonly<{
        trackPreference?: boolean;
        trackEffective?: boolean;
    }>;
}>;

import { UI_FEATURE_REGISTRY, getUiFeatureDefinition } from '@happier-dev/protocol/actions/settings/featurePreferenceMutations';
export { UI_FEATURE_REGISTRY, getUiFeatureDefinition };

export function shouldTrackUiFeaturePreference(featureId: FeatureId): boolean {
    const definition = getUiFeatureDefinition(featureId);
    if (typeof definition.analytics?.trackPreference === 'boolean') {
        return definition.analytics.trackPreference;
    }
    return Boolean(definition.settingsToggle);
}

export function shouldTrackUiFeatureEffective(featureId: FeatureId): boolean {
    const definition = getUiFeatureDefinition(featureId);
    if (typeof definition.analytics?.trackEffective === 'boolean') {
        return definition.analytics.trackEffective;
    }
    return true;
}
