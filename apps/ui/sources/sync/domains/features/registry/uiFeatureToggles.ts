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
    const out: UiFeatureToggleDefinition[] = [];
    for (const [featureIdRaw, def] of Object.entries(UI_FEATURE_REGISTRY)) {
        const featureId = featureIdRaw as FeatureId;
        const toggle = def.settingsToggle;
        if (!toggle?.showInSettings) continue;
        out.push({
            featureId,
            isExperimental: toggle.isExperimental,
            defaultEnabled: toggle.defaultEnabled,
            titleKey: toggle.titleKey,
            subtitleKey: toggle.subtitleKey,
            icon: toggle.icon,
        });
    }
    return out;
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
    for (const [featureIdRaw, def] of Object.entries(UI_FEATURE_REGISTRY)) {
        const featureId = featureIdRaw as FeatureId;
        const toggle = def.settingsToggle;
        if (!toggle?.showInSettings) continue;
        if (params.experimentalOnly && !toggle.isExperimental) continue;
        defaults[featureId] = toggle.defaultEnabled === true;
    }
    return defaults;
}
