import type { FeatureId } from '@happier-dev/protocol';
import type { TranslationKey } from '@/text';

import { getUiFeatureDefinition, UI_FEATURE_REGISTRY } from './uiFeatureRegistry';

type FeatureToggleSettings = Readonly<{
    experiments?: boolean | null | undefined;
    featureToggles?: Record<string, boolean> | null | undefined;
}>;

export type UiFeatureToggleDefinition = Readonly<{
    featureId: FeatureId;
    isExperimental: boolean;
    defaultEnabled: boolean;
    titleKey: TranslationKey;
    subtitleKey: TranslationKey;
    icon: Readonly<{
        ioniconName: string;
        color: string;
    }>;
}>;

export function listUiFeatureToggleDefinitions(): ReadonlyArray<UiFeatureToggleDefinition> {
    return Object.values(UI_FEATURE_REGISTRY)
        .map((d) => {
            const toggle = d.settingsToggle;
            if (!toggle?.showInSettings) return null;
            return {
                featureId: d.id,
                isExperimental: toggle.isExperimental,
                defaultEnabled: toggle.defaultEnabled,
                titleKey: toggle.titleKey,
                subtitleKey: toggle.subtitleKey,
                icon: toggle.icon,
            } satisfies UiFeatureToggleDefinition;
        })
        .filter((v): v is UiFeatureToggleDefinition => v !== null);
}

export function resolveUiFeatureToggleEnabled(settings: FeatureToggleSettings, featureId: FeatureId): boolean {
    const def = getUiFeatureDefinition(featureId);
    const toggle = def.settingsToggle;
    if (!toggle) return true;

    if (toggle.isExperimental && settings.experiments !== true) return false;

    const map = settings.featureToggles && typeof settings.featureToggles === 'object'
        ? settings.featureToggles
        : null;
    const explicit = map?.[featureId];
    if (typeof explicit === 'boolean') return explicit;

    return toggle.defaultEnabled === true;
}

export function buildUiFeatureToggleDefaults(params: { experimentalOnly: boolean }): Record<string, boolean> {
    const defaults: Record<string, boolean> = {};
    for (const def of Object.values(UI_FEATURE_REGISTRY)) {
        const toggle = def.settingsToggle;
        if (!toggle?.showInSettings) continue;
        if (params.experimentalOnly && !toggle.isExperimental) continue;
        defaults[def.id] = toggle.defaultEnabled === true;
    }
    return defaults;
}

