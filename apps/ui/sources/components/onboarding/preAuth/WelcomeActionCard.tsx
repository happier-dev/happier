import { HAPPIER_FOCUS_RING_DELEGATED_STYLE, HAPPIER_PAGE_METRICS, HappierPressable } from '@happier-dev/plugin-ui/presentation';
import * as React from 'react';
import { Platform, View } from 'react-native';
import Animated from 'react-native-reanimated';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { StepRowWayButton } from '@/components/onboarding/unauthShell/stepBack';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import { usePressFeedback } from '@/components/ui/interactions/usePressFeedback';
import { MiddleEllipsisText } from '@/components/ui/text/MiddleEllipsisText';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { isValidThemeProfileColorValue } from '@/theme/profiles/themeProfileColorValidation';
import { WelcomeActionAdmissionContext } from './WelcomeActionList';

const CARD_INSET = 18;
const CARD_BORDER = 1;
/** Where a card's title starts, so a heading over a group of cards and quiet rows shares their edge. */
export const WELCOME_ACTION_TEXT_INSET = CARD_INSET + CARD_BORDER;

export const WelcomeActionCard = React.memo(function WelcomeActionCard(props: Readonly<{
    testID: string;
    actionId?: string;
    title: string;
    subtitle?: string;
    primary?: boolean;
    /**
     * `button`: a centred welcome CTA with its glyph before the label, rather than an action card.
     * `row`: a quiet way in beneath the cards, on their text edge; its subtitle is the accessible hint.
     * `link`: a quiet text action. With a subtitle it is the way out under a primary card, read as one centred line:
     * the title, then its note after a dot.
     * `pill`: the second door under the primary (direction A): its glyph and title on one rounded line, sized by its
     * words; the subtitle is the accessible hint.
     */
    presentation?: 'card' | 'button' | 'link' | 'row' | 'pill';
    iconName?: IconName;
    /** A pill that opens a choice ends with its chevron (the corner "Run your own Home" / a Home's address). */
    trailingIconName?: IconName;
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
     * The action cannot run right now (its service is unreachable, or still being checked). The card
     * keeps saying what it is for — the subtitle carries why it cannot — and stops being a button:
     * `accessory` (Retry, a spinner) is its only control, so no disabled button wraps a live one.
     */
    unavailable?: Readonly<{ accessory?: React.ReactNode }>;
    disabled?: boolean;
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
    const row = props.presentation === 'row';
    const web = Platform.OS === 'web';
    const descriptionId = React.useId();
    const subtitleId = web && props.subtitle && !row && props.presentation !== 'pill' ? descriptionId : undefined;
    const foreground = primary ? theme.colors.button.primary.tint : props.presentation === 'link' ? theme.colors.text.secondary : theme.colors.text.primary;
    const subtitleColor = primary ? theme.colors.button.primary.tint : theme.colors.text.secondary;
    const pressFeedback = usePressFeedback();
    const accentColor = props.accentColor?.trim();
    // A projected connect colour belongs to a door; a quiet way keeps the plain glyph every quiet way uses.
    const accent = !row && accentColor && accentColor !== 'transparent' && isValidThemeProfileColorValue(accentColor)
        ? accentColor
        : null;
    const pill = props.presentation === 'pill';
    const button = props.presentation === 'button' || pill;
    const link = props.presentation === 'link';
    const linkLine = link && Boolean(props.subtitle);

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
            nativeID={web ? undefined : props.testID}
            controlRef={props.controlRef}
            accessibilityRole="button"
            accessibilityLabel={props.title}
            accessibilityHint={props.subtitle}
            describedById={subtitleId}
            disabled={props.disabled || (!escape && admission.pendingActionId !== null)}
            busy={pending}
            onPress={escape ? () => props.onPress() : () => admission.run(actionId, props.onPress)}
            onPressIn={pressFeedback.onPressIn}
            onPressOut={pressFeedback.onPressOut}
            // The ring belongs to the card frame inside the hit area; a pill's hit area is its own width.
            style={pill ? [HAPPIER_FOCUS_RING_DELEGATED_STYLE, stylesheet.pillHit] : HAPPIER_FOCUS_RING_DELEGATED_STYLE}
        >
            {({ hovered, focused }) => (
                // The pressable is the hit area; the card chrome is the animated frame,
                // so the tactile press moves the whole card.
                <Animated.View
                    style={[
                        styles.card,
                        button ? styles.button : null,
                        pill ? styles.pill : null,
                        link ? styles.link : null,
                        linkLine ? styles.linkLineFrame : null,
                        row ? styles.row : null,
                        primary
                            ? { backgroundColor: theme.colors.button.primary.background, borderColor: theme.colors.button.primary.background }
                            : link
                                ? { backgroundColor: 'transparent', borderColor: 'transparent' }
                            : row
                                ? { backgroundColor: hovered ? theme.colors.surface.pressed : 'transparent', borderColor: 'transparent' }
                            : pill
                                ? { backgroundColor: hovered ? theme.colors.surface.pressed : theme.colors.surface.base, borderColor: theme.colors.border.default }
                            : button
                                ? { backgroundColor: hovered ? theme.colors.surface.pressed : theme.colors.surface.elevated, borderColor: 'transparent' }
                                : { backgroundColor: hovered ? theme.colors.surface.elevated : theme.colors.surface.base, borderColor: theme.colors.border.default },
                        focusRingStyle({ focused, color: theme.colors.border.focus }),
                        pressFeedback.animatedStyle,
                    ]}
                >
                    {button && pending ? <ActivitySpinner color={foreground} /> : button && props.iconName ? (
                        <Icon testID={`${props.testID}-icon`} name={props.iconName} size={pill ? 16 : 20}
                            color={pill ? theme.colors.text.secondary : foreground} />
                    ) : null}
                    {linkLine ? (
                        <Text testID={`${props.testID}-text`} style={[styles.linkLine, { color: theme.colors.text.secondary }]}>
                            <Text testID={`${props.testID}-title`} style={[styles.linkTitle, { color: theme.colors.text.primary }]}>{props.title}</Text>
                            {props.subtitle ? <Text nativeID={subtitleId} testID={`${props.testID}-subtitle`}>{` · ${props.subtitle}`}</Text> : null}
                        </Text>
                    ) : (
                    <View testID={`${props.testID}-text`} style={button ? styles.buttonText : styles.textBlock}>
                        {pill ? (
                            // A pill is one line: a long title (a Home's address) gives up its middle, never wraps.
                            <MiddleEllipsisText testID={`${props.testID}-title`} value={props.title} style={[styles.pillTitle, { color: foreground }]} />
                        ) : (
                            <Text testID={`${props.testID}-title`} style={[row ? styles.rowTitle : styles.title, { color: foreground }]}>{props.title}</Text>
                        )}
                        {props.subtitle && !row && !pill ? <Text nativeID={subtitleId} testID={`${props.testID}-subtitle`} style={[styles.subtitle, { color: subtitleColor }]}>{props.subtitle}</Text> : null}
                    </View>
                    )}
                    {pill && props.trailingIconName ? (
                        <Icon testID={`${props.testID}-trailing`} name={props.trailingIconName} size={14} color={theme.colors.text.secondary} />
                    ) : null}
                    {!button && pending ? <ActivitySpinner color={foreground} /> : !button && !link && props.iconName ? (
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
                                color={accent ? theme.colors.button.primary.tint : row ? theme.colors.text.secondary : foreground}
                            />
                        </View>
                    ) : null}
                </Animated.View>
            )}
        </HappierPressable>
    );
});

/**
 * One way in on the ways row (direction A, owner 2026-11-19): a round mark without a caption; its title is the
 * tooltip on hover and focus and its accessible name, its subtitle the hint. Admitted like every welcome action.
 */
export const WelcomeWayButton = React.memo(function WelcomeWayButton(props: Readonly<{
    testID: string;
    actionId?: string;
    title: string;
    subtitle?: string;
    iconName?: IconName;
    disabled?: boolean;
    onPress: () => Promise<void> | void;
}>) {
    const admission = React.useContext(WelcomeActionAdmissionContext);
    const actionId = props.actionId ?? props.testID;
    return (
        <StepRowWayButton
            testID={props.testID}
            nativeID={Platform.OS === 'web' ? undefined : props.testID}
            accessibilityLabel={props.title}
            accessibilityHint={props.subtitle}
            tooltip={props.title}
            iconName={props.iconName ?? 'arrow-right'}
            disabled={props.disabled || admission.pendingActionId !== null}
            busy={admission.pendingActionId === actionId}
            onPress={() => admission.run(actionId, props.onPress)}
        />
    );
});

const stylesheet = StyleSheet.create((theme) => ({
    card: {
        minHeight: 66,
        borderWidth: CARD_BORDER,
        borderRadius: 14,
        paddingHorizontal: CARD_INSET,
        paddingVertical: theme.space.s10,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: theme.space.s16,
    },
    textBlock: { flex: 1, gap: 0 },
    // A button stands as the one button of the app (RoundButton `large`): the `md` radius, sized by its words
    // and padding, so a sign-in form's action reads like Restore's (owner review 11-16).
    button: {
        minHeight: 0,
        justifyContent: 'center',
        gap: theme.space.s8,
        borderRadius: theme.borderRadius.md,
        paddingVertical: theme.space.s10,
    },
    // Lab `.ar-cta2`: a 40 px rounded line on the page, its hairline the ink edge.
    pill: {
        alignSelf: 'center',
        minHeight: 40,
        borderRadius: 20,
        paddingVertical: 0,
        paddingHorizontal: theme.space.s16,
    },
    // The welcome's one body size (owner 2026-11-20): a pill's words read at the doors' subtitle size.
    pillTitle: { ...Typography.variant('body') },
    pillHit: { alignSelf: 'center' },
    link: { paddingHorizontal: 0, paddingVertical: theme.space.s8, borderWidth: 0 },
    linkLineFrame: { minHeight: 0, justifyContent: 'center' },
    linkLine: { ...Typography.variant('label'), flexShrink: 1, textAlign: 'center' },
    linkTitle: { ...Typography.variant('label', 'semiBold') },
    buttonText: { gap: 0, alignItems: 'center', flexShrink: 1 },
    row: { minHeight: HAPPIER_PAGE_METRICS.compactRowMinHeightPx, paddingVertical: theme.space.s4 },
    // The same frame, quieter: its words still read while its action waits.
    unavailableText: { opacity: 0.6 },
    accentMark: {
        width: 32,
        height: 32,
        borderRadius: 8,
        alignItems: 'center',
        justifyContent: 'center',
    },
    title: {  ...Typography.variant('heading'),  },
    rowTitle: {  ...Typography.variant('label'),  },
    subtitle: {  ...Typography.variant('body'),  },
}));
