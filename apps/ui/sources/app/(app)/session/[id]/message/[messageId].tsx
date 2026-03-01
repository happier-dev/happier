import * as React from 'react';
import { useLocalSearchParams, Stack, useRouter } from "expo-router";
import { View, ActivityIndicator } from 'react-native';
import { useMessage, useSession, useSessionMessages, useSessionTranscriptIds } from "@/sync/domains/state/storage";
import { sync } from '@/sync/sync';
import { Deferred } from "@/components/ui/forms/Deferred";
import { ToolFullView } from '@/components/tools/shell/views/ToolFullView';
import { ToolHeader } from '@/components/tools/shell/presentation/ToolHeader';
import { ToolStatusIndicator } from '@/components/tools/shell/presentation/ToolStatusIndicator';
import { Message } from '@/sync/domains/messages/messageTypes';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { Text } from '@/components/ui/text/Text';
import { deriveTranscriptInteraction } from '@/utils/sessions/deriveTranscriptInteraction';
import { AgentInput } from '@/components/sessions/agentInput';
import { getSuggestions } from '@/components/autocomplete/suggestions';
import { Modal } from '@/modal';
import { t } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { deriveAutoRecipientFromFocusedToolTranscript, deriveSessionParticipantTargets } from '@/sync/domains/session/participants/deriveSessionParticipantTargets';
import type { SessionParticipantTarget } from '@/sync/domains/session/participants/participantTargets';
import { useSessionRecipientState } from '@/components/sessions/agentInput/recipient/useSessionRecipientState';
import { RecipientChip } from '@/components/sessions/agentInput/recipient/RecipientChip';
import type { AgentInputExtraActionChip } from '@/components/sessions/agentInput/AgentInput';
import { resolveParticipantRoutedSend } from '@/sync/domains/input/participants/resolveParticipantRoutedSend';
import { isExecutionRunNotRunningSendError, sessionExecutionRunSend } from '@/sync/ops/sessionExecutionRuns';
import { useSessionRunningExecutionRuns } from '@/hooks/session/useSessionRunningExecutionRuns';
import type { ParticipantRecipientV1 } from '@happier-dev/protocol';


const stylesheet = StyleSheet.create((theme) => ({
    loadingContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
    },
    fullViewContainer: {
        flex: 1,
        padding: 16,
    },
    messageText: {
        color: theme.colors.text,
        fontSize: 16,
        lineHeight: 24,
        ...Typography.default(),
    },
}));

export default React.memo(() => {
    const { id: sessionId, messageId, jumpChildId } = useLocalSearchParams<{ id: string; messageId: string; jumpChildId?: string }>();
    const router = useRouter();
    const session = useSession(sessionId!);
    const { isLoaded: messagesLoaded } = useSessionTranscriptIds(sessionId!);
    const message = useMessage(sessionId!, messageId!);
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const [messageBackfillComplete, setMessageBackfillComplete] = React.useState(false);

    const tool = message?.kind === 'tool-call' ? message.tool : null;
    const toolHeaderTitle = React.useCallback(() => {
        return tool ? <ToolHeader tool={tool} /> : null;
    }, [tool]);
    const toolHeaderRight = React.useCallback(() => {
        return tool ? <ToolStatusIndicator tool={tool} /> : null;
    }, [tool]);

    const toolScreenOptions = React.useMemo(() => {
        return {
            headerTitle: toolHeaderTitle,
            headerRight: toolHeaderRight,
            headerStyle: {
                backgroundColor: theme.colors.header.background,
            },
            headerTintColor: theme.colors.header.tint,
            headerShadowVisible: false,
        } as const;
    }, [theme.colors.header.background, theme.colors.header.tint, toolHeaderRight, toolHeaderTitle]);

    const interaction = React.useMemo(() => {
        if (!session) {
            return { canSendMessages: false, canApprovePermissions: false } as const;
        }
        return deriveTranscriptInteraction({
            kind: 'session',
            accessLevel: session.accessLevel,
            canApprovePermissions: session.canApprovePermissions,
        });
    }, [session]);
    
    // Trigger session visibility when component mounts
    React.useEffect(() => {
        if (sessionId) {
            sync.onSessionVisible(sessionId);
        }
    }, [sessionId]);

    React.useEffect(() => {
        setMessageBackfillComplete(false);
    }, [messageId, sessionId]);

    // Best-effort hydration for deep links / hard refreshes: sessions list is paginated, and message fetch
    // is guarded when a session isn't known on the active server snapshot yet.
    React.useEffect(() => {
        if (!sessionId) return;
        fireAndForget(sync.ensureSessionVisibleForMessageRoute(sessionId), { tag: 'MessageRoute.ensureSessionVisible' });
    }, [sessionId]);

    // Message deep links may target messages older than the initial `/messages` page. If we can't find
    // the message after the initial load, try paging older messages until we either find it or run out.
    React.useEffect(() => {
        let canceled = false;
        if (!sessionId || !messageId || !messagesLoaded || message || messageBackfillComplete) return;

        fireAndForget((async () => {
            try {
                try {
                    await sync.ensureSessionVisibleForMessageRoute(sessionId);
                } catch {
                    // best-effort only
                }
                // Cap work to avoid infinite paging on malformed message IDs.
                for (let i = 0; i < 25; i++) {
                    const result = await sync.loadOlderMessages(sessionId);
                    if (canceled) return;

                    if (result.status === 'not_ready' || result.status === 'in_flight') {
                        await new Promise((r) => setTimeout(r, 100));
                        continue;
                    }

                    if (result.status === 'no_more' || result.hasMore === false) {
                        break;
                    }

                    if (result.loaded <= 0) {
                        // Avoid tight loops if the paging cursor doesn't advance.
                        break;
                    }
                }
            } finally {
                if (!canceled) {
                    setMessageBackfillComplete(true);
                }
            }
        })(), { tag: 'MessageRoute.loadOlderMessages' });

        return () => {
            canceled = true;
        };
    }, [message, messageBackfillComplete, messageId, messagesLoaded, sessionId]);

    React.useEffect(() => {
        if (messageBackfillComplete && messagesLoaded && !message) {
            const canGoBack = typeof (router as any)?.canGoBack === 'function' ? (router as any).canGoBack() : false;
            if (canGoBack) {
                router.back();
                return;
            }
            if (sessionId) {
                router.replace(`/session/${encodeURIComponent(String(sessionId))}`);
                return;
            }
            router.replace('/');
        }
    }, [messageBackfillComplete, messagesLoaded, message, router]);
    
    // Configure header for tool messages
    React.useLayoutEffect(() => {
        if (message && message.kind === 'tool-call' && message.tool) {
            // Header is configured in the Stack.Screen options
        }
    }, [message]);
    
    // Show loader while waiting for session and messages to load
    if (!session || !messagesLoaded) {
        return (
            <View style={styles.loadingContainer}>
                <ActivityIndicator size="small" color={theme.colors.textSecondary} />
            </View>
        );
    }
    
    // If messages are loaded but specific message not found, show loader briefly
    // The useEffect above will navigate back
    if (!message) {
        return (
            <View style={styles.loadingContainer}>
                <ActivityIndicator size="small" color={theme.colors.textSecondary} />
            </View>
        );
    }
    
    return (
        <>
            {tool && (
                <Stack.Screen
                    options={toolScreenOptions}
                />
            )}
            <Deferred>
                <FullView
                    message={message}
                    sessionId={sessionId!}
                    session={session}
                    metadata={(session as any)?.metadata ?? null}
                    interaction={interaction}
                    jumpChildId={typeof jumpChildId === 'string' ? jumpChildId : null}
                />
            </Deferred>
        </>
    );
});

function FullView(props: {
    message: Message;
    sessionId: string;
    session: any;
    metadata: any;
    interaction: { canSendMessages: boolean; canApprovePermissions: boolean; permissionDisabledReason?: 'public' | 'readOnly' | 'notGranted' | 'inactive' };
    jumpChildId: string | null;
}) {
    if (props.message.kind === 'tool-call') {
        return (
            <ToolCallFullView
                message={props.message}
                sessionId={props.sessionId}
                session={props.session}
                metadata={props.metadata}
                interaction={props.interaction}
                jumpChildId={props.jumpChildId}
            />
        );
    }
    if (props.message.kind === 'agent-text') {
        return <TextFullView text={props.message.text} />;
    }
    if (props.message.kind === 'user-text') {
        return <TextFullView text={props.message.text} />;
    }
    return null;
}

function TextFullView(props: { text: string }) {
    const styles = stylesheet;
    return (
        <View style={styles.fullViewContainer}>
            <Text style={styles.messageText}>{props.text}</Text>
        </View>
    );
}

function ensureExecutionRunAutoRecipientTarget(
    targets: readonly SessionParticipantTarget[],
    autoRecipient: ParticipantRecipientV1 | null,
): readonly SessionParticipantTarget[] {
    if (!autoRecipient || autoRecipient.kind !== 'execution_run') return targets;
    if (
        targets.some(
            (target) => target.recipient.kind === 'execution_run' && target.recipient.runId === autoRecipient.runId,
        )
    ) {
        return targets;
    }
    const displayLabel = t('session.participants.executionRun', { runId: autoRecipient.runId });
    const injectedTarget = {
        key: `execution_run:${autoRecipient.runId}`,
        displayLabel,
        recipient: { kind: 'execution_run', runId: autoRecipient.runId, label: displayLabel } satisfies ParticipantRecipientV1,
    } satisfies SessionParticipantTarget;

    return [injectedTarget, ...targets];
}

function ToolCallFullView(props: {
    message: Extract<Message, { kind: 'tool-call' }>;
    sessionId: string;
    session: any;
    metadata: any;
    interaction: { canSendMessages: boolean; canApprovePermissions: boolean; permissionDisabledReason?: 'public' | 'readOnly' | 'notGranted' | 'inactive' };
    jumpChildId: string | null;
}) {
    const { messages: committedMessages } = useSessionMessages(props.sessionId);
    const [composerText, setComposerText] = React.useState('');
    const runningExecutionRuns = useSessionRunningExecutionRuns({
        sessionId: props.sessionId,
        enabled: true,
    });

    const focusedTool = props.message.tool;
    const toolName = focusedTool?.name;
    const canShowComposer = toolName === 'Task' || toolName === 'SubAgentRun' || toolName === 'Agent';

    const baseParticipantTargets = React.useMemo(() => {
        return deriveSessionParticipantTargets({
            session: props.session,
            messages: committedMessages,
            activeExecutionRuns: runningExecutionRuns,
        });
    }, [committedMessages, props.session, runningExecutionRuns]);

    const autoRecipient = React.useMemo(() => {
        if (!canShowComposer) return null;
        return deriveAutoRecipientFromFocusedToolTranscript({
            session: props.session,
            tool: focusedTool,
            messages: committedMessages,
            activeExecutionRuns: runningExecutionRuns,
            focusedMessages: props.message.children,
        });
    }, [canShowComposer, committedMessages, focusedTool, props.message.children, props.session, runningExecutionRuns]);

    const participantTargets = React.useMemo(() => {
        return ensureExecutionRunAutoRecipientTarget(baseParticipantTargets, autoRecipient);
    }, [autoRecipient, baseParticipantTargets]);

    const recipientState = useSessionRecipientState({ targets: participantTargets, autoRecipient });

    const extraActionChips: ReadonlyArray<AgentInputExtraActionChip> | undefined = React.useMemo(() => {
        if (!canShowComposer) return undefined;
        if (participantTargets.length === 0) return undefined;
        return [
            {
                key: 'recipient',
                render: (ctx) => (
                    <RecipientChip
                        targets={participantTargets}
                        recipient={recipientState.recipient}
                        onRecipientChange={recipientState.setManualRecipient}
                        ctx={ctx}
                    />
                ),
            },
        ];
    }, [canShowComposer, participantTargets, recipientState.recipient, recipientState.setManualRecipient]);

    return (
        <View style={{ flex: 1 }}>
            <ToolFullView
                tool={props.message.tool}
                messages={props.message.children}
                sessionId={props.sessionId}
                metadata={props.metadata}
                interaction={props.interaction}
                jumpChildId={props.jumpChildId}
            />

            {canShowComposer ? (
                <AgentInput
                    placeholder={props.interaction.canSendMessages ? t('session.inputPlaceholder') : t('session.sharing.viewOnlyMode')}
                    value={composerText}
                    onChangeText={setComposerText}
                    sessionId={props.sessionId}
                    onSend={() => {
                        if (!props.interaction.canSendMessages) {
                            Modal.alert(t('common.error'), t('session.sharing.noEditPermission'));
                            return;
                        }

                        const text = composerText.trim();
                        if (text.length === 0) return;

                        const previousMessage = composerText;
                        setComposerText('');

                        fireAndForget((async () => {
                            const routed =
                                recipientState.recipient
                                    ? resolveParticipantRoutedSend({ text, recipient: recipientState.recipient })
                                    : null;

                            if (routed?.type === 'execution_run_send') {
                                const result = await sessionExecutionRunSend(props.sessionId, {
                                    runId: routed.runId,
                                    message: routed.message,
                                    delivery: routed.delivery,
                                });
                                if (!result.ok) {
                                    if (isExecutionRunNotRunningSendError(result)) {
                                        recipientState.setManualRecipient(null);
                                    }
                                    setComposerText(previousMessage);
                                    Modal.alert(t('common.error'), result.error ?? t('runs.send.failedToSend'));
                                }
                                return;
                            }

                            try {
                                if (routed?.type === 'session_message') {
                                    await sync.sendMessage(props.sessionId, routed.text, routed.displayText, routed.metaOverrides);
                                    return;
                                }
                                await sync.sendMessage(props.sessionId, text);
                            } catch (e) {
                                setComposerText(previousMessage);
                                Modal.alert(t('common.error'), e instanceof Error ? e.message : t('errors.failedToSendMessage'));
                            }
                        })(), { tag: 'FocusedMessageView.sendMessage' });
                    }}
                    autocompletePrefixes={['@', '/']}
                    autocompleteSuggestions={(query) => getSuggestions(props.sessionId, query)}
                    isSendDisabled={!props.interaction.canSendMessages}
                    disabled={!props.interaction.canSendMessages}
                    extraActionChips={extraActionChips}
                />
            ) : null}
        </View>
    );
}
