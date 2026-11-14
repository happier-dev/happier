import * as React from 'react';

import { getStorage } from '@/sync/domains/state/storageStore';
import { useSettingActionFeedback } from '@/components/settings/shell/useSettingActionFeedback';
import { COLLECTION_RAIL_WIDTH_SETTING_ANCHOR } from './collectionRailWidthSetting';

/** Device-local preferences; the layout clamps rendered geometry without rewriting the preference. */
export function useCollectionRailWidth(resizeKey: string): Readonly<{
    widthPx: number | undefined;
    commit(widthPx: number): Promise<void>;
    reset(): Promise<void>;
}> {
    const { setSetting } = useSettingActionFeedback();
    const widthPx = getStorage()((state) => {
        const width = state.localSettings.collectionRailWidthsV1[resizeKey];
        return typeof width === 'number' && Number.isFinite(width) ? width : undefined;
    }, { localSettings: ['collectionRailWidthsV1'] });
    const commit = React.useCallback(async (width: number) => {
        await setSetting({ anchor: COLLECTION_RAIL_WIDTH_SETTING_ANCHOR }, { resizeKey, widthPx: width });
    }, [resizeKey, setSetting]);
    const reset = React.useCallback(async () => {
        await setSetting({ anchor: COLLECTION_RAIL_WIDTH_SETTING_ANCHOR }, { resizeKey, widthPx: null });
    }, [resizeKey, setSetting]);
    return React.useMemo(() => ({ widthPx, commit, reset }), [widthPx, commit, reset]);
}
