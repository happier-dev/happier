import { FEATURE_IDS, isFeatureServerRepresented, type FeatureId } from '@happier-dev/protocol/features/catalog';

import {
    defineSettingsPage,
    type SettingDeclaration,
    type SettingsSectionDeclaration,
} from '@/components/settings/catalog/settingDeclarations';
import { identitySettingHomeId } from '@/components/settings/identity/identitySettingsRoutes';

import { homeAdministrationFeaturesPath } from './homeAdministrationRoutes';
import { homeFeatureDescriptionKey, homeFeatureTitleKey } from './homeFeatureLabels';
import { HOME_COMMON_FEATURE_IDS } from './homeFeatureRows';

const COMMON = new Set<FeatureId>(HOME_COMMON_FEATURE_IDS);

/** One declared row per server feature, keyed by its feature id, labelled by its Home feature label. */
function featureSettings(ids: readonly FeatureId[]): Record<string, SettingDeclaration> {
    const settings: Record<string, SettingDeclaration> = {};
    for (const id of ids) {
        if (!isFeatureServerRepresented(id)) continue;
        const titleKey = homeFeatureTitleKey(id);
        if (!titleKey) continue;
        const descriptionKey = homeFeatureDescriptionKey(id);
        settings[id] = descriptionKey ? { titleKey, descriptionKey } : { titleKey };
    }
    return settings;
}

const sections = {
    common: { titleKey: 'homeGovernance.features.common', settings: featureSettings(HOME_COMMON_FEATURE_IDS) },
    advanced: {
        titleKey: 'homeGovernance.features.advanced',
        settings: featureSettings(FEATURE_IDS.filter((id) => !COMMON.has(id))),
    },
} satisfies Record<string, SettingsSectionDeclaration>;

/** Every server feature a Home offers, found by its name in search (plan §3.8). */
export const HOME_FEATURE_SETTINGS = defineSettingsPage({
    pageId: 'homeAdministration',
    subpage: {
        id: 'features',
        titleKey: 'homeGovernance.features.title',
        route: (context) => {
            const serverId = identitySettingHomeId(context);
            return serverId ? homeAdministrationFeaturesPath(serverId) : null;
        },
    },
    sections,
});
