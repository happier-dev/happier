import type { Settings } from '@/sync/domains/settings/settings';

import {
    pickLocalOnlyServerSelectionSettings,
    stripLocalOnlyServerSelectionSettings,
} from '@/sync/domains/settings/localOnlyServerSelectionSettings';
import {
    pickLocalOnlyTerminalConnectSettings,
    stripLocalOnlyTerminalConnectSettings,
} from '@/sync/domains/settings/localOnlyTerminalConnectSettings';

export function stripLocalOnlyAccountSettings(settings: Partial<Settings>): Partial<Settings> {
    const stripped = stripLocalOnlyTerminalConnectSettings(stripLocalOnlyServerSelectionSettings(settings));
    // UI-local: "last used" values should never be synced to the server.
    // They are device-specific defaults for the new-session wizard and can churn frequently.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const {
        lastUsedAgent: _dropped,
        lastUsedBackendTarget: _droppedBackendTarget,
        lastNewSessionAgentPickerViewV1: _droppedAgentPickerView,
        ...rest
    } = stripped as any;
    return rest;
}

export function pickLocalOnlyAccountSettings(settings: Settings): Partial<Settings> {
    return {
        ...pickLocalOnlyServerSelectionSettings(settings),
        ...pickLocalOnlyTerminalConnectSettings(settings),
        lastUsedAgent: settings.lastUsedAgent,
        lastUsedBackendTarget: settings.lastUsedBackendTarget,
        lastNewSessionAgentPickerViewV1: settings.lastNewSessionAgentPickerViewV1,
    };
}
