/**
 * PathFavoriteToggleButton — small, standalone star toggle rendered as the
 * `rightAccessory` for path rows in `PathSelectionList` (favorites, recents,
 * and the dynamic IN THIS FOLDER section).
 *
 * Behavior:
 *   - Filled `star` icon (theme `state.warning.foreground`) when the path is
 *     currently a favorite; outline `star-outline` icon (theme
 *     `text.tertiary`) when it is not.
 *   - Pressing the icon invokes `onToggle(path)` and STOPS propagation so the
 *     enclosing row's `onSelect` does NOT fire.
 *   - 20×20 visual hit; effective hit area extended via `hitSlop` per the
 *     `make-interfaces-feel-better` minimum hit-area rule.
 *   - The `accessibilityLabel` reflects the current state ("Add to favorites"
 *     vs "Remove from favorites") so screen readers announce the action that
 *     pressing the button will perform.
 */

import * as React from 'react';
import { Pressable, type GestureResponderEvent } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

// F8 — Narrow boundary types: the cross-platform stop-propagation pattern
// needs to call DOM-only `stopImmediatePropagation` on the underlying
// native event without leaking `any`. Mirrors the documented helper in
// `ReviewCommentLineAffordance.tsx` (also Pressable-rooted).
type PressEventWithStopImmediatePropagation = GestureResponderEvent & {
    nativeEvent?: GestureResponderEvent['nativeEvent'] & {
        stopImmediatePropagation?: () => void;
    };
};

// `react-native`'s typings only model `{ pressed: boolean }` for the
// Pressable style callback, but RN-Web also passes `hovered` at runtime.
// A narrow structural type covers both targets without `any`.
type PathFavoritePressableState = Readonly<{
    pressed: boolean;
    hovered?: boolean;
}>;

type IoniconName = React.ComponentProps<typeof Ionicons>['name'];

const stylesheet = StyleSheet.create(() => ({
    pressable: {
        width: 24,
        height: 24,
        alignItems: 'center',
        justifyContent: 'center',
    },
    pressableActive: {
        opacity: 1,
    },
    pressableInactive: {
        opacity: 0.5,
    },
}));

export type PathFavoriteToggleButtonProps = Readonly<{
    /** Absolute path passed to `onToggle` when pressed. */
    path: string;
    /** Whether the path is currently a favorite. Drives the icon + label. */
    isFavorite: boolean;
    /** Localized "Add to favorites" label (used when `isFavorite === false`). */
    addLabel: string;
    /** Localized "Remove from favorites" label (used when `isFavorite === true`). */
    removeLabel: string;
    onToggle: (path: string) => void;
    testID?: string;
}>;

export function PathFavoriteToggleButton(
    props: PathFavoriteToggleButtonProps,
): React.ReactElement {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const handlePress = React.useCallback((event?: GestureResponderEvent) => {
        // Prevent the row's onSelect from firing when the button is pressed.
        // On native, RN composes touch responders; on web, Pressable forwards
        // a SyntheticEvent we can stop. Both branches are guarded.
        if (event && typeof event.stopPropagation === 'function') {
            event.stopPropagation();
        }
        const nativeEvent = (event as PressEventWithStopImmediatePropagation | undefined)?.nativeEvent;
        if (nativeEvent && typeof nativeEvent.stopImmediatePropagation === 'function') {
            nativeEvent.stopImmediatePropagation();
        }
        props.onToggle(props.path);
    }, [props]);
    const accessibilityLabel = props.isFavorite ? props.removeLabel : props.addLabel;
    const iconName: IoniconName = props.isFavorite ? 'star' : 'star-outline';
    const iconColor = props.isFavorite
        ? theme.colors.state.warning.foreground
        : theme.colors.text.tertiary;
    return (
        <Pressable
            testID={props.testID}
            accessibilityRole="button"
            accessibilityLabel={accessibilityLabel}
            accessibilityState={{ selected: props.isFavorite }}
            // Web a11y — `aria-pressed` is the toggle semantic when a button
            // represents a 2-state on/off control. RN-web maps this through.
            aria-pressed={props.isFavorite}
            onPress={handlePress}
            hitSlop={{ top: 8, right: 8, bottom: 8, left: 8 }}
            style={(state: PathFavoritePressableState) => [
                styles.pressable,
                props.isFavorite ? styles.pressableActive : styles.pressableInactive,
                state.hovered ? styles.pressableActive : null,
                state.pressed ? { opacity: 0.7 } : null,
            ]}
        >
            <Ionicons name={iconName} size={16} color={iconColor} />
        </Pressable>
    );
}
