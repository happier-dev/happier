import type { ExecutionRunPublicState } from '@happier-dev/protocol';
import * as React from 'react';
import { ActivityIndicator, Pressable, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';

import {
    isExecutionRunNotRunningSendError,
    sessionExecutionRunGet,
    sessionExecutionRunSend,
    sessionExecutionRunStop,
} from '@/sync/ops/sessionExecutionRuns';
import { useMessage, useResolvedSessionMessageRouteId, useSession, useSessionMessages } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { renderExecutionRunStructuredMeta } from '@/components/sessions/runs/renderExecutionRunStructuredMeta';
import { SessionExecutionRunInfoCard } from '@/components/sessions/runs/details/SessionExecutionRunInfoCard';
import {
    resolveDaemonExecutionRunFallback,
    type ExecutionRunTranscriptFallback,
} from '@/components/sessions/runs/details/resolveDaemonExecutionRunFallback';
import { SessionMessageDetailsView } from '@/components/sessions/transcript/details/SessionMessageDetailsView';
import { ConstrainedScreenContent } from '@/components/ui/layout/ConstrainedScreenContent';
import { canSendMessagesToExecutionRun } from '@/sync/domains/executionRuns/canSendMessagesToExecutionRun';
import { sync } from '@/sync/sync';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { Text, TextInput } from '@/components/ui/text/Text';
import { buildToolCallMessageRouteId } from '@/sync/domains/messages/messageRouteIds';
import {
    buildExecutionRunPublicStateFromTranscriptState,
    findTranscriptExecutionRunState,
} from '@/sync/domains/session/subagents/executionRuns/deriveExecutionRunSubagents';

type LoadState =
    | { status: 'loading' }
    | { status: 'error'; error: string }
    | {
        status: 'loaded';
        run: ExecutionRunPublicState;
        latestToolResult?: unknown;
        structuredMeta?: unknown;
        source: 'session_rpc' | 'transcript_fallback' | 'daemon_fallback';
    };

function isSessionEncryptionNotFoundError(input: unknown): boolean {
    if (!input || typeof input !== 'object') return false;
    const code = typeof (input as { errorCode?: unknown }).errorCode === 'string' ? String((input as { errorCode?: string }).errorCode) : '';
    if (code === 'session_encryption_not_found') return true;
    const message = typeof (input as { error?: unknown }).error === 'string' ? String((input as { error?: string }).error) : '';
    return /session encryption not found/i.test(message);
}

function isRpcMethodNotAvailableError(input: unknown): boolean {
    if (!input || typeof input !== 'object') return false;
    const code = typeof (input as { errorCode?: unknown }).errorCode === 'string' ? String((input as { errorCode?: string }).errorCode) : '';
    if (code === 'RPC_METHOD_NOT_AVAILABLE') return true;
    const message = typeof (input as { error?: unknown }).error === 'string' ? String((input as { error?: string }).error) : '';
    return /rpc method not available/i.test(message);
}

function readNonEmptyString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function resolveExecutionRunTranscriptToolId(params: Readonly<{
    run?: ExecutionRunPublicState | null;
    latestToolResult?: unknown;
}>): string | null {
    return (
        readNonEmptyString((params.run as { sidechainId?: unknown } | null)?.sidechainId)
        ?? readNonEmptyString((params.run as { callId?: unknown } | null)?.callId)
        ?? readNonEmptyString((params.latestToolResult as { sidechainId?: unknown } | null)?.sidechainId)
        ?? readNonEmptyString((params.latestToolResult as { callId?: unknown } | null)?.callId)
    );
}

export type SessionExecutionRunDetailsViewHandle = Readonly<{
    reload: () => Promise<void>;
}>;

export const SessionExecutionRunDetailsView = React.memo(React.forwardRef<SessionExecutionRunDetailsViewHandle, Readonly<{
    sessionId: string;
    runId: string;
    presentation?: 'screen' | 'panel';
    showInfoCard?: boolean;
    showSendComposer?: boolean;
}>>((props, ref) => {
    const { theme } = useUnistyles();
    const router = useRouter();
    const [state, setState] = React.useState<LoadState>({ status: 'loading' });
    const [daemonProcessLine, setDaemonProcessLine] = React.useState<string | null>(null);
    const [sendText, setSendText] = React.useState('');
    const [sendError, setSendError] = React.useState<string | null>(null);
    const [stopError, setStopError] = React.useState<string | null>(null);
    const [isSending, setIsSending] = React.useState(false);
    const [isStopping, setIsStopping] = React.useState(false);
    const { messages: sessionMessages, isLoaded: sessionMessagesLoaded } = useSessionMessages(props.sessionId);
    const transcriptFallback = React.useMemo<ExecutionRunTranscriptFallback | null>(() => {
        const transcriptState = findTranscriptExecutionRunState(sessionMessages, props.runId);
        if (!transcriptState) return null;
        const run = buildExecutionRunPublicStateFromTranscriptState(transcriptState);
        if (!run) return null;
        const matchingMessage = sessionMessages.find((message) => message.id === transcriptState.toolMessageRouteId) ?? null;
        return {
            run,
            latestToolResult: matchingMessage && matchingMessage.kind === 'tool-call' ? matchingMessage.tool?.result : undefined,
            message: matchingMessage,
        };
    }, [props.runId, sessionMessages]);

    const load = React.useCallback(async () => {
        if (!props.sessionId || !props.runId) {
            setState({ status: 'error', error: t('runs.runDetails.failedToLoad') });
            return;
        }
        setState({ status: 'loading' });
        setDaemonProcessLine(null);
        const first = await sessionExecutionRunGet(props.sessionId, { runId: props.runId, includeStructured: true });
        const result =
            first.ok === false && isSessionEncryptionNotFoundError(first)
                ? await sessionExecutionRunGet(props.sessionId, { runId: props.runId, includeStructured: true })
                : first;
        if (result.ok === false) {
            if (result.errorCode === 'execution_run_not_found' && !sessionMessagesLoaded) {
                await sync.loadOlderMessages(props.sessionId).catch(() => null);
                return;
            }
            if (isRpcMethodNotAvailableError(result)) {
                const daemonFallback = await resolveDaemonExecutionRunFallback({
                    sessionId: props.sessionId,
                    runId: props.runId,
                    transcriptFallback,
                }).catch(() => null);
                if (daemonFallback) {
                    setState({
                        status: 'loaded',
                        run: daemonFallback.run,
                        latestToolResult: transcriptFallback?.latestToolResult,
                        source: 'daemon_fallback',
                    });
                    setDaemonProcessLine(daemonFallback.daemonProcessLine);
                    return;
                }
            }
            if (result.errorCode === 'execution_run_not_found' && transcriptFallback) {
                setState({
                    status: 'loaded',
                    run: transcriptFallback.run,
                    latestToolResult: transcriptFallback.latestToolResult,
                    source: 'transcript_fallback',
                });
                return;
            }
            setState({ status: 'error', error: String(result.error ?? t('runs.runDetails.failedToLoad')) });
            return;
        }
        if (!('run' in result)) {
            setState({ status: 'error', error: t('runs.runDetails.failedToLoad') });
            return;
        }
        const run = result.run;
        if (!run || typeof run.runId !== 'string') {
            setState({ status: 'error', error: t('runs.runDetails.failedToLoad') });
            return;
        }
        setState({
            status: 'loaded',
            run,
            latestToolResult: result.latestToolResult,
            structuredMeta: result.structuredMeta,
            source: 'session_rpc',
        });
        const daemonFallback = await resolveDaemonExecutionRunFallback({
            sessionId: props.sessionId,
            runId: props.runId,
            transcriptFallback,
        }).catch(() => null);
        if (daemonFallback?.daemonProcessLine) {
            setDaemonProcessLine(daemonFallback.daemonProcessLine);
        }
    }, [props.runId, props.sessionId, sessionMessagesLoaded, transcriptFallback]);

    React.useEffect(() => {
        void load();
    }, [load]);

    React.useImperativeHandle(ref, () => ({
        reload: load,
    }), [load]);

    const transcriptToolId = React.useMemo(() => {
        if (state.status !== 'loaded') return null;
        return resolveExecutionRunTranscriptToolId({
            run: state.run,
            latestToolResult: state.latestToolResult,
        });
    }, [state]);
    const transcriptToolRouteId = React.useMemo(() => buildToolCallMessageRouteId({ toolId: transcriptToolId }), [transcriptToolId]);
    const session = useSession(props.sessionId);
    const resolvedTranscriptMessageId = useResolvedSessionMessageRouteId(props.sessionId, transcriptToolRouteId ?? '');
    const transcriptMessageFromStore = useMessage(props.sessionId, resolvedTranscriptMessageId ?? transcriptToolRouteId ?? '');
    const transcriptMessage = transcriptMessageFromStore ?? transcriptFallback?.message ?? null;

    const structuredCard = React.useMemo(() => {
        if (state.status !== 'loaded') return null;
        const meta = state.structuredMeta;
        if (!meta || typeof meta !== 'object') return null;
        const kind = typeof (meta as { kind?: unknown }).kind === 'string' ? (meta as { kind: string }).kind : '';
        if (!kind) return null;
        return renderExecutionRunStructuredMeta({ meta: { kind, payload: (meta as { payload?: unknown }).payload }, sessionId: props.sessionId });
    }, [props.sessionId, state]);
    const canMutateRunViaSessionRpc = state.status === 'loaded' && state.source !== 'daemon_fallback';
    const canShowSendComposer = props.showSendComposer !== false
        && state.status === 'loaded'
        && canMutateRunViaSessionRpc
        && canSendMessagesToExecutionRun(state.run);

    const containerStyle = props.presentation === 'panel'
        ? { flex: 1, paddingHorizontal: 16, paddingVertical: 16, gap: 12 as const }
        : { flex: 1 };
    const content = state.status === 'loading' ? (
        <ActivityIndicator size="small" color={theme.colors.textSecondary} />
    ) : state.status === 'error' ? (
        <Text style={{ color: theme.colors.textSecondary }}>{state.error}</Text>
    ) : (
        <View style={{ gap: 10 }}>
            <View style={{ gap: 4 }}>
                {props.showInfoCard === false ? null : (
                    <SessionExecutionRunInfoCard run={state.run} daemonProcessLine={daemonProcessLine} />
                )}
                {!transcriptMessage && transcriptToolRouteId ? (
                    <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={t('toolView.open')}
                        onPress={() => {
                            router.push(`/session/${encodeURIComponent(props.sessionId)}/message/${encodeURIComponent(transcriptToolRouteId)}`);
                        }}
                        style={{
                            alignSelf: 'flex-start',
                            paddingVertical: 8,
                            paddingHorizontal: 10,
                            borderRadius: 10,
                            backgroundColor: theme.colors.surfaceHigh,
                            borderWidth: 1,
                            borderColor: theme.colors.divider,
                        }}
                    >
                        <Text style={{ color: theme.colors.text, fontWeight: '600' }}>{t('toolView.open')}</Text>
                    </Pressable>
                ) : null}
            </View>

            {structuredCard ? (
                <View style={{ gap: 8 }}>
                    {structuredCard}
                </View>
            ) : null}

            {state.run.status === 'running' && canMutateRunViaSessionRpc ? (
                <View style={{ gap: 8 }}>
                    {stopError ? <Text style={{ color: theme.colors.textSecondary }}>{stopError}</Text> : null}
                    <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={t('runs.stop.stopRunA11y')}
                        onPress={() => {
                            fireAndForget((async () => {
                                setStopError(null);
                                setIsStopping(true);
                                try {
                                    const result = await sessionExecutionRunStop(props.sessionId, { runId: props.runId });
                                    if (result.ok === false) {
                                        setStopError(String(result.error ?? t('runs.stop.failedToStopRun')));
                                    } else {
                                        await load();
                                    }
                                } catch (error) {
                                    setStopError(error instanceof Error ? error.message : t('runs.stop.failedToStopRun'));
                                } finally {
                                    setIsStopping(false);
                                }
                            })(), { tag: 'SessionExecutionRunDetailsView.stopRun' });
                        }}
                        disabled={isStopping}
                        style={{
                            paddingVertical: 10,
                            paddingHorizontal: 12,
                            borderRadius: 10,
                            backgroundColor: theme.colors.surfaceHigh,
                            borderWidth: 1,
                            borderColor: theme.colors.divider,
                            opacity: isStopping ? 0.6 : 1,
                        }}
                    >
                        <Text style={{ color: theme.colors.text, fontWeight: '600' }}>
                            {isStopping ? t('runs.stop.stoppingLabel') : t('runs.stop.stopLabel')}
                        </Text>
                    </Pressable>
                </View>
            ) : null}

            {canShowSendComposer ? (
                <View style={{ gap: 8 }}>
                    {sendError ? <Text style={{ color: theme.colors.textSecondary }}>{sendError}</Text> : null}
                    <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
                        <TextInput
                            value={sendText}
                            onChangeText={setSendText}
                            placeholder={t('runs.send.placeholder')}
                            placeholderTextColor={theme.colors.textSecondary}
                            style={{
                                flex: 1,
                                paddingVertical: 10,
                                paddingHorizontal: 12,
                                borderRadius: 10,
                                backgroundColor: theme.colors.surfaceHigh,
                                borderWidth: 1,
                                borderColor: theme.colors.divider,
                                color: theme.colors.text,
                            }}
                        />
                        <Pressable
                            accessibilityRole="button"
                            accessibilityLabel={t('runs.send.a11y.sendToRun')}
                            onPress={() => {
                                const message = sendText.trim();
                                if (!message) return;
                                fireAndForget((async () => {
                                    setSendError(null);
                                    setIsSending(true);
                                    try {
                                        const result = await sessionExecutionRunSend(props.sessionId, { runId: props.runId, message });
                                        if (result.ok === false) {
                                            setSendError(String(result.error ?? t('runs.send.failedToSend')));
                                            const isNoLongerSendable = isExecutionRunNotRunningSendError(result)
                                                || /not in flight/i.test(String(result.error ?? ''));
                                            if (isNoLongerSendable) {
                                                await load();
                                            }
                                        } else {
                                            setSendText('');
                                        }
                                    } catch (error) {
                                        setSendError(error instanceof Error ? error.message : t('runs.send.failedToSend'));
                                    } finally {
                                        setIsSending(false);
                                    }
                                })(), { tag: 'SessionExecutionRunDetailsView.sendToRun' });
                            }}
                            disabled={isSending || sendText.trim().length === 0}
                            style={{
                                paddingVertical: 10,
                                paddingHorizontal: 12,
                                borderRadius: 10,
                                backgroundColor: theme.colors.surfaceHigh,
                                borderWidth: 1,
                                borderColor: theme.colors.divider,
                                opacity: isSending || sendText.trim().length === 0 ? 0.6 : 1,
                            }}
                        >
                            <Text style={{ color: theme.colors.text, fontWeight: '600' }}>
                                {isSending ? t('runs.send.sendingLabel') : t('runs.send.sendLabel')}
                            </Text>
                        </Pressable>
                    </View>
                </View>
            ) : null}

            {state.latestToolResult ? (
                <View style={{
                    padding: 12,
                    borderRadius: 12,
                    backgroundColor: theme.colors.surfaceHigh,
                    borderWidth: 1,
                    borderColor: theme.colors.divider,
                    gap: 6,
                }}>
                    <Text style={{ color: theme.colors.text, fontWeight: '600' }}>{t('runs.runDetails.latestToolResultTitle')}</Text>
                    <Text style={{ color: theme.colors.textSecondary, fontFamily: 'Menlo' }}>
                        {JSON.stringify(state.latestToolResult, null, 2)}
                    </Text>
                </View>
            ) : null}

            {session && transcriptMessage?.kind === 'tool-call' ? (
                <SessionMessageDetailsView
                    sessionId={props.sessionId}
                    session={session}
                    message={transcriptMessage}
                    presentation={props.presentation}
                    showComposer={canShowSendComposer}
                />
            ) : null}
        </View>
    );

    if (props.presentation === 'panel') {
        return <View style={containerStyle}>{content}</View>;
    }

    return (
        <ConstrainedScreenContent style={{ flex: 1, paddingHorizontal: 16, paddingVertical: 16, gap: 12 }}>
            {content}
        </ConstrainedScreenContent>
    );
}));
