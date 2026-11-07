import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { GlassPanel } from '@/components/ui/glass/GlassPanel';
import { Icon } from '@/components/ui/icons/Icon';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import { Text } from '@/components/ui/text/Text';
import { motionTokens } from '@/components/ui/motion/motionTokens';

/**
 * The small floating capsule control that sits beside a bottom-anchored overlay surface — the
 * new-session composer's close/dismiss capsules and the native Search overlay's equivalents.
 *
 * It is one owner rather than one per surface because the capsule is the same product object in
 * both places: the same glass material as the card and the tab bar, the same circular size, and the
 * same compact capsule. Under a finger its hit area reaches the platform target past the drawn
 * circle (the shared pressable's hit area), and the row's gap keeps adjacent controls apart.
 */

/** Clamps to a full circle at this size; matches the tab bar and composer capsules. */
const CAPSULE_RADIUS = 999;
export const OVERLAY_CAPSULE_BUTTON_SIZE = 36;
const CAPSULE_ICON_SIZE = 16;
/** The status-row dot's size (`SessionInstrumentStrip`), so a folded composer's mark reads as the same mark. */
const CAPSULE_DOT_SIZE = 6;

/** Separates the capsule row from the surface it floats above without letting their hit areas meet. */
export const OVERLAY_CAPSULE_BUTTON_GAP = 10;

/** Total vertical space a capsule row takes above the surface it floats over. */
export const OVERLAY_CAPSULE_ROW_HEIGHT = Math.max(OVERLAY_CAPSULE_BUTTON_SIZE, resolveMinimumInteractiveTargetSize(Platform.OS))
    + OVERLAY_CAPSULE_BUTTON_GAP;

const styles = StyleSheet.create({
    capsule: {
        width: OVERLAY_CAPSULE_BUTTON_SIZE,
        height: OVERLAY_CAPSULE_BUTTON_SIZE,
    },
    press: {
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: CAPSULE_RADIUS,
    },
    visual: {
        width: OVERLAY_CAPSULE_BUTTON_SIZE,
        height: OVERLAY_CAPSULE_BUTTON_SIZE,
        alignItems: 'center',
        justifyContent: 'center',
    },
    pressed: {
        opacity: motionTokens.press.opacitySubtle,
    },
    // A labelled capsule (a folded surface's pill) keeps the round capsule's height and ends.
    labelled: {
        height: OVERLAY_CAPSULE_BUTTON_SIZE,
        flexDirection: 'row',
        alignItems: 'center',
    },
    dot: {
        width: CAPSULE_DOT_SIZE,
        height: CAPSULE_DOT_SIZE,
        borderRadius: CAPSULE_DOT_SIZE / 2,
    },
});

export const OverlayCapsuleButton = React.memo(function OverlayCapsuleButton(
    props: Readonly<{
        accessibilityLabel: string;
        icon: React.ComponentProps<typeof Icon>['name'];
        onPress: () => void;
        testID: string;
        /**
         * A capsule that stands in for a folded surface (Docked New's pill) names it; the icon then trails the
         * label. `dot` marks unsent content in it.
         */
        label?: string;
        dot?: boolean;
        accessibilityValue?: React.ComponentProps<typeof Pressable>['accessibilityValue'];
    }>,
): React.ReactElement {
    const { theme } = useUnistyles();
    const minimumInteractiveTargetSize = Math.max(OVERLAY_CAPSULE_BUTTON_SIZE, resolveMinimumInteractiveTargetSize(Platform.OS));

    return (
        <Pressable
            testID={props.testID}
            accessibilityRole="button"
            accessibilityLabel={props.accessibilityLabel}
            onPress={props.onPress}
            accessibilityValue={props.accessibilityValue}
            style={({ pressed }) => [
                styles.press,
                { width: props.label === undefined ? minimumInteractiveTargetSize : undefined, height: minimumInteractiveTargetSize },
                pressed ? styles.pressed : null,
            ]}
        >
            <View pointerEvents="none">
                <GlassPanel
                    radius={CAPSULE_RADIUS}
                    shadowLevel={2}
                    innerShadow={false}
                    style={props.label === undefined ? styles.capsule : null}
                >
                    {props.label === undefined ? (
                        <View style={styles.visual}>
                            <Icon name={props.icon} size={CAPSULE_ICON_SIZE} color={theme.colors.text.secondary} />
                        </View>
                    ) : (
                        <View style={[styles.labelled, { gap: theme.space.s8, paddingLeft: theme.space.s16, paddingRight: theme.space.s12 }]}>
                            {props.dot ? (
                                <View testID={`${props.testID}-dot`} style={[styles.dot, { backgroundColor: theme.colors.text.primary }]} />
                            ) : null}
                            <Text variant="body" emphasis="medium" numberOfLines={1} style={{ color: theme.colors.text.primary }}>{props.label}</Text>
                            <Icon name={props.icon} size={CAPSULE_ICON_SIZE} color={theme.colors.text.secondary} />
                        </View>
                    )}
                </GlassPanel>
            </View>
        </Pressable>
    );
});
