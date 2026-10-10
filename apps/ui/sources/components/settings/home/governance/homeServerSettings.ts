import { SERVER_CONFIG_REGISTRY_BASE } from '@happier-dev/protocol/serverConfig/registry';
import type { HomeSettingEntryV1 } from '@happier-dev/protocol/home/governance';

import {
    defineSettingsPage,
    builtInSettingsPageSections,
    builtInSettingUiDeclaration,
    type SettingDeclaration,
    type SettingsSectionDeclaration,
} from '@/components/settings/catalog/settingDeclarations';
import { identitySettingHomeId } from '@/components/settings/identity/identitySettingsRoutes';

import { homeAdministrationServerSettingsPath } from './homeAdministrationRoutes';
import { BUILT_IN_SETTINGS_DECLARATIONS_V1 } from '@happier-dev/protocol/actions/settings/settingsDeclarations';

/**
 * Search declarations for Server settings (plan §3.14 "Console rendering"): one declared row per
 * key of the hand-written registry the page renders, under its group, and the read-only keys under
 * their own section. Families the Home derives at start (per-route rate limits, retention caps) are
 * found through their group's title.
 */
function declarationEntry(key: string): HomeSettingEntryV1 | null {
    const entry = SERVER_CONFIG_REGISTRY_BASE[key];
    if (!entry || entry.editable === 'internal') return null;
    return {
        key,
        value: null,
        source: 'default',
        fixed: false,
        editable: entry.editable,
        apply: entry.apply,
        declaration: {
            type: entry.type,
            section: entry.section,
            ...(entry.group !== undefined ? { group: entry.group } : {}),
            ...(entry.family !== undefined ? { family: entry.family } : {}),
        },
    };
}

/**
 * One registry key as a search declaration: its title, its secrecy and its `home.settings` storage.
 * Server settings declares the keys it renders; a bespoke page that owns registry rows (Sign-in
 * providers' platforms) declares its keys through the same builder.
 */
export function homeRegistrySettingDeclaration(key: string): Readonly<{
    entry: HomeSettingEntryV1;
    declaration: SettingDeclaration;
}> | null {
    const entry = declarationEntry(key);
    const declared = BUILT_IN_SETTINGS_DECLARATIONS_V1.find(candidate => candidate.storage?.scope === 'home'
        && candidate.storage.kind === 'homeSettings' && candidate.storage.key === key);
    if (!entry || !declared) return null;
    return {
        entry,
        declaration: builtInSettingUiDeclaration(declared.anchor),
    };
}

function buildSections(): Record<string, SettingsSectionDeclaration> {
    return builtInSettingsPageSections('homeAdministration.serverSettings');
}

/** Every registry setting with no page of its own, found by its name in search. */
export const HOME_SERVER_SETTINGS = defineSettingsPage({
    pageId: 'homeAdministration',
    subpage: {
        id: 'serverSettings',
        titleKey: 'homeSettings.page.title',
        route: (context) => {
            const serverId = identitySettingHomeId(context);
            return serverId ? homeAdministrationServerSettingsPath(serverId) : null;
        },
    },
    sections: buildSections(),
});
