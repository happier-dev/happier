import * as React from 'react';

import { SESSION_SETTINGS } from '@/components/settings/session/sessionSettings';
import { useSettingActionFeedback } from '@/components/settings/shell/useSettingActionFeedback';
import type { SettingRef } from '@/components/settings/catalog/settingDeclarations';

const choiceSettings = new Map<string, SettingRef>([
    ['layout', SESSION_SETTINGS.settings.layout],
    ['attention', SESSION_SETTINGS.settings.attentionPromotion],
    ['identity', SESSION_SETTINGS.settings.identityDisplay],
    ['density', SESSION_SETTINGS.settings.listDensity],
    ['rowContext', SESSION_SETTINGS.settings.rowContext],
    ['statusWords', SESSION_SETTINGS.settings.statusWords],
]);
/** Switch choices carry their boolean; every other choice is its declared value. */
const BOOLEAN_CHOICES = new Set(['rowContext', 'statusWords']);

/** The list menu and Settings submit the same declared choice; its owner rebases coupled fields. */
export function useSessionListViewOptionWriter() {
    const { setSetting } = useSettingActionFeedback();
    return React.useCallback((itemId: string): Promise<boolean> => {
        const separator = itemId.lastIndexOf(':');
        const setting = choiceSettings.get(itemId.slice(0, separator));
        const key = itemId.slice(0, separator);
        const raw = itemId.slice(separator + 1);
        const value = BOOLEAN_CHOICES.has(key) ? raw === 'true' : raw;
        return setting ? setSetting(setting, value) : Promise.resolve(false);
    }, [setSetting]);
}
