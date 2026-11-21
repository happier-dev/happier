import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';
import type { MachineGuardActivityRowV1, MachineGuardActivityWayBackV1 } from '@happier-dev/protocol/machines/guard/activityV1';

import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { useDeviceType } from '@/utils/platform/responsive';

import { formatGuardClock } from '../guardPresentation';
import { describeGuardActivityRow, guardWayBackLabel } from './guardActivityPresentation';

/**
 * One Activity receipt (lab `RS.evt`; the single owner, reused by the Guard tab, the Activity page and
 * plan 60's widget): the time, a glyph, what happened, the bold figure and why, and the way back. A
 * decision still open reads amber, a failure rose; an undone receipt is struck through and has no
 * way back left.
 */
export const MachineActivityRow = React.memo(function MachineActivityRow(props: Readonly<{
    entry: MachineGuardActivityRowV1;
    machineName: string;
    pendingId?: string | null;
    onWayBack?: (entry: MachineGuardActivityRowV1, item: MachineGuardActivityWayBackV1) => void;
    /** Read-only (offline, or not the person's to change): the ways back are not offered. */
    readOnly?: boolean;
    showDivider?: boolean;
    /** Which machine it happened on, for a list across machines (plan 60's Activity widget). */
    place?: string;
    /** Opens what the receipt is about (the widget opens the machine's Activity). */
    onPress?: () => void;
}>) {
    const { theme } = useUnistyles();
    // A phone has no room for a clock column: the time closes the receipt's text (lab `rg` G7p), and the glyph takes
    // the rows' mark column, so a way back moved under the words starts where they do.
    const phone = useDeviceType() === 'phone';
    const model = describeGuardActivityRow(props.entry, props.machineName);
    const tint = model.tone === 'danger' ? theme.colors.state.danger.textForeground
        : model.tone === 'attention' ? theme.colors.state.attention.textForeground : theme.colors.text.secondary;
    const { onWayBack, entry } = props;
    const actions = props.readOnly || !onWayBack ? [] : model.wayBack;
    // A failed start says why in plain words and what to try; the daemon's diagnostic stays out of sight.
    const failure = model.undone ? null : model.startFailure;
    // The cause is one sentence and the next step its own line, so a phone never splits them mid-line.
    const failureText = failure ? [t(failure.reasonKey), failure.nextStepKey ? t(failure.nextStepKey) : null]
        .filter((part): part is string => part !== null).join('\n') : null;
    const reasonParts = [model.reason, failureText].filter((part): part is string => part !== null);
    const reason = reasonParts.length > 0 ? reasonParts.join('  ·  ') : null;
    const glyph = <Icon name={model.icon} size={15} color={tint} />;
    const time = formatGuardClock(model.at);
    const facts = [model.figure ? '' : null, reason, props.place].filter((part): part is string => part !== null && part !== undefined).join('  ·  ');
    return (
        <Item
            testID={`machine-activity-${model.id}`}
            mode={props.onPress ? 'interactive' : 'info'}
            onPress={props.onPress}
            showDivider={props.showDivider}
            accessoryLayout="adaptive"
            {...(phone ? { icon: glyph } : {
                leftElement: (
                    <View style={styles.lead}>
                        <Text style={styles.time} numberOfLines={1}>{time}</Text>
                        {glyph}
                    </View>
                ),
            })}
            title={model.title}
            titleStyle={model.undone ? styles.struck : undefined}
            subtitle={model.figure || reason || props.place || phone ? (
                <Text style={styles.subtitle}>
                    {model.figure ? <Text style={styles.figure}>{model.figure}</Text> : null}
                    {facts}
                    {phone ? <Text style={styles.time}>{model.figure || facts ? `\n${time}` : time}</Text> : null}
                </Text>
            ) : undefined}
            rightElementOutsidePressable={actions.length > 0}
            rightElement={actions.length > 0 ? (
                <View style={styles.actions}>
                    {actions.map(item => (
                        <TextLinkButton key={item.label} testID={`machine-activity-${model.id}-${item.label}`} tone="strong"
                            label={guardWayBackLabel(item)} disabled={props.pendingId === `${model.id}:${item.label}`}
                            onPress={() => onWayBack!(entry, item)} />
                    ))}
                </View>
            ) : undefined}
        />
    );
});

const styles = StyleSheet.create((theme) => ({
    lead: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s12,
    },
    time: {
        ...Typography.default(),
        ...happierPageTextMetrics('meta'),
        color: theme.colors.text.tertiary,
        fontVariant: ['tabular-nums'],
        // A clock column, never wrapped: a 24-hour time fits the floor, a 12-hour one ("03:48 PM") widens it.
        minWidth: 40,
        flexShrink: 0,
    },
    struck: {
        textDecorationLine: 'line-through',
        color: theme.colors.text.secondary,
    },
    subtitle: {
        ...Typography.default(),
        ...happierPageTextMetrics('rowDescription'),
        color: theme.colors.text.secondary,
    },
    figure: {
        ...Typography.default('semiBold'),
        color: theme.colors.text.primary,
        fontVariant: ['tabular-nums'],
    },
    actions: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s16,
    },
}));
