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
    return stripLocalOnlyTerminalConnectSettings(stripLocalOnlyServerSelectionSettings(settings));
}

export function pickLocalOnlyAccountSettings(settings: Settings): Partial<Settings> {
    return {
        ...pickLocalOnlyServerSelectionSettings(settings),
        ...pickLocalOnlyTerminalConnectSettings(settings),
    };
}

