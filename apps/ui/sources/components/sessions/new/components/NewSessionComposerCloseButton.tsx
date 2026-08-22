import * as React from 'react';
import { Platform, Pressable } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { GlassPanel } from '@/components/ui/glass/GlassPanel';
import { Icon } from '@/components/ui/icons/Icon';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import { t } from '@/text';

/**
 * The close affordance for the floating new-session composer.
 *
 * The sheet this replaces carried a header close button. Dropping the header is what makes the
 * composer read as a bare surface rather than a form — but it also removes the only guaranteed way
 * out, and a backdrop tap is not a sufficient substitute: an overlay whose only dismissal is
 * "tap somewhere that looks like nothing" is both an accessibility gap and a well-known cause of
 * accidental dismissals.
 *
 * Rendered as its own small capsule above the composer card, in the same glass material as the
 * card and the tab bar (`GlassPanel` + `Pressable`, the same pairing `JumpToBottomButton` uses), so
 * it reads as part of the same floating layer rather than a control stuck onto the composer.
 */

/** Clamps to a full circle at this size; matches the tab bar and composer capsules. */
const CAPSULE_RADIUS = 999;
const CLOSE_BUTTON_SIZE = 36;
const CLOSE_ICON_SIZE = 16;

/** Separates the capsule row from the composer card without letting their hit areas meet. */
export const NEW_SESSION_CLOSE_BUTTON_GAP = 10;

/**
 * Total vertical space the capsule row takes above the card.
 *
 * Exported because the composer's height budget has to reserve it: the row is drawn outside the card
 * but inside the same bottom-anchored slot, so a budget that ignores it lets a long draft push the
 * row off the top of the screen — taking the only visible dismiss control with it.
 */
export const NEW_SESSION_CLOSE_ROW_HEIGHT = CLOSE_BUTTON_SIZE + NEW_SESSION_CLOSE_BUTTON_GAP;

const styles = StyleSheet.create({
    capsule: {
        width: CLOSE_BUTTON_SIZE,
        height: CLOSE_BUTTON_SIZE,
    },
    press: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: CAPSULE_RADIUS,
    },
    pressed: {
        opacity: 0.92,
    },
});

const ComposerCapsuleButton = React.memo(function ComposerCapsuleButton(
    props: Readonly<{
        accessibilityLabel: string;
        icon: React.ComponentProps<typeof Icon>['name'];
        onPress: () => void;
        testID: string;
    }>,
): React.ReactElement {
    const { theme } = useUnistyles();
    // Brings the drawn capsule up to the platform's minimum target without reaching the composer
    // card below it: the row that hosts this reserves a larger gap than the slop this produces, so
    // the two targets never overlap. Native-only surface, so `hitSlop` is honoured here.
    const hitSlop = Math.max(0, Math.round(
        (resolveMinimumInteractiveTargetSize(Platform.OS) - CLOSE_BUTTON_SIZE) / 2,
    ));

    return (
        <GlassPanel radius={CAPSULE_RADIUS} shadowLevel={2} innerShadow={false} style={styles.capsule}>
            <Pressable
                testID={props.testID}
                accessibilityRole="button"
                accessibilityLabel={props.accessibilityLabel}
                onPress={props.onPress}
                hitSlop={hitSlop}
                style={({ pressed }) => [styles.press, pressed ? styles.pressed : null]}
            >
                <Icon name={props.icon} size={CLOSE_ICON_SIZE} color={theme.colors.text.secondary} />
            </Pressable>
        </GlassPanel>
    );
});

export const NewSessionComposerCloseButton = React.memo(function NewSessionComposerCloseButton(
    props: Readonly<{ onPress: () => void }>,
): React.ReactElement {
    return (
        <ComposerCapsuleButton
            testID="new-session-composer-close"
            accessibilityLabel={t('common.cancel')}
            icon="x"
            onPress={props.onPress}
        />
    );
});

/**
 * Retracts the keyboard without leaving the composer.
 *
 * In this presentation a backdrop tap dismisses the whole screen, so — unlike the sheet it replaces,
 * where tapping the empty sheet area only lowered the keyboard — no gesture retracts the keyboard
 * alone. This capsule restores that, and exists only while the keyboard is up so it never sits there
 * as dead chrome.
 */
export const NewSessionComposerKeyboardDismissButton = React.memo(
    function NewSessionComposerKeyboardDismissButton(
        props: Readonly<{ onPress: () => void }>,
    ): React.ReactElement {
        return (
            <ComposerCapsuleButton
                testID="new-session-composer-dismiss-keyboard"
                accessibilityLabel={t('common.dismissKeyboard')}
                icon="caret-down"
                onPress={props.onPress}
            />
        );
    },
);
