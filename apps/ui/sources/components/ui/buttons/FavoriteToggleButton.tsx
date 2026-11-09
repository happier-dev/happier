/**
 * FavoriteToggleButton — small, standalone star toggle for paths and prompts.
 *
 * Behavior:
 *   - One `star` glyph, filled (`weight="fill"`, theme
 *     `state.warning.foreground`) when the item is currently a favorite and
 *     outline (`weight="regular"`, theme `text.tertiary`) when it is not.
 *     Weight is the load-bearing channel: colour repeats the state rather than
 *     carrying it, because `DESIGN.md` forbids signalling by colour alone.
 *   - Pressing the icon invokes `onToggle(id)` and STOPS propagation so the
 *     enclosing row's `onSelect` does NOT fire.
 *   - 20×20 visual hit; effective hit area extended via `hitSlop` per the
 *     `make-interfaces-feel-better` minimum hit-area rule.
 *   - The `accessibilityLabel` reflects the current state ("Add to favorites"
 *     vs "Remove from favorites") so screen readers announce the action that
 *     pressing the button will perform.
 */

import * as React from 'react';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Icon, type IconWeight } from '@/components/ui/icons/Icon';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { HappierPressable, type HappierPressableProps } from '@happier-dev/plugin-ui/presentation';
import { stopPressEventPropagation } from '@/utils/ui/stopPressEventPropagation';

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

export type FavoriteToggleButtonProps = Readonly<{
    /** Item identity passed to `onToggle` when pressed. */
    id: string;
    /** Whether the item is currently a favorite. Drives the icon + label. */
    isFavorite: boolean;
    /** Localized "Add to favorites" label (used when `isFavorite === false`). */
    addLabel: string;
    /** Localized "Remove from favorites" label (used when `isFavorite === true`). */
    removeLabel: string;
    onToggle: (id: string) => void;
    testID?: string;
}>;

export function FavoriteToggleButton(
    props: FavoriteToggleButtonProps,
): React.ReactElement {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const handlePress = React.useCallback<HappierPressableProps['onPress']>((event) => {
        stopPressEventPropagation(event);
        props.onToggle(props.id);
    }, [props]);
    const accessibilityLabel = props.isFavorite ? props.removeLabel : props.addLabel;
    const iconWeight: IconWeight = props.isFavorite ? 'fill' : 'regular';
    const iconColor = props.isFavorite
        ? theme.colors.state.warning.foreground
        : theme.colors.text.tertiary;
    return (
        <HappierPressable
            testID={props.testID}
            accessibilityRole="button"
            accessibilityLabel={accessibilityLabel}
            // A button holding a 2-state on/off value: the shared pressable projects `selected` as `aria-pressed`.
            selected={props.isFavorite}
            // Inside a selectable row, whose own press is the row: the star keeps its drawn box.
            hitReach={0}
            onPress={handlePress}
            style={(state) => [
                styles.pressable,
                props.isFavorite ? styles.pressableActive : styles.pressableInactive,
                state.hovered ? styles.pressableActive : null,
                state.pressed ? { opacity: motionTokens.press.opacity } : null,
            ]}
        >
            <Icon name="star" size={16} weight={iconWeight} color={iconColor} />
        </HappierPressable>
    );
}
