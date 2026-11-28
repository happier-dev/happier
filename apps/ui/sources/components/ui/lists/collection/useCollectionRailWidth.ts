import * as React from 'react';

import { useCollectionRailGeometry } from '@/sync/domains/state/paneGeometryUiState';
import { useSettingActionFeedback } from '@/components/settings/shell/useSettingActionFeedback';
import { COLLECTION_RAIL_WIDTH_SETTING_ANCHOR } from './collectionRailWidthSetting';

/** Device-local preferences; the layout clamps rendered geometry without rewriting the preference. */
export function useCollectionRailWidth(resizeKey: string): Readonly<{
    widthPx: number | undefined;
    commit(widthPx: number): Promise<void>;
    reset(): Promise<void>;
}> {
    const { setSetting } = useSettingActionFeedback();
    const widthPx = useCollectionRailGeometry(resizeKey);
    const commit = React.useCallback(async (width: number) => {
        await setSetting({ anchor: COLLECTION_RAIL_WIDTH_SETTING_ANCHOR }, { resizeKey, widthPx: width });
    }, [resizeKey, setSetting]);
    const reset = React.useCallback(async () => {
        await setSetting({ anchor: COLLECTION_RAIL_WIDTH_SETTING_ANCHOR }, { resizeKey, widthPx: null });
    }, [resizeKey, setSetting]);
    return React.useMemo(() => ({ widthPx, commit, reset }), [widthPx, commit, reset]);
}
