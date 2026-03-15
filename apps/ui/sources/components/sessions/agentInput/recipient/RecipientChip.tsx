import * as React from 'react';
import { Pressable, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import type { ParticipantRecipientV1 } from '@happier-dev/protocol';

import { Popover } from '@/components/ui/popover';
import { AgentInputPopoverSurface } from '@/components/sessions/agentInput/components/AgentInputPopoverSurface';
import type { AgentInputExtraActionChipRenderContext } from '@/components/sessions/agentInput/AgentInput';
import type { SessionParticipantTarget } from '@/sync/domains/session/participants/participantTargets';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { useUnistyles } from 'react-native-unistyles';
import { resolveRecipientAccentColor } from './resolveRecipientAccentColor';

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
    const anchorRef = React.useRef<View | null>(null);
    const popoverAnchorRef = props.ctx.popoverAnchorRef ?? anchorRef;
    const { theme } = useUnistyles();

    const selectedLabel = resolveRecipientLabel(props.targets, props.recipient);

    return (
        <>
            <View ref={anchorRef as any} collapsable={false} style={{ alignSelf: 'flex-start' }}>
                <Pressable
                    onPress={() => setOpen((v) => !v)}
                    style={({ pressed }) => props.ctx.chipStyle(Boolean(pressed))}
                    accessibilityRole="button"
                    accessibilityLabel={t('session.participants.sendToTitle')}
                >
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
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
                anchorRef={popoverAnchorRef as any}
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
                        <View style={{ paddingHorizontal: 12, paddingVertical: 10, gap: 8 }}>
                            <Text style={{ fontSize: 12, fontWeight: '600', color: theme.colors.textSecondary }}>
                                {t('session.participants.sendToTitle')}
                            </Text>

                            <Pressable
                                onPress={() => {
                                    props.onRecipientChange(null);
                                    setOpen(false);
                                }}
                                style={({ pressed }) => ({
                                    paddingVertical: 8,
                                    opacity: pressed ? 0.7 : 1,
                                })}
                            >
                                <Text style={{ fontSize: 13, color: theme.colors.text }}>{t('session.participants.lead')}</Text>
                            </Pressable>

                            {props.targets.map((target) => (
                                <Pressable
                                    key={target.key}
                                    onPress={() => {
                                        props.onRecipientChange(target.recipient);
                                        setOpen(false);
                                    }}
                                    style={({ pressed }) => ({
                                        paddingVertical: 8,
                                        opacity: pressed ? 0.7 : 1,
                                    })}
                                >
                                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                                        {typeof target.accentName === 'string' && target.accentName.trim().length > 0 ? (
                                            <View
                                                style={{
                                                    width: 8,
                                                    height: 8,
                                                    borderRadius: 999,
                                                    backgroundColor:
                                                        resolveRecipientAccentColor({ theme: theme as any, accentName: target.accentName }) ??
                                                        theme.colors.textSecondary,
                                                }}
                                            />
                                        ) : null}
                                        <Text style={{ fontSize: 13, color: theme.colors.text }}>{resolveTargetLabel(target)}</Text>
                                    </View>
                                </Pressable>
                            ))}
                        </View>
                    </AgentInputPopoverSurface>
                )}
            </Popover>
        </>
    );
});
