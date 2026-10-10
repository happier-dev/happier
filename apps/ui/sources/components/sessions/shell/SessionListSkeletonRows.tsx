import * as React from 'react';
import { Platform, useWindowDimensions, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierSkeletonBlock } from '@happier-dev/plugin-ui/presentation';

import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { useLocalSetting, useSetting } from '@/sync/domains/state/storage';
import { useIsTablet } from '@/utils/platform/responsive';

import { resolveSessionListDensityViewState } from './resolveSessionListDensityViewState';

/** Enough rows to fill the first screen of a rail without implying a count. */
const SKELETON_ROW_COUNT = 5;
/** Title widths cycle so the placeholder reads as varied session titles, not a uniform block. */
const TITLE_WIDTH_PERCENTAGES: ReadonlyArray<number> = [72, 54, 66, 48, 60];
const IDENTITY_SIZE_PX = 14;
const TITLE_HEIGHT_PX = 10;

const stylesheet = StyleSheet.create(() => ({
    list: {
        width: '100%',
        paddingTop: 8,
    },
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        paddingHorizontal: 20,
    },
}));

/**
 * The session list's first load: skeleton rows in the list's own shape (identity mark + title), at
 * the user's row density, instead of a "Loading sessions…" message. The bars pulse through the one
 * shared skeleton owner, which holds still under reduced motion; the whole block is hidden from
 * assistive technology, since the list's live region announces the result instead.
 */
export const SessionListSkeletonRows = React.memo(function SessionListSkeletonRows() {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const reducedMotion = useReducedMotionPreference();
    const isTablet = useIsTablet();
    const { width: windowWidth } = useWindowDimensions();
    const sessionListDensity = useSetting('sessionListDensity');
    const uiFontScale = useLocalSetting('uiFontScale');
    // Same resolver and inputs as the list's own rows, so loading → loaded does not shift.
    const { rowHeight } = resolveSessionListDensityViewState(sessionListDensity, {
        isTablet,
        platform: Platform.OS,
        uiFontScale,
        windowWidth,
    });
    const color = theme.colors.surface.pressedOverlay;

    return (
        <View
            testID="session-list-skeleton"
            style={styles.list}
            aria-hidden={true}
            accessibilityElementsHidden={true}
            importantForAccessibility="no-hide-descendants"
        >
            {TITLE_WIDTH_PERCENTAGES.slice(0, SKELETON_ROW_COUNT).map((widthPercent, index) => (
                <View
                    key={index}
                    testID={`session-list-skeleton-row:${index}`}
                    style={[styles.row, { height: rowHeight }]}
                >
                    <HappierSkeletonBlock
                        color={color}
                        width={IDENTITY_SIZE_PX}
                        height={IDENTITY_SIZE_PX}
                        radius={4}
                        reducedMotion={reducedMotion}
                    />
                    <HappierSkeletonBlock
                        color={color}
                        width={`${widthPercent}%`}
                        height={TITLE_HEIGHT_PX}
                        radius={5}
                        reducedMotion={reducedMotion}
                    />
                </View>
            ))}
        </View>
    );
});
