import * as React from 'react';

import { SESSION_SETTINGS } from '@/components/settings/session/sessionSettings';
import { useSettingActionFeedback } from '@/components/settings/shell/useSettingActionFeedback';
import { COLLECTION_DISPLAY_SETTING_ANCHOR, readSessionCollectionLines } from '@/components/ui/lists/collection/collectionDisplaySettings';
import type { SettingRef } from '@/components/settings/catalog/settingDeclarations';

const choiceSettings = new Map<string, SettingRef>([
    ['attention', SESSION_SETTINGS.settings.attentionPromotion],
    ['identity', SESSION_SETTINGS.settings.identityDisplay],
]);

/** The list menu and Settings submit the same declared choice; its owner rebases coupled fields. */
export function useSessionListViewOptionWriter() {
    const { setSetting } = useSettingActionFeedback();
    return React.useCallback((itemId: string): Promise<boolean> => {
        const separator = itemId.lastIndexOf(':');
        const key = itemId.slice(0, separator);
        const raw = itemId.slice(separator + 1);
        const collectionDisplay = { anchor: COLLECTION_DISPLAY_SETTING_ANCHOR };
        if (key === 'density' && (raw === 'narrow' || raw === 'cozy' || raw === 'detailed')) {
            return setSetting(collectionDisplay, { kind: 'sessionWork', lines: readSessionCollectionLines(raw) });
        }
        if (key === 'layout' && (raw === 'projects' || raw === 'recent_activity')) {
            return setSetting(collectionDisplay, { kind: 'sessionWork', groupBy: raw });
        }
        if (key === 'rowContext' || key === 'statusWords') {
            return setSetting(collectionDisplay, { kind: 'sessionWork', details: { [key]: raw === 'true' } });
        }
        const setting = choiceSettings.get(key);
        return setting ? setSetting(setting, raw) : Promise.resolve(false);
    }, [setSetting]);
}
