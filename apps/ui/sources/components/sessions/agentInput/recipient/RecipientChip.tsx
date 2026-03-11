import * as React from 'react';
import { Pressable, type StyleProp, View, type ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import type { ParticipantRecipientV1 } from '@happier-dev/protocol';

import { Popover } from '@/components/ui/popover';
import { AgentInputPopoverSurface } from '@/components/sessions/agentInput/components/AgentInputPopoverSurface';
import type { AgentInputExtraActionChipRenderContext } from '@/components/sessions/agentInput/AgentInput';
import type { SessionParticipantTarget } from '@/sync/domains/session/participants/participantTargets';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { StyleSheet } from 'react-native-unistyles';
import { type RecipientAccentKey, resolveRecipientAccentKey } from './resolveRecipientAccentColor';

const stylesheet = StyleSheet.create((theme) => ({
    anchor: {
        alignSelf: 'flex-start',
    },
    chipRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
    popoverContainer: {
        paddingHorizontal: 12,
        paddingVertical: 10,
        gap: 8,
    },
    popoverTitle: {
        fontSize: 12,
        fontWeight: '600',
        color: theme.colors.textSecondary,
    },
    popoverItemPressable: {
        paddingVertical: 8,
    },
    popoverItemRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    popoverItemText: {
        fontSize: 13,
        color: theme.colors.text,
    },
    accentDot: {
        width: 8,
        height: 8,
        borderRadius: 999,
    },
    accentDotFallback: {
        backgroundColor: theme.colors.textSecondary,
    },
    accentDotBlue: {
        backgroundColor: theme.colors.accent.blue,
    },
    accentDotGreen: {
        backgroundColor: theme.colors.accent.green,
    },
    accentDotOrange: {
        backgroundColor: theme.colors.accent.orange,
    },
    accentDotYellow: {
        backgroundColor: theme.colors.accent.yellow,
    },
    accentDotRed: {
        backgroundColor: theme.colors.accent.red,
    },
    accentDotIndigo: {
        backgroundColor: theme.colors.accent.indigo,
    },
    accentDotPurple: {
        backgroundColor: theme.colors.accent.purple,
    },
}));

const accentDotStyleByKey: Readonly<Record<RecipientAccentKey, StyleProp<ViewStyle>>> = {
    blue: stylesheet.accentDotBlue,
    green: stylesheet.accentDotGreen,
    orange: stylesheet.accentDotOrange,
    yellow: stylesheet.accentDotYellow,
    red: stylesheet.accentDotRed,
    indigo: stylesheet.accentDotIndigo,
    purple: stylesheet.accentDotPurple,
};

function recipientsEqual(a: ParticipantRecipientV1, b: ParticipantRecipientV1): boolean {
    if (a.kind !== b.kind) return false;
    if (a.kind === 'execution_run') return a.runId === (b as Extract<ParticipantRecipientV1, { kind: 'execution_run' }>).runId;
    if (a.kind === 'agent_team_broadcast') return a.teamId === (b as Extract<ParticipantRecipientV1, { kind: 'agent_team_broadcast' }>).teamId;
    const bb = b as Extract<ParticipantRecipientV1, { kind: 'agent_team_member' }>;
    return a.teamId === bb.teamId && a.memberId === bb.memberId;
}

function resolveTargetLabel(target: SessionParticipantTarget): string {
    const r = target.recipient;
    if (r.kind === 'execution_run') {
        return target.displayLabel ?? t('session.participants.executionRun', { runId: r.runId });
    }
    if (r.kind === 'agent_team_broadcast') {
        return t('session.participants.broadcast', { teamId: r.teamId });
    }
    return target.displayLabel ?? r.memberId;
}

function resolveRecipientLabel(targets: readonly SessionParticipantTarget[], recipient: ParticipantRecipientV1 | null): string {
    if (!recipient) return t('session.participants.lead');
    const target = targets.find((t2) => recipientsEqual(t2.recipient, recipient)) ?? null;
    if (target) return resolveTargetLabel(target);
    if (recipient.kind === 'execution_run') return t('session.participants.executionRun', { runId: recipient.runId });
    if (recipient.kind === 'agent_team_broadcast') return t('session.participants.broadcast', { teamId: recipient.teamId });
    return recipient.memberId;
}

export type RecipientChipProps = Readonly<{
    targets: readonly SessionParticipantTarget[];
    recipient: ParticipantRecipientV1 | null;
    onRecipientChange: (next: ParticipantRecipientV1 | null) => void;
    ctx: AgentInputExtraActionChipRenderContext;
}>;

export const RecipientChip = React.memo(function RecipientChip(props: RecipientChipProps) {
    if (props.targets.length === 0) return null;
    const [open, setOpen] = React.useState(false);
    const anchorRef = React.useRef<React.ElementRef<typeof View> | null>(null);
    const popoverAnchorRef = props.ctx.popoverAnchorRef ?? anchorRef;
    const styles = stylesheet;

    const selectedLabel = resolveRecipientLabel(props.targets, props.recipient);

    return (
        <>
            <View ref={anchorRef} collapsable={false} style={styles.anchor}>
                <Pressable
                    onPress={() => setOpen((v) => !v)}
                    style={({ pressed }) => props.ctx.chipStyle(Boolean(pressed))}
                    accessibilityRole="button"
                    accessibilityLabel={t('session.participants.sendToTitle')}
                >
                    <View style={styles.chipRow}>
                        <Ionicons name="navigate-outline" size={16} color={props.ctx.iconColor} />
                        {props.ctx.showLabel ? (
                            <Text numberOfLines={1} style={props.ctx.textStyle}>
                                {t('session.participants.cardTo', { label: selectedLabel })}
                            </Text>
                        ) : null}
                    </View>
                </Pressable>
            </View>

            <Popover
                open={open}
                anchorRef={popoverAnchorRef}
                boundaryRef={null}
                placement="top"
                gap={8}
                maxHeightCap={360}
                portal={{
                    web: true,
                    native: true,
                    matchAnchorWidth: false,
                    anchorAlign: 'start',
                }}
                onRequestClose={() => setOpen(false)}
                backdrop={{ style: { backgroundColor: 'transparent' } }}
                containerStyle={{ paddingHorizontal: 0 }}
            >
                {({ maxHeight }) => (
                    <AgentInputPopoverSurface maxHeight={maxHeight} scrollEnabled keyboardShouldPersistTaps="handled">
                        <View style={styles.popoverContainer}>
                            <Text style={styles.popoverTitle}>{t('session.participants.sendToTitle')}</Text>

                            <Pressable
                                onPress={() => {
                                    props.onRecipientChange(null);
                                    setOpen(false);
                                }}
                                style={({ pressed }) => [styles.popoverItemPressable, { opacity: pressed ? 0.7 : 1 }]}
                            >
                                <Text style={styles.popoverItemText}>{t('session.participants.lead')}</Text>
                            </Pressable>

                            {props.targets.map((target) => {
                                const accentKey = typeof target.accentName === 'string' ? resolveRecipientAccentKey(target.accentName) : null;
                                const accentStyle = accentKey ? accentDotStyleByKey[accentKey] : styles.accentDotFallback;

                                return (
                                    <Pressable
                                        key={target.key}
                                        onPress={() => {
                                            props.onRecipientChange(target.recipient);
                                            setOpen(false);
                                        }}
                                        style={({ pressed }) => [styles.popoverItemPressable, { opacity: pressed ? 0.7 : 1 }]}
                                    >
                                        <View style={styles.popoverItemRow}>
                                            {typeof target.accentName === 'string' && target.accentName.trim().length > 0 ? (
                                                <View style={[styles.accentDot, accentStyle]} />
                                            ) : null}
                                            <Text style={styles.popoverItemText}>{resolveTargetLabel(target)}</Text>
                                        </View>
                                    </Pressable>
                                );
                            })}
                        </View>
                    </AgentInputPopoverSurface>
                )}
            </Popover>
        </>
    );
});
