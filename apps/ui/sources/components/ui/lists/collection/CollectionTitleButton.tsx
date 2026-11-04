import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HAPPIER_COLLECTION_LIST_METRICS, useHappierHitArea } from '@happier-dev/plugin-ui/presentation';

import { Icon } from '@/components/ui/icons/Icon';
import { happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useIsTablet, usePresentationWindowDimensions } from '@/utils/platform/responsive';

import { shouldUseTouchCompactRow } from './CollectionRowContent';

/** The title fills the column's title row (lab S1) under every pointer; a finger reaches the touch target through the hit area. */
const TRIGGER_SIZE = HAPPIER_COLLECTION_LIST_METRICS.titleRowHeight;
/** Optical alignment: the label, not the press fill, sits on the group labels' edge, so the fill hangs this far into the gutter. */
const TRIGGER_OPTICAL_INSET = 6;

/**
 * A title row that seats controls beside the title gives this to learn how wide the whole title wants to be
 * (in its slot, after the optical inset), so a control can yield before the space's name is cut short.
 */
export const CollectionTitleNaturalWidthContext = React.createContext<((widthPx: number) => void) | null>(null);

/** The list title's anatomy: every space title (Sessions, Workflows, Discussions) and a filter's titled trigger (a Board). */
export const collectionTitleStyles = StyleSheet.create((theme) => ({
    // The list's title is its scope: "My work ⌄" opens the scope menu. It reads as a title (primary
    // text, semibold), not as a filter pill; the funnel appears only when the view is narrowed beyond
    // the default, so the list never looks inexplicably short.
    trigger: {
        minHeight: TRIGGER_SIZE,
        minWidth: TRIGGER_SIZE,
        flexShrink: 1,
        paddingHorizontal: theme.space.s6,
        marginLeft: -TRIGGER_OPTICAL_INSET,
        borderRadius: 8,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'flex-start',
        gap: theme.space.s6,
    },
    triggerPressed: {
        backgroundColor: theme.colors.surface.pressed,
    },
    triggerLabel: {
        minWidth: 0,
        flexShrink: 1,
        ...Typography.variant('heading'),
        color: theme.colors.text.primary,
    },
    // A column that is a phone's whole page opens with the hero title, as the Inbox tab does (lab `clviews:recentP`).
    phoneTriggerLabel: {
        ...Typography.default('bold'),
        ...happierPageTextMetrics('heroTitle'),
    },
    // An unseen copy of the title laid out at its own width; clipped to nothing so it never scrolls or covers anything.
    naturalClip: {
        position: 'absolute',
        left: 0,
        top: 0,
        width: 0,
        height: 0,
        overflow: 'hidden',
    },
    naturalRow: {
        position: 'absolute',
        left: 0,
        top: 0,
        width: 4096,
        flexDirection: 'row',
        alignItems: 'flex-start',
    },
    naturalTrigger: {
        flexShrink: 0,
        marginLeft: 0,
    },
}));

/** The hit area of a title trigger drawn with `collectionTitleStyles.trigger`: the pressable forwards `hitSlop`, `onLayout` and renders `frame`. */
export function useCollectionTitleTriggerHitArea() {
    return useHappierHitArea({ restingStyle: () => collectionTitleStyles.trigger });
}

/**
 * A list's title as a control: the space's name in the title role with its chevron, opening the menu
 * or dialog its host owns (lab `clspaces`: the title names the space and opens spaces and filters).
 */
export const CollectionTitleButton = React.memo(function CollectionTitleButton(props: Readonly<{
    testID: string;
    label: string;
    accessibilityLabel: string;
    expanded: boolean;
    hasPopup: 'menu' | 'dialog';
    onPress: () => void;
    /** `page` (default): a column-as-page's title on a phone. `section`: under a page's own title, it stays a heading. */
    scale?: 'page' | 'section';
}>) {
    const styles = collectionTitleStyles;
    const { theme } = useUnistyles();
    const isTablet = useIsTablet();
    const { width: windowWidth } = usePresentationWindowDimensions();
    const phone = shouldUseTouchCompactRow({ isTablet, platform: Platform.OS, windowWidth });
    const hitArea = useCollectionTitleTriggerHitArea();
    const reportNaturalWidth = React.useContext(CollectionTitleNaturalWidthContext);
    const labelStyle = [styles.triggerLabel, phone && props.scale !== 'section' ? styles.phoneTriggerLabel : null];
    const handleNaturalLayout = React.useCallback((event: { nativeEvent: { layout: { width: number } } }) => {
        reportNaturalWidth?.(event.nativeEvent.layout.width - TRIGGER_OPTICAL_INSET);
    }, [reportNaturalWidth]);
    return (
        <Pressable
            testID={props.testID}
            accessibilityRole="button"
            accessibilityLabel={props.accessibilityLabel}
            accessibilityState={{ expanded: props.expanded }}
            aria-expanded={props.expanded}
            aria-haspopup={props.hasPopup}
            onPress={props.onPress}
            hitSlop={hitArea.hitSlop}
            onLayout={hitArea.onLayout}
            style={({ pressed }) => [styles.trigger, pressed ? styles.triggerPressed : null]}
        >
            {hitArea.frame}
            <Text numberOfLines={1} style={labelStyle}>{props.label}</Text>
            <Icon name="caret-down" size={12} color={theme.colors.text.secondary} />
            {reportNaturalWidth ? (
                <View style={styles.naturalClip} pointerEvents="none" aria-hidden
                    accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
                    <View style={styles.naturalRow}>
                        <View testID={`${props.testID}-natural`} onLayout={handleNaturalLayout}
                            style={[styles.trigger, styles.naturalTrigger]}>
                            <Text numberOfLines={1} style={labelStyle}>{props.label}</Text>
                            <Icon name="caret-down" size={12} color={theme.colors.text.secondary} />
                        </View>
                    </View>
                </View>
            ) : null}
        </Pressable>
    );
});

