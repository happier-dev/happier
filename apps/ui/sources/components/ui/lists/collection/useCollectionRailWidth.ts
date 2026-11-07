import * as React from 'react';

import { getStorage } from '@/sync/domains/state/storageStore';

/** Device-local preferences; the layout clamps rendered geometry without rewriting the preference. */
export function useCollectionRailWidth(resizeKey: string): Readonly<{
    widthPx: number | undefined;
    commit(widthPx: number): void;
    reset(): void;
}> {
    const widthPx = getStorage()((state) => {
        const width = state.localSettings.collectionRailWidthsV1[resizeKey];
        return typeof width === 'number' && Number.isFinite(width) ? width : undefined;
    }, { localSettings: ['collectionRailWidthsV1'] });
    const commit = React.useCallback((width: number) => {
        if (!Number.isFinite(width)) return;
        const state = getStorage().getState();
        const current = state.localSettings.collectionRailWidthsV1;
        if (current[resizeKey] === width) return;
        state.applyLocalSettings({ collectionRailWidthsV1: { ...current, [resizeKey]: width } }, { source: 'ui' });
    }, [resizeKey]);
    const reset = React.useCallback(() => {
        const state = getStorage().getState();
        const current = state.localSettings.collectionRailWidthsV1;
        if (!Object.hasOwn(current, resizeKey)) return;
        const next = { ...current };
        delete next[resizeKey];
        state.applyLocalSettings({ collectionRailWidthsV1: next }, { source: 'ui' });
    }, [resizeKey]);
    return React.useMemo(() => ({ widthPx, commit, reset }), [widthPx, commit, reset]);
}
