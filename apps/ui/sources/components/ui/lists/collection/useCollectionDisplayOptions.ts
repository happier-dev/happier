import * as React from 'react';
import type { CollectionTableCardPresentation } from '@happier-dev/protocol/account/settings/accountSettings';
import { useSettingActionFeedback } from '@/components/settings/shell/useSettingActionFeedback';
import type { Settings } from '@/sync/domains/settings/settings';
import { useSettingsSelector } from '@/sync/store/settingsReadHooks';

import { COLLECTION_DISPLAY_SETTING_ANCHOR } from './collectionDisplaySettings';

const DISPLAY_KEYS = ['collectionDisplayPreferencesV1'] as const;
const readWorkflowPresentation = (settings: Settings) => settings.collectionDisplayPreferencesV1.workflow?.presentation ?? 'table';

export function useCollectionDisplayOptions(kind: 'workflow', compact: boolean) {
    const preferredPresentation = useSettingsSelector(readWorkflowPresentation, DISPLAY_KEYS, 'collection.display.workflow');
    const { setSetting } = useSettingActionFeedback();
    const setPresentation = React.useCallback((presentation: CollectionTableCardPresentation) =>
        setSetting({ anchor: COLLECTION_DISPLAY_SETTING_ANCHOR }, { kind, presentation }, { confirmed: true }), [kind, setSetting]);
    return { preferredPresentation, presentation: compact ? 'list' as const : preferredPresentation, setPresentation };
}
