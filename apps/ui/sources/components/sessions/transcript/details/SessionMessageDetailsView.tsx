import { isSubAgentTranscriptToolName } from '@happier-dev/protocol/tools/v2/subAgentFamilies';
import type { ParticipantRecipientV1 } from '@happier-dev/protocol/messages/structured/participantMessageV1';
import * as React from 'react';
import { useServerCredentialAccountScopeResolution } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { View } from 'react-native';
import type { TextStyle, ViewStyle } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { useSessionAgentInputRoutingControls } from '@/components/sessions/agentInput/routing/useSessionAgentInputRoutingControls';
import { SessionParticipantComposer } from '@/components/sessions/participants/composer/SessionParticipantComposer';
import { Deferred } from '@/components/ui/forms/Deferred';
import { Text } from '@/components/ui/text/Text';
import { useSessionExternalSessionRuntime } from '@/components/sessions/model/useSessionExternalSessionRuntime';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useSessionRunningExecutionRuns } from '@/hooks/session/useSessionRunningExecutionRuns';
import type { Message } from "@happier-dev/session-core/messages";
import {
    deriveAutoRecipientFromFocusedToolTranscript,
    deriveSessionParticipantTargets,
} from '@/sync/domains/session/participants/deriveSessionParticipantTargets';
import { resolveSessionSubagentVisibleMessages } from '@/sync/domains/session/subagents/visibleMessages/resolveSessionSubagentVisibleMessages';
import { deriveExecutionRunPollingRefreshKey } from '@/sync/domains/session/participants/deriveExecutionRunPollingRefreshKey';
import type { SessionParticipantTarget } from '@/sync/domains/session/participants/participantTargets';
import { shouldEnableExecutionRunPolling } from '@/sync/domains/session/participants/shouldEnableExecutionRunPolling';
import type { Session } from '@/sync/domains/state/storageTypes';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { useSessionMessages, useSessionPendingMessages } from '@/sync/store/hooks';
import { buildSessionTranscriptAgentAttributionIndex } from "@happier-dev/session-core/messages";
import {
    SessionTranscriptAgentAttributionProvider,
    TranscriptRowSeqProvider,
} from '@/components/sessions/transcript/attribution/SessionTranscriptAgentAttributionContext';
import { t } from '@/text';
import { deriveTranscriptInteractionFromSession } from '@/utils/sessions/deriveTranscriptInteraction';
import { Typography } from '@/constants/Typography';
import { ToolFullView } from '@/components/tools/shell/views/ToolFullView';
import { useSessionRecipientState } from '@/components/sessions/agentInput/routing/useSessionRecipientState';
import { participantRecipientsMatch } from '@/sync/domains/input/participants/resolveParticipantRoutedSend';
import type { BrowserContextState } from '@/sync/domains/browser/context';
import { AppSessionTranscriptSourceProvider } from '@/components/sessions/transcript/source/appSessionTranscriptSource';
import { useSessionTranscriptSource } from '@/components/sessions/transcript/source/SessionTranscriptSourceContext';

type SessionMessageDetailsTheme = Readonly<{
    colors: Readonly<{
        text: Readonly<{
            primary: string;
        }>;
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
            color: theme.colors.text.primary,
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

    const alreadyPresent = targets.some((target) => participantRecipientsMatch(target.recipient, autoRecipient));
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
    recipientOverride?: ParticipantRecipientV1;
    composerInitialLocalId?: string;
    browserContextState?: BrowserContextState | null;
}>) {
    const { theme } = useUnistyles();
    const styles = React.useMemo(() => createSessionMessageDetailsStyles(theme), [theme]);
    const ownerMetadata = readSessionOwnerMetadataView(props.session);
    const accountScopeResolution = useServerCredentialAccountScopeResolution(props.session.serverId);
    const accountScope = props.session.serverId === undefined ? undefined
        : accountScopeResolution.kind === 'bound' ? accountScopeResolution.scope : null;
    const { messages: committedMessages } = useSessionMessages(props.sessionId);
    // This screen shows one row from the transcript in isolation. Without the
    // transcript's divider index it would fall back to the Session's current
    // Agent, which is exactly the row a switched Session gets wrong.
    const agentAttributionIndex = React.useMemo(
        () => buildSessionTranscriptAgentAttributionIndex(committedMessages),
        [committedMessages],
    );
    const executionRunsEnabled = useFeatureEnabled('execution.runs', props.session.serverId
        ? { scopeKind: 'spawn', serverId: props.session.serverId }
        : undefined);
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
        serverId: props.session.serverId,
        enabled: executionRunPollingEnabled,
        refreshKey: executionRunPollingRefreshKey,
    });
    const externalSessionRuntime = useSessionExternalSessionRuntime({
        sessionId: props.sessionId,
        metadata: ownerMetadata,
        serverId: props.session.serverId,
    });
    const canControlExecutionRuns = externalSessionRuntime.externalSessionLink === null || externalSessionRuntime.status?.runnerActive === true;

    const interaction = useSessionTranscriptSource().useInteraction();

    const focusedTool = props.message.tool;
    const toolName = focusedTool?.name;
    const canShowComposer = typeof toolName === 'string' && isSubAgentTranscriptToolName(toolName);

    const baseParticipantTargets = React.useMemo(() => {
        return deriveSessionParticipantTargets({
            accountScope,
            session: props.session,
            messages: committedMessages,
            activeExecutionRuns: runningExecutionRuns,
            canControlExecutionRuns,
        });
    }, [accountScope, canControlExecutionRuns, committedMessages, props.session, runningExecutionRuns]);

    const inferredRecipient = React.useMemo(() => {
        if (!canShowComposer) return null;
        return deriveAutoRecipientFromFocusedToolTranscript({
            accountScope,
            session: props.session,
            tool: focusedTool,
            messages: committedMessages,
            activeExecutionRuns: runningExecutionRuns,
            focusedMessages: props.message.children,
            canControlExecutionRuns,
        });
    }, [accountScope, canControlExecutionRuns, canShowComposer, committedMessages, focusedTool, props.message.children, props.session, runningExecutionRuns]);

    // A mounted Run Details surface already has an exact, server-loaded Run
    // identity. It must not re-infer (and potentially retarget) that destination
    // from a neighboring transcript/tool projection.
    const autoRecipient = props.recipientOverride ?? inferredRecipient;

    const visibleFocusedMessages = React.useMemo(() => {
        return resolveSessionSubagentVisibleMessages({
            accountScope,
            session: props.session,
            tool: focusedTool,
            messages: committedMessages,
            focusedMessages: props.message.children,
            activeExecutionRuns: runningExecutionRuns,
        });
    }, [accountScope, committedMessages, focusedTool, props.message.children, props.session, runningExecutionRuns]);

    const participantTargets = React.useMemo(() => {
        return props.recipientOverride
            ? ensureAutoRecipientTarget([], props.recipientOverride)
            : ensureAutoRecipientTarget(baseParticipantTargets, autoRecipient);
    }, [autoRecipient, baseParticipantTargets, props.recipientOverride]);

    const recipientState = useSessionRecipientState({ targets: participantTargets, autoRecipient });
    const routingControls = useSessionAgentInputRoutingControls({
        isReadOnly: !canShowComposer,
        participantTargets,
        recipientState,
    });

    const extraActionChips = routingControls.extraActionChips;

    const shouldShowComposer = props.showComposer && canShowComposer && autoRecipient !== null;
    const forcePermissionFooterInTranscript = !shouldShowComposer;

    // Exact-target pending rows for this Run only. Main, Run A and Run B queues stay
    // isolated because the canonical pending owner filters by this recipient.
    const executionRunRecipient = React.useMemo(
        () => (autoRecipient?.kind === 'execution_run'
            ? ({ kind: 'execution_run', runId: autoRecipient.runId } as const)
            : undefined),
        [autoRecipient],
    );
    const targetPending = useSessionPendingMessages(props.sessionId, executionRunRecipient);

    return (
        <SessionTranscriptAgentAttributionProvider value={agentAttributionIndex}>
        <TranscriptRowSeqProvider value={props.message.seq ?? null}>
        <View style={styles.toolCallFullViewContainer}>
            <ToolFullView
                tool={props.message.tool}
                owningMessageId={props.message.id}
                messages={[...visibleFocusedMessages]}
                sessionId={props.sessionId}
                serverId={props.session.serverId}
                metadata={ownerMetadata}
                interaction={interaction}
                jumpChildId={props.jumpChildId}
                forcePermissionFooterInTranscript={forcePermissionFooterInTranscript}
                pendingMessages={executionRunRecipient ? targetPending.messages : null}
                discardedMessages={executionRunRecipient ? targetPending.discarded : null}
                pendingRecipient={executionRunRecipient}
            />

            {shouldShowComposer ? (
                <SessionParticipantComposer
                    sessionId={props.sessionId}
                    serverId={props.session.serverId}
                    canSendMessages={interaction.canSendMessages}
                    recipient={recipientState.recipient}
                    executionRunRequestedAction={recipientState.executionRunRequestedAction}
                    initialLocalId={props.composerInitialLocalId}
                    browserContextState={props.browserContextState}
                    extraActionChips={extraActionChips}
                />
            ) : null}
        </View>
        </TranscriptRowSeqProvider>
        </SessionTranscriptAgentAttributionProvider>
    );
}

export const SessionMessageDetailsView = React.memo((props: Readonly<{
    sessionId: string;
    session: Session;
    message: Message;
    jumpChildId?: string | null;
    showComposer?: boolean;
    recipientOverride?: ParticipantRecipientV1;
    composerInitialLocalId?: string;
    browserContextState?: BrowserContextState | null;
}>) => {
    const { theme } = useUnistyles();
    const styles = React.useMemo(() => createSessionMessageDetailsStyles(theme), [theme]);
    const interaction = React.useMemo(() => deriveTranscriptInteractionFromSession({
        access: props.session.access,
        active: props.session.active,
        presence: props.session.presence,
    }), [props.session.access, props.session.active, props.session.presence]);

    return (
        <AppSessionTranscriptSourceProvider sessionId={props.sessionId} serverId={props.session.serverId} interaction={interaction}>
        <View style={styles.routeContent}>
            <Deferred>
                {props.message.kind === 'tool-call' ? (
                    <ToolCallDetailsView
                        message={props.message}
                        sessionId={props.sessionId}
                        session={props.session}
                        jumpChildId={props.jumpChildId ?? null}
                        showComposer={props.showComposer ?? true}
                        recipientOverride={props.recipientOverride}
                        composerInitialLocalId={props.composerInitialLocalId}
                        browserContextState={props.browserContextState}
                    />
                ) : props.message.kind === 'agent-text' || props.message.kind === 'user-text' ? (
                    <TextFullView text={props.message.text} />
                ) : null}
            </Deferred>
        </View>
        </AppSessionTranscriptSourceProvider>
    );
});
