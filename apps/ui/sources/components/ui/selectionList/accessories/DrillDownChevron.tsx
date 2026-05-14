import * as React from 'react';
import { Pressable, type GestureResponderEvent } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

const stylesheet = StyleSheet.create((theme) => ({
    pressable: {
        width: 20,
        height: 20,
        alignItems: 'center',
        justifyContent: 'center',
    },
}));

/**
 * F3 — Narrow boundary type for the cross-platform stopPropagation pattern.
 * Mirrors `PathFavoriteToggleButton`'s helper so we can call the DOM-only
 * `stopImmediatePropagation` on the underlying native event without leaking
 * `any`. Optional fields keep the contract permissive for non-event callers
 * (programmatic invocation, tests).
 */
export type DrillDownChevronPressEvent = Partial<GestureResponderEvent> & {
    stopPropagation?: () => void;
    nativeEvent?: GestureResponderEvent['nativeEvent'] & {
        stopImmediatePropagation?: () => void;
    };
};

export type DrillDownChevronProps = Readonly<{
    /**
     * F3 — accepts an optional press event so the chevron can stop the row's
     * outer Pressable from also activating `option.onSelect`. The chevron
     * sits inside `Item.rightElement`, which renders inside the row's outer
     * Pressable; without `stopPropagation` both fire on the same touch.
     */
    onPress: (event?: DrillDownChevronPressEvent) => void;
    disabled?: boolean;
    testID?: string;
    accessibilityLabel?: string;
}>;

/**
 * Touch drill-down affordance for dynamic-section rows. 20×20 visual; the
 * effective hit area is extended to ≥ 40×40 via `hitSlop` per the
 * `make-interfaces-feel-better` minimum hit-area rule.
 *
 * F3 — the inner Pressable's onPress wrapper stops propagation before
 * invoking the user-supplied `onPress`. This is the same pattern used by
 * `PathFavoriteToggleButton` (the other interactive accessory rendered
 * inside `Item.rightElement`). Without this, pressing the chevron on a
 * directory row in `PathSelectionList` would also commit the row's path.
 */
export function DrillDownChevron(props: DrillDownChevronProps): React.ReactElement {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const handlePress = React.useCallback((event?: DrillDownChevronPressEvent) => {
        if (event && typeof event.stopPropagation === 'function') {
            event.stopPropagation();
        }
        const nativeEvent = event?.nativeEvent;
        if (nativeEvent && typeof nativeEvent.stopImmediatePropagation === 'function') {
            nativeEvent.stopImmediatePropagation();
        }
        props.onPress(event);
    }, [props]);
    return (
        <Pressable
            testID={props.testID}
            accessibilityRole="button"
            accessibilityLabel={props.accessibilityLabel}
            disabled={props.disabled === true}
            onPress={handlePress}
            hitSlop={{ top: 10, right: 10, bottom: 10, left: 10 }}
            style={styles.pressable}
        >
            <Ionicons name="chevron-forward" size={16} color={theme.colors.text.secondary} />
        </Pressable>
    );
}
