import { settingsParse, type Settings } from '@/sync/domains/settings/settings';

export const LOCAL_ONLY_SERVER_SELECTION_KEYS = [
    'serverSelectionGroups',
    'serverSelectionActiveTargetKind',
    'serverSelectionActiveTargetId',
] as const;

export type LocalOnlyServerSelectionKey = (typeof LOCAL_ONLY_SERVER_SELECTION_KEYS)[number];

export function stripLocalOnlyServerSelectionSettings(settings: Partial<Settings>): Partial<Settings> {
    if (!settings || typeof settings !== 'object') return {};
    const next = { ...settings };
    for (const key of LOCAL_ONLY_SERVER_SELECTION_KEYS) {
        delete (next as Record<string, unknown>)[key];
    }
    return next;
}

export function pickLocalOnlyServerSelectionSettings(settings: Settings): Pick<Settings, LocalOnlyServerSelectionKey> {
    const parsed = settingsParse(settings);
    return {
        serverSelectionGroups: parsed.serverSelectionGroups,
        serverSelectionActiveTargetKind: parsed.serverSelectionActiveTargetKind,
        serverSelectionActiveTargetId: parsed.serverSelectionActiveTargetId,
    };
}
