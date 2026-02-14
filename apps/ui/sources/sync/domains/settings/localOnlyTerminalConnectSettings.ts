import { settingsParse, type Settings } from '@/sync/domains/settings/settings';

export const LOCAL_ONLY_TERMINAL_CONNECT_KEYS = [
    'terminalConnectLegacySecretExportEnabled',
] as const;

export type LocalOnlyTerminalConnectKey = (typeof LOCAL_ONLY_TERMINAL_CONNECT_KEYS)[number];

export function stripLocalOnlyTerminalConnectSettings(settings: Partial<Settings>): Partial<Settings> {
    if (!settings || typeof settings !== 'object') return {};
    const next = { ...settings };
    for (const key of LOCAL_ONLY_TERMINAL_CONNECT_KEYS) {
        delete (next as Record<string, unknown>)[key];
    }
    return next;
}

export function pickLocalOnlyTerminalConnectSettings(settings: Settings): Pick<Settings, LocalOnlyTerminalConnectKey> {
    const parsed = settingsParse(settings);
    return {
        terminalConnectLegacySecretExportEnabled: parsed.terminalConnectLegacySecretExportEnabled,
    } satisfies Pick<Settings, LocalOnlyTerminalConnectKey>;
}
