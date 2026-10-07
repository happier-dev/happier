import { HAPPIER_FOCUS_RING_DELEGATED_STYLE, HappierPressable } from '@happier-dev/plugin-ui/presentation';
import * as React from 'react';
import { View } from 'react-native';
import Animated from 'react-native-reanimated';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import { usePressFeedback } from '@/components/ui/interactions/usePressFeedback';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { isValidThemeProfileColorValue } from '@/theme/profiles/themeProfileColorValidation';
import { WelcomeActionAdmissionContext } from './WelcomeActionList';

export const WelcomeActionCard = React.memo(function WelcomeActionCard(props: Readonly<{
    testID: string;
    actionId?: string;
    title: string;
    subtitle?: string;
    primary?: boolean;
    /** A centred welcome CTA with its glyph before the label, rather than an action card. */
    presentation?: 'card' | 'button';
    iconName?: IconName;
    /**
     * A provider's own connect colour, exactly as its Home projected it
     * (teams-lane-03/01 §10.2). It sits behind the provider's mark, the way a
     * provider's connect button carries it, so the colour reads as identity while
     * the card keeps the theme's chrome and text contrast. A value that is not a
     * colour is ignored and the mark renders as usual.
     */
    accentColor?: string | null;
    /**
     * Back/Cancel and other escapes leave the current task instead of competing
     * with it. Admission exists to stop a second *mutation* while one is in
     * flight; locking the way out behind a multi-second KDF or network wait
     * would strand the person inside it. An escape is therefore not an admitted
     * action: it stays operable and runs immediately.
     */
    escape?: boolean;
    /**
     * This card is one option in a selection, not a command. A caller that owns
     * a group of mutually exclusive choices says so here, and the card is then
     * announced with its checked state instead of as one more button that
     * happens to look primary.
     */
    selectionRole?: 'radio';
    /**
     * The action cannot run right now (its service is unreachable, or still being checked). The card
     * keeps saying what it is for — the subtitle carries why it cannot — and stops being a button:
     * `accessory` (Retry, a spinner) is its only control, so no disabled button wraps a live one.
     */
    unavailable?: Readonly<{ accessory?: React.ReactNode }>;
    selected?: boolean;
    controlRef?: React.ComponentProps<typeof HappierPressable>['controlRef'];
    onPress: () => Promise<void> | void;
}>) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const admission = React.useContext(WelcomeActionAdmissionContext);
    const primary = props.primary === true;
    const escape = props.escape === true;
    const actionId = props.actionId ?? props.testID;
    const pending = !escape && admission.pendingActionId === actionId;
    const subtitleId = props.subtitle ? `welcome-action-description-${encodeURIComponent(actionId)}` : undefined;
    const foreground = primary ? theme.colors.button.primary.tint : theme.colors.text.primary;
    const subtitleColor = primary ? theme.colors.button.primary.tint : theme.colors.text.secondary;
    const pressFeedback = usePressFeedback();
    const accentColor = props.accentColor?.trim();
    const accent = accentColor && accentColor !== 'transparent' && isValidThemeProfileColorValue(accentColor)
        ? accentColor
        : null;
    const button = props.presentation === 'button';

    if (props.unavailable) {
        return (
            <View
                testID={props.testID}
                style={[styles.card, { backgroundColor: theme.colors.surface.base, borderColor: theme.colors.border.default }]}
            >
                <View testID={`${props.testID}-text`} style={[styles.textBlock, styles.unavailableText]}>
                    <Text testID={`${props.testID}-title`} style={[styles.title, { color: theme.colors.text.primary }]}>{props.title}</Text>
                    {props.subtitle ? <Text testID={`${props.testID}-subtitle`} style={[styles.subtitle, { color: theme.colors.text.secondary }]}>{props.subtitle}</Text> : null}
                </View>
                {props.unavailable.accessory ?? null}
            </View>
        );
    }

    return (
        <HappierPressable
            testID={props.testID}
            controlRef={props.controlRef}
            accessibilityRole={props.selectionRole ?? 'button'}
            {...(props.selectionRole
                ? { checked: props.selected === true, selected: props.selected === true }
                : {})}
            accessibilityLabel={props.title}
            accessibilityHint={props.subtitle}
            describedById={subtitleId}
            disabled={!escape && admission.pendingActionId !== null}
            busy={pending}
            onPress={escape ? () => props.onPress() : () => admission.run(actionId, props.onPress)}
            onPressIn={pressFeedback.onPressIn}
            onPressOut={pressFeedback.onPressOut}
            // The ring belongs to the card frame inside the hit area.
            style={HAPPIER_FOCUS_RING_DELEGATED_STYLE}
        >
            {({ hovered, focused }) => (
                // The pressable is the hit area; the card chrome is the animated frame,
                // so the tactile press moves the whole card.
                <Animated.View
                    style={[
                        styles.card,
                        button ? styles.button : null,
                        primary
                            ? { backgroundColor: theme.colors.button.primary.background, borderColor: theme.colors.button.primary.background }
                            : button
                                ? { backgroundColor: hovered ? theme.colors.surface.pressed : theme.colors.surface.elevated, borderColor: 'transparent' }
                                : { backgroundColor: hovered ? theme.colors.surface.elevated : theme.colors.surface.base, borderColor: theme.colors.border.default },
                        focusRingStyle({ focused, color: theme.colors.border.focus }),
                        pressFeedback.animatedStyle,
                    ]}
                >
                    {button && pending ? <ActivitySpinner color={foreground} /> : button && props.iconName ? (
                        <Icon testID={`${props.testID}-icon`} name={props.iconName} size={20} color={foreground} />
                    ) : null}
                    <View testID={`${props.testID}-text`} style={button ? styles.buttonText : styles.textBlock}>
                        <Text testID={`${props.testID}-title`} style={[styles.title, { color: foreground }]}>{props.title}</Text>
                        {props.subtitle ? <Text nativeID={subtitleId} testID={`${props.testID}-subtitle`} style={[styles.subtitle, { color: subtitleColor }]}>{props.subtitle}</Text> : null}
                    </View>
                    {!button && pending ? <ActivitySpinner color={foreground} /> : !button && props.iconName ? (
                        <View
                            testID={accent ? `${props.testID}-accent` : undefined}
                            accessibilityElementsHidden
                            importantForAccessibility="no-hide-descendants"
                            style={accent ? [styles.accentMark, { backgroundColor: accent }] : undefined}
                        >
                            <Icon
                                testID={`${props.testID}-icon`}
                                name={props.iconName}
                                size={20}
                                color={accent ? theme.colors.button.primary.tint : foreground}
                            />
                        </View>
                    ) : null}
                </Animated.View>
            )}
        </HappierPressable>
    );
});

const stylesheet = StyleSheet.create((theme) => ({
    card: {
        minHeight: 66,
        borderWidth: 1,
        borderRadius: 14,
        paddingHorizontal: 18,
        paddingVertical: 10,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 16,
    },
    textBlock: { flex: 1, gap: 0 },
    button: { minHeight: 50, justifyContent: 'center', gap: 8 },
    buttonText: { gap: 0, alignItems: 'center', flexShrink: 1 },
    // The same frame, quieter: its words still read while its action waits.
    unavailableText: { opacity: 0.6 },
    accentMark: {
        width: 32,
        height: 32,
        borderRadius: 8,
        alignItems: 'center',
        justifyContent: 'center',
    },
    title: { ...Typography.default('semiBold'), fontSize: 16, lineHeight: 22 },
    subtitle: { ...Typography.default(), fontSize: 13, lineHeight: 18 },
}));
