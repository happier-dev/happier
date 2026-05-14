import * as React from 'react';
import { Animated } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import ReanimatedAnimated, {
    useAnimatedStyle,
    useSharedValue,
    withTiming,
} from 'react-native-reanimated';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { SelectionListBackChip } from './SelectionListBackChip';
import { selectionListTestId } from './_shared';

const SEARCH_ICON_SIZE = 16;
const LEADING_SWAP_DURATION_MS = 180;
const LEADING_WIDTH_SEARCH_PX = 24;
const LEADING_WIDTH_BACK_CHIP_PX = 96;

const stylesheet = StyleSheet.create(() => ({
    leadingSlot: {
        marginRight: 8,
        alignItems: 'center',
        justifyContent: 'center',
    },
    leadingSearchIcon: {
        width: SEARCH_ICON_SIZE,
        height: SEARCH_ICON_SIZE,
        alignItems: 'center',
        justifyContent: 'center',
    },
    leadingBackWrap: {
        flexShrink: 1,
    },
}));

export type SelectionListSearchHeaderLeadingSlotProps = Readonly<{
    canPop: boolean;
    backLabel?: string;
    onPopStep?: () => void;
    reducedMotion: boolean;
    rootTestID?: string;
}>;

export function SelectionListSearchHeaderLeadingSlot(
    props: SelectionListSearchHeaderLeadingSlotProps,
): React.ReactElement {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const searchOpacity = React.useRef(new Animated.Value(props.canPop ? 0 : 1)).current;
    const backOpacity = React.useRef(new Animated.Value(props.canPop ? 1 : 0)).current;
    const lastCanPopRef = React.useRef<boolean>(props.canPop);
    const leadingWidth = useSharedValue(
        props.canPop ? LEADING_WIDTH_BACK_CHIP_PX : LEADING_WIDTH_SEARCH_PX,
    );
    const targetWidth = props.canPop ? LEADING_WIDTH_BACK_CHIP_PX : LEADING_WIDTH_SEARCH_PX;

    React.useLayoutEffect(() => {
        if (!props.reducedMotion) return;
        if (leadingWidth.value === targetWidth) return;
        leadingWidth.value = targetWidth;
    }, [props.reducedMotion, targetWidth, leadingWidth]);

    React.useEffect(() => {
        if (lastCanPopRef.current === props.canPop) return;
        lastCanPopRef.current = props.canPop;
        const next = props.canPop ? LEADING_WIDTH_BACK_CHIP_PX : LEADING_WIDTH_SEARCH_PX;
        if (props.reducedMotion) {
            searchOpacity.setValue(props.canPop ? 0 : 1);
            backOpacity.setValue(props.canPop ? 1 : 0);
            leadingWidth.value = next;
            return;
        }
        Animated.parallel([
            Animated.timing(searchOpacity, {
                toValue: props.canPop ? 0 : 1,
                duration: LEADING_SWAP_DURATION_MS,
                useNativeDriver: true,
            }),
            Animated.timing(backOpacity, {
                toValue: props.canPop ? 1 : 0,
                duration: LEADING_SWAP_DURATION_MS,
                useNativeDriver: true,
            }),
        ]).start();
        leadingWidth.value = withTiming(next, { duration: LEADING_SWAP_DURATION_MS });
    }, [props.canPop, props.reducedMotion, searchOpacity, backOpacity, leadingWidth]);

    const leadingAnimatedStyle = useAnimatedStyle(() => ({
        width: props.reducedMotion ? targetWidth : leadingWidth.value,
    }));

    const handlePopStep = React.useCallback(() => {
        props.onPopStep?.();
    }, [props.onPopStep]);

    return (
        <ReanimatedAnimated.View
            testID={selectionListTestId(props.rootTestID, 'leading', 'animator')}
            style={[styles.leadingSlot, leadingAnimatedStyle]}
        >
            {!props.canPop ? (
                <Animated.View
                    testID={selectionListTestId(props.rootTestID, 'leading', 'search-icon')}
                    style={[styles.leadingSearchIcon, { opacity: searchOpacity }]}
                >
                    <Ionicons name="search" size={SEARCH_ICON_SIZE} color={theme.colors.text.secondary} />
                </Animated.View>
            ) : (
                <Animated.View style={[styles.leadingBackWrap, { opacity: backOpacity }]}>
                    <SelectionListBackChip
                        label={props.backLabel ?? ''}
                        onPress={handlePopStep}
                        testID={selectionListTestId(props.rootTestID, 'leading', 'back-chip')}
                    />
                </Animated.View>
            )}
        </ReanimatedAnimated.View>
    );
}
