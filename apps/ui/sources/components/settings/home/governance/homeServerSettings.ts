import { SERVER_CONFIG_REGISTRY_BASE } from '@happier-dev/protocol/serverConfig/registry';
import type { HomeSettingEntryV1 } from '@happier-dev/protocol/home/governance';

import {
    defineSettingsPage,
    type SettingDeclaration,
    type SettingsSectionDeclaration,
} from '@/components/settings/catalog/settingDeclarations';
import { identitySettingHomeId } from '@/components/settings/identity/identitySettingsRoutes';

import { homeAdministrationServerSettingsPath } from './homeAdministrationRoutes';
import { homeServerSettingGroupTitleKey, homeServerSettingTitleKey } from './homeServerSettingLabels';
import { homeServerSettingGroupOf, isHomeServerSettingsEntry } from './homeServerSettingsRows';

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

function buildSections(): Record<string, SettingsSectionDeclaration> {
    const groups = new Map<string, Record<string, SettingDeclaration>>();
    const readOnly: Record<string, SettingDeclaration> = {};
    for (const key of Object.keys(SERVER_CONFIG_REGISTRY_BASE)) {
        const entry = declarationEntry(key);
        const titleKey = homeServerSettingTitleKey(key);
        if (!entry || !titleKey) continue;
        if (entry.editable === 'bootstrap') {
            readOnly[key] = { titleKey };
            continue;
        }
        if (!isHomeServerSettingsEntry(entry)) continue;
        const group = homeServerSettingGroupOf(entry);
        const settings = groups.get(group) ?? {};
        settings[key] = { titleKey };
        groups.set(group, settings);
    }
    const sections: Record<string, SettingsSectionDeclaration> = {};
    for (const [group, settings] of groups) {
        const titleKey = homeServerSettingGroupTitleKey(group);
        sections[group] = titleKey ? { titleKey, settings } : { settings };
    }
    for (const group of ['rateLimits', 'retentionCaps'] as const) {
        const titleKey = homeServerSettingGroupTitleKey(group);
        if (titleKey) sections[group] = { titleKey, settings: { ...sections[group]?.settings, [group]: { titleKey } } };
    }
    sections.readOnly = { titleKey: 'homeSettings.page.readOnlyTitle', settings: readOnly };
    return sections;
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
