import * as React from 'react';
import { Platform, useWindowDimensions } from 'react-native';

import { SkeletonRows } from '@/components/ui/lists/SkeletonRows';
import { useLocalSetting } from '@/sync/domains/state/storage';
import { useSessionCollectionDensity } from '@/components/ui/lists/collection/useCollectionDisplayOptions';
import { useIsTablet } from '@/utils/platform/responsive';

import { resolveSessionListDensityViewState } from './resolveSessionListDensityViewState';

/** Enough rows to fill the first screen of a rail without implying a count. */
const SKELETON_ROW_COUNT = 5;
/** The rail rows' own geometry: the identity mark's column and the rows' insets. */
const SESSION_LIST_SKELETON_GEOMETRY = Object.freeze({ insetStart: 20, insetEnd: 20, glyphColumn: 14, glyphSize: 14, gap: 10 });
const SKELETON_LIST_STYLE = { paddingTop: 8 } as const;

const sessionListSkeletonRowTestID = (index: number) => `session-list-skeleton-row:${index}`;

/**
 * The session list's first load: the shared loading rows in the list's own shape (identity mark +
 * title), at the user's row density, instead of a "Loading sessions…" message. The whole block is hidden
 * from assistive technology, since the list's live region announces the result instead.
 */
export const SessionListSkeletonRows = React.memo(function SessionListSkeletonRows() {
    const isTablet = useIsTablet();
    const { width: windowWidth } = useWindowDimensions();
    const sessionListDensity = useSessionCollectionDensity();
    const uiFontScale = useLocalSetting('uiFontScale');
    // Same resolver and inputs as the list's own rows, so loading → loaded does not shift.
    const { rowHeight } = resolveSessionListDensityViewState(sessionListDensity, {
        isTablet,
        platform: Platform.OS,
        uiFontScale,
        windowWidth,
    });
    return (
        <SkeletonRows
            testID="session-list-skeleton"
            rows={SKELETON_ROW_COUNT}
            rowHeight={rowHeight}
            lines={1}
            geometry={SESSION_LIST_SKELETON_GEOMETRY}
            rowTestID={sessionListSkeletonRowTestID}
            style={SKELETON_LIST_STYLE}
        />
    );
});
