import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { MeterBar } from '@/components/ui/lists/MeterBar';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

import { SetupBlockPaper, type SetupBlockDismiss } from './SetupBlockPaper';

export type SetupBlockAction = Readonly<{ label: string; testID: string; onPress: () => void }>;

/**
 * The standard set-up block body on its paper: a glyph (an icon, or a mark such as a service's brand),
 * the title, one sentence, and its button — at the foot of a desktop `card`, at the end of a phone
 * `row`. Only the buttons and the ✕ act, so no control is nested in another. A block whose body is
 * different (several actions, a footer line) puts its own body on `SetupBlockPaper` instead.
 */
export const SetupBlockTile = React.memo(function SetupBlockTile(props: Readonly<{
    testID: string;
    layout: 'card' | 'row';
    icon?: IconName;
    /** A mark in place of the icon (brand marks, a monogram). */
    glyph?: React.ReactNode;
    title: string;
    subtitle: string;
    action: SetupBlockAction;
    /** Another way to finish the same step, beside the main button ("Paste link"). */
    alternative?: SetupBlockAction;
    disabled?: boolean;
    dismiss?: SetupBlockDismiss;
    /** A step already under way: how much of it is done (0–1), drawn as a meter under the title. */
    progress?: Readonly<{ fraction: number; accessibilityLabel: string }>;
}>) {
    const { theme } = useUnistyles();
    const card = props.layout === 'card';
    const buttons = (
        <View style={styles.buttons}>
            <RoundButton
                testID={props.action.testID}
                size="small"
                display="secondary"
                title={props.action.label}
                disabled={props.disabled}
                onPress={props.action.onPress}
            />
            {props.alternative ? (
                <RoundButton
                    testID={props.alternative.testID}
                    size="small"
                    display="secondary"
                    title={props.alternative.label}
                    disabled={props.disabled}
                    onPress={props.alternative.onPress}
                />
            ) : null}
        </View>
    );
    return (
        <SetupBlockPaper testID={props.testID} layout={props.layout} dismiss={props.dismiss}>
            <View style={card ? styles.glyphCard : styles.glyphRow}>
                {props.glyph ?? (props.icon ? <Icon name={props.icon} size={20} color={theme.colors.text.secondary} /> : null)}
            </View>
            <View style={card ? styles.textCard : styles.textRow}>
                <Text style={[styles.title, card ? styles.titleCard : null]}>{props.title}</Text>
                {props.progress ? (
                    <MeterBar
                        style={styles.progress}
                        tone="neutral"
                        fillFraction={props.progress.fraction}
                        progressAccessibilityLabel={props.progress.accessibilityLabel}
                    />
                ) : null}
                <Text style={[styles.subtitle, card ? styles.subtitleCard : null]}>{props.subtitle}</Text>
            </View>
            {card ? <View style={styles.footer}>{buttons}</View> : buttons}
        </SetupBlockPaper>
    );
});

const styles = StyleSheet.create((theme) => ({
    glyphCard: {
        height: 22,
        flexDirection: 'row',
        alignItems: 'center',
    },
    glyphRow: {
        minWidth: 22,
        alignItems: 'center',
    },
    textCard: {
        // The title clears the ✕ in the corner.
        paddingRight: 22,
    },
    textRow: {
        flex: 1,
        minWidth: 0,
    },
    title: {
        ...Typography.default('semiBold'),
        ...happierPageTextMetrics('rowTitle'),
        color: theme.colors.text.primary,
    },
    titleCard: {
        letterSpacing: 0,
    },
    subtitle: {
        ...Typography.default(),
        ...happierPageTextMetrics('rowDescription'),
        marginTop: 2,
        color: theme.colors.text.secondary,
    },
    subtitleCard: {
        // Two lines reserved, so blocks with a one-line sentence keep their buttons level.
        minHeight: 36,
    },
    progress: {
        marginTop: 6,
        marginBottom: 4,
    },
    footer: {
        marginTop: 'auto',
    },
    buttons: {
        flexDirection: 'row',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: 6,
    },
}));
