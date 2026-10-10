import { FEATURE_IDS, type FeatureId } from '@happier-dev/protocol/features/catalog';
import type { HomeSettingsProjectionV1 } from '@happier-dev/protocol/home/governance';

import {
    buildSettingHref,
    defineSettingsPage,
    builtInSettingsPageSections,
    type SettingRef,
    type SettingDeclaration,
    type SettingsSectionDeclaration,
} from '@/components/settings/catalog/settingDeclarations';
import { identitySettingHomeId } from '@/components/settings/identity/identitySettingsRoutes';

import { homeAdministrationFeaturesPath } from './homeAdministrationRoutes';
import { HOME_COMMON_FEATURE_IDS, selectHomeFeatureRows } from './homeFeatureRows';

const COMMON = new Set<FeatureId>(HOME_COMMON_FEATURE_IDS);

/** One declared row per server feature, keyed by its feature id, labelled by its Home feature label. */
function featureSettings(ids: readonly FeatureId[]): Record<string, SettingDeclaration> {
    const sections = builtInSettingsPageSections('homeAdministration.features');
    const declared = { ...sections.common?.settings, ...sections.advanced?.settings };
    return Object.fromEntries(ids.filter(id => Object.hasOwn(declared, id)).map(id => [id, declared[id]]));
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

/**
 * Where Features sets `key`, for a sentence elsewhere that says a feature option is off (DR-03): the
 * key's family, opened through one of its switches, or the page when that family shows none. `null`
 * for a key Features does not render, so the caller never links to a page without the row.
 */
export function homeFeatureKeyHref(
    serverId: string,
    settings: HomeSettingsProjectionV1 | null,
    key: string,
): string | null {
    if (!settings) return null;
    const family = selectHomeFeatureRows(settings).advanced.find((candidate) => (
        candidate.limits.some((entry) => entry.key === key) || candidate.switches.some((row) => row.entry?.key === key)
    ));
    if (!family) return null;
    const declared = HOME_FEATURE_SETTINGS.settings as Readonly<Record<string, SettingRef | undefined>>;
    const anchor = family.switches.flatMap((row) => declared[row.featureId] ?? [])[0];
    const path = homeAdministrationFeaturesPath(serverId);
    return anchor ? buildSettingHref(path, anchor) : path;
}
