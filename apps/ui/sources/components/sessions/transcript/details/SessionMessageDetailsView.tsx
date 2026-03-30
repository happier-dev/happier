import { isSubAgentTranscriptToolName, type ParticipantRecipientV1 } from '@happier-dev/protocol';
import * as React from 'react';
import { View } from 'react-native';
import type { TextStyle, ViewStyle } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { useSessionAgentInputRoutingControls } from '@/components/sessions/agentInput/routing/useSessionAgentInputRoutingControls';
import { SessionParticipantComposer } from '@/components/sessions/participants/composer/SessionParticipantComposer';
import { Deferred } from '@/components/ui/forms/Deferred';
import { Text } from '@/components/ui/text/Text';
import { useDirectSessionRuntime } from '@/components/sessions/model/useDirectSessionRuntime';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useSessionRunningExecutionRuns } from '@/hooks/session/useSessionRunningExecutionRuns';
import type { Message } from '@/sync/domains/messages/messageTypes';
import {
    deriveAutoRecipientFromFocusedToolTranscript,
    deriveSessionParticipantTargets,
} from '@/sync/domains/session/participants/deriveSessionParticipantTargets';
import { resolveSessionSubagentVisibleMessages } from '@/sync/domains/session/subagents/visibleMessages/resolveSessionSubagentVisibleMessages';
import { deriveExecutionRunPollingRefreshKey } from '@/sync/domains/session/participants/deriveExecutionRunPollingRefreshKey';
import type { SessionParticipantTarget } from '@/sync/domains/session/participants/participantTargets';
import { shouldEnableExecutionRunPolling } from '@/sync/domains/session/participants/shouldEnableExecutionRunPolling';
import type { Session } from '@/sync/domains/state/storageTypes';
import { useSessionMessages } from '@/sync/store/hooks';
import { t } from '@/text';
import { deriveTranscriptInteractionFromSession } from '@/utils/sessions/deriveTranscriptInteraction';
import { Typography } from '@/constants/Typography';
import { ToolFullView } from '@/components/tools/shell/views/ToolFullView';
import { useSessionRecipientState } from '@/components/sessions/agentInput/routing/useSessionRecipientState';

type SessionMessageDetailsTheme = Readonly<{
    colors: Readonly<{
        text: string;
    }>;
}>;

type SessionMessageDetailsStyles = Readonly<{
    routeContent: ViewStyle;
    fullViewContainer: ViewStyle;
    toolCallFullViewContainer: ViewStyle;
    messageText: TextStyle;
}>;

export function createSessionMessageDetailsStyles(theme: SessionMessageDetailsTheme): SessionMessageDetailsStyles {
    return {
        routeContent: {
            flex: 1,
            minHeight: 0,
        },
        fullViewContainer: {
            flex: 1,
            padding: 16,
        },
        toolCallFullViewContainer: {
            flex: 1,
            minHeight: 0,
        },
        messageText: {
            color: theme.colors.text,
            fontSize: 16,
            lineHeight: 24,
            ...Typography.default(),
        },
    };
}

function TextFullView(props: Readonly<{ text: string }>) {
    const { theme } = useUnistyles();
    const styles = React.useMemo(() => createSessionMessageDetailsStyles(theme), [theme]);

    return (
        <View style={styles.fullViewContainer}>
            <Text style={styles.messageText}>{props.text}</Text>
        </View>
    );
}

function ensureAutoRecipientTarget(
    targets: readonly SessionParticipantTarget[],
    autoRecipient: ParticipantRecipientV1 | null,
): readonly SessionParticipantTarget[] {
    if (!autoRecipient) return targets;

    const alreadyPresent = targets.some((target) => {
        const recipient = target.recipient;
        if (autoRecipient.kind === 'execution_run') {
            return recipient.kind === 'execution_run' && recipient.runId === autoRecipient.runId;
        }
        if (autoRecipient.kind === 'agent_team_broadcast') {
            return recipient.kind === 'agent_team_broadcast' && recipient.teamId === autoRecipient.teamId;
        }
        if (autoRecipient.kind === 'agent_team_member') {
            return (
                recipient.kind === 'agent_team_member' &&
                recipient.teamId === autoRecipient.teamId &&
                recipient.memberId === autoRecipient.memberId
            );
        }
        return false;
    });
    if (alreadyPresent) return targets;

    if (autoRecipient.kind === 'execution_run') {
        const displayLabel = t('session.participants.executionRun', { runId: autoRecipient.runId });
        const injectedTarget = {
            key: `execution_run:${autoRecipient.runId}`,
            displayLabel,
            recipient: { kind: 'execution_run', runId: autoRecipient.runId, label: displayLabel } satisfies ParticipantRecipientV1,
        } satisfies SessionParticipantTarget;
        return [injectedTarget, ...targets];
    }

    if (autoRecipient.kind === 'agent_team_broadcast') {
        const displayLabel = t('session.participants.broadcast', { teamId: autoRecipient.teamId });
        const injectedTarget = {
            key: `agent_team_broadcast:${autoRecipient.teamId}`,
            displayLabel,
            recipient: { kind: 'agent_team_broadcast', teamId: autoRecipient.teamId } satisfies ParticipantRecipientV1,
        } satisfies SessionParticipantTarget;
        return [injectedTarget, ...targets];
    }

    const displayLabel = autoRecipient.memberLabel ? autoRecipient.memberLabel : autoRecipient.memberId;
    const injectedTarget = {
        key: `agent_team_member:${autoRecipient.teamId}:${autoRecipient.memberId}`,
        displayLabel,
        recipient: {
            kind: 'agent_team_member',
            teamId: autoRecipient.teamId,
            memberId: autoRecipient.memberId,
            ...(autoRecipient.memberLabel ? { memberLabel: autoRecipient.memberLabel } : {}),
        } satisfies ParticipantRecipientV1,
    } satisfies SessionParticipantTarget;

    return [injectedTarget, ...targets];
}

function ToolCallDetailsView(props: Readonly<{
    message: Extract<Message, { kind: 'tool-call' }>;
    sessionId: string;
    session: Session;
    jumpChildId: string | null;
    showComposer: boolean;
}>) {
    const { theme } = useUnistyles();
    const styles = React.useMemo(() => createSessionMessageDetailsStyles(theme), [theme]);
    const { messages: committedMessages } = useSessionMessages(props.sessionId);
    const executionRunsEnabled = useFeatureEnabled('execution.runs');
    const executionRunPollingEnabled = React.useMemo(() => {
        return shouldEnableExecutionRunPolling({
            executionRunsFeatureEnabled: executionRunsEnabled,
            messages: committedMessages,
        });
    }, [committedMessages, executionRunsEnabled]);
    const executionRunPollingRefreshKey = React.useMemo(() => {
        return deriveExecutionRunPollingRefreshKey(committedMessages);
    }, [committedMessages]);
    const runningExecutionRuns = useSessionRunningExecutionRuns({
        sessionId: props.sessionId,
        enabled: executionRunPollingEnabled,
        refreshKey: executionRunPollingRefreshKey,
    });
    const directSessionRuntime = useDirectSessionRuntime({
        sessionId: props.sessionId,
        metadata: props.session.metadata,
    });
    const canControlExecutionRuns = directSessionRuntime.directSessionLink === null || directSessionRuntime.status?.runnerActive === true;

    const interaction = React.useMemo(() => {
        return deriveTranscriptInteractionFromSession({
            accessLevel: props.session.accessLevel,
            canApprovePermissions: props.session.canApprovePermissions,
            active: props.session.active,
            presence: props.session.presence,
        });
    }, [props.session.accessLevel, props.session.active, props.session.canApprovePermissions, props.session.presence]);

    const focusedTool = props.message.tool;
    const toolName = focusedTool?.name;
    const canShowComposer = typeof toolName === 'string' && isSubAgentTranscriptToolName(toolName);

    const baseParticipantTargets = React.useMemo(() => {
        return deriveSessionParticipantTargets({
            session: props.session,
            messages: committedMessages,
            activeExecutionRuns: runningExecutionRuns,
            canControlExecutionRuns,
        });
    }, [canControlExecutionRuns, committedMessages, props.session, runningExecutionRuns]);

    const autoRecipient = React.useMemo(() => {
        if (!canShowComposer) return null;
        return deriveAutoRecipientFromFocusedToolTranscript({
            session: props.session,
            tool: focusedTool,
            messages: committedMessages,
            activeExecutionRuns: runningExecutionRuns,
            focusedMessages: props.message.children,
            canControlExecutionRuns,
        });
    }, [canControlExecutionRuns, canShowComposer, committedMessages, focusedTool, props.message.children, props.session, runningExecutionRuns]);

    const visibleFocusedMessages = React.useMemo(() => {
        return resolveSessionSubagentVisibleMessages({
            session: props.session,
            tool: focusedTool,
            messages: committedMessages,
            focusedMessages: props.message.children,
            activeExecutionRuns: runningExecutionRuns,
        });
    }, [committedMessages, focusedTool, props.message.children, props.session, runningExecutionRuns]);

    const participantTargets = React.useMemo(() => {
        return ensureAutoRecipientTarget(baseParticipantTargets, autoRecipient);
    }, [autoRecipient, baseParticipantTargets]);

    const recipientState = useSessionRecipientState({ targets: participantTargets, autoRecipient });
    const routingControls = useSessionAgentInputRoutingControls({
        isReadOnly: !canShowComposer,
        participantTargets,
        recipientState,
    });

    const extraActionChips = routingControls.extraActionChips;

    const shouldShowComposer = props.showComposer && canShowComposer && autoRecipient !== null;
    const forcePermissionFooterInTranscript = !shouldShowComposer;

    return (
        <View style={styles.toolCallFullViewContainer}>
            <ToolFullView
                tool={props.message.tool}
                messages={[...visibleFocusedMessages]}
                sessionId={props.sessionId}
                metadata={props.session.metadata ?? null}
                interaction={interaction}
                jumpChildId={props.jumpChildId}
                forcePermissionFooterInTranscript={forcePermissionFooterInTranscript}
            />

            {shouldShowComposer ? (
                <SessionParticipantComposer
                    sessionId={props.sessionId}
                    canSendMessages={interaction.canSendMessages}
                    recipient={recipientState.recipient}
                    executionRunDelivery={recipientState.executionRunDelivery}
                    onExecutionRunUnavailable={() => recipientState.setManualRecipient(null)}
                    extraActionChips={extraActionChips}
                />
            ) : null}
        </View>
    );
}

export const SessionMessageDetailsView = React.memo((props: Readonly<{
    sessionId: string;
    session: Session;
    message: Message;
    jumpChildId?: string | null;
    showComposer?: boolean;
}>) => {
    const { theme } = useUnistyles();
    const styles = React.useMemo(() => createSessionMessageDetailsStyles(theme), [theme]);

    return (
        <View style={styles.routeContent}>
            <Deferred>
                {props.message.kind === 'tool-call' ? (
                    <ToolCallDetailsView
                        message={props.message}
                        sessionId={props.sessionId}
                        session={props.session}
                        jumpChildId={props.jumpChildId ?? null}
                        showComposer={props.showComposer ?? true}
                    />
                ) : props.message.kind === 'agent-text' || props.message.kind === 'user-text' ? (
                    <TextFullView text={props.message.text} />
                ) : null}
            </Deferred>
        </View>
    );
});
