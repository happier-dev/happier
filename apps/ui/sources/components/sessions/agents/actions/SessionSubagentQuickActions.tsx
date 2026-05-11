import * as React from 'react';
import { Pressable, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { Modal } from '@/modal';
import { sync } from '@/sync/sync';
import { sessionExecutionRunStop } from '@/sync/ops/sessionExecutionRuns';
import { resolveSubagentStructuredSend } from '@/sync/domains/input/subagents/resolveSubagentStructuredSend';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { t } from '@/text';
import type { SessionSubagent } from '@/sync/domains/session/subagents/types';

export const SessionSubagentQuickActions = React.memo((props: Readonly<{
    sessionId: string;
    subagent: SessionSubagent;
    onOpenFull: (() => void) | null;
    onSend: (() => void) | null;
    testID?: string;
    style: {
        actions: object;
        iconButton: object;
    };
}>) => {
    const { theme } = useUnistyles();
    const [pendingAction, setPendingAction] = React.useState<'stop' | 'delete' | null>(null);
    const stopPropagation = React.useCallback((event?: unknown) => {
        const maybeEvent = event as {
            stopPropagation?: () => void;
            nativeEvent?: { stopPropagation?: () => void };
        } | undefined;
        try { maybeEvent?.stopPropagation?.(); } catch {}
        try { maybeEvent?.nativeEvent?.stopPropagation?.(); } catch {}
    }, []);

    const stopRun = React.useCallback(() => {
        const runId = props.subagent.runRef?.runId?.trim();
        if (!runId) return;
        setPendingAction('stop');
        fireAndForget((async () => {
            try {
                const result = await sessionExecutionRunStop(props.sessionId, { runId });
                if ((result as any)?.ok === false) {
                    Modal.alert(t('common.error'), String((result as any)?.error ?? t('runs.stop.failedToStopRun')));
                }
            } catch (error) {
                Modal.alert(t('common.error'), error instanceof Error ? error.message : t('runs.stop.failedToStopRun'));
            } finally {
                setPendingAction(null);
            }
        })(), { tag: 'SessionSubagentQuickActions.stopRun' });
    }, [props.sessionId, props.subagent.runRef?.runId]);

    const deleteTeammate = React.useCallback(() => {
        const recipient = props.subagent.recipient;
        if (recipient?.kind !== 'agent_team_member') return;
        setPendingAction('delete');
        fireAndForget((async () => {
            try {
                const structured = resolveSubagentStructuredSend({
                    envelopeKind: 'subagent_command.v1',
                    payload: {
                        kind: 'agent_team_member_delete',
                        teamId: recipient.teamId,
                        memberId: recipient.memberId,
                        ...(recipient.memberLabel ? { memberLabel: recipient.memberLabel } : {}),
                    },
                });
                await sync.sendMessage(props.sessionId, structured.text, structured.displayText, structured.metaOverrides);
            } catch (error) {
                Modal.alert(t('common.error'), error instanceof Error ? error.message : t('common.requestFailed'));
            } finally {
                setPendingAction(null);
            }
        })(), { tag: 'SessionSubagentQuickActions.deleteTeammate' });
    }, [props.sessionId, props.subagent.recipient]);

    return (
        <View testID={props.testID} style={props.style.actions}>
            {props.onSend ? (
                <Pressable
                    testID={`session-subagent-send:${props.subagent.id}`}
                    accessibilityRole="button"
                    accessibilityLabel={t('session.subagents.panel.send')}
                    onPress={(event) => {
                        stopPropagation(event);
                        props.onSend?.();
                    }}
                    style={({ pressed }) => [props.style.iconButton, { opacity: pressed ? 0.7 : 1 }]}
                >
                    <Ionicons name="paper-plane-outline" size={16} color={theme.colors.text.secondary} />
                </Pressable>
            ) : null}

            {props.subagent.capabilities.canStop && props.subagent.runRef?.runId ? (
                <Pressable
                    testID={`session-subagent-stop:${props.subagent.id}`}
                    accessibilityRole="button"
                    accessibilityLabel={t('runs.stop.stopRunA11y')}
                    onPress={(event) => {
                        stopPropagation(event);
                        stopRun();
                    }}
                    disabled={pendingAction !== null}
                    style={({ pressed }) => [props.style.iconButton, { opacity: pendingAction !== null ? 0.6 : pressed ? 0.7 : 1 }]}
                >
                    <Ionicons name="stop-circle-outline" size={16} color={theme.colors.text.secondary} />
                </Pressable>
            ) : null}

            {props.subagent.capabilities.canDelete && props.subagent.recipient?.kind === 'agent_team_member' ? (
                <Pressable
                    testID={`session-subagent-delete:${props.subagent.id}`}
                    accessibilityRole="button"
                    accessibilityLabel={t('session.subagents.panel.delete')}
                    onPress={(event) => {
                        stopPropagation(event);
                        deleteTeammate();
                    }}
                    disabled={pendingAction !== null}
                    style={({ pressed }) => [props.style.iconButton, { opacity: pendingAction !== null ? 0.6 : pressed ? 0.7 : 1 }]}
                >
                    <Ionicons name="trash-outline" size={16} color={theme.colors.text.secondary} />
                </Pressable>
            ) : null}

            {props.onOpenFull ? (
                <Pressable
                    testID={`session-subagent-open-full:${props.subagent.id}`}
                    accessibilityRole="button"
                    accessibilityLabel={t('session.subagents.panel.openFull')}
                    onPress={(event) => {
                        stopPropagation(event);
                        props.onOpenFull?.();
                    }}
                    style={({ pressed }) => [props.style.iconButton, { opacity: pressed ? 0.7 : 1 }]}
                >
                    <Ionicons name="open-outline" size={16} color={theme.colors.text.secondary} />
                </Pressable>
            ) : null}
        </View>
    );
});
