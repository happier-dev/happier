import * as React from 'react';
import { ActivityIndicator, Pressable, Text, TextInput, View } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

import type { ExecutionRunPublicState } from '@happier-dev/protocol';
import { sessionExecutionRunGet, sessionExecutionRunSend, sessionExecutionRunStop } from '@/sync/ops/sessionExecutionRuns';
import { machineExecutionRunsList } from '@/sync/ops/machineExecutionRuns';
import { storage } from '@/sync/domains/state/storage';
import { resolveServerIdForSessionIdFromLocalCache } from '@/sync/runtime/orchestration/serverScopedRpc/resolveServerIdForSessionIdFromLocalCache';
import { t } from '@/text';
import { renderExecutionRunStructuredMeta } from '@/components/sessions/runs/renderExecutionRunStructuredMeta';
import { ExecutionRunDetailsPanel } from '@/components/sessions/runs/ExecutionRunDetailsPanel';
import { ConstrainedScreenContent } from '@/components/ui/layout/ConstrainedScreenContent';

type LoadState =
    | { status: 'loading' }
    | { status: 'error'; error: string }
    | { status: 'loaded'; run: ExecutionRunPublicState; latestToolResult?: unknown; structuredMeta?: unknown };

function normalizeParam(value: unknown): string | null {
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
    if (Array.isArray(value) && typeof value[0] === 'string' && value[0].trim().length > 0) return value[0].trim();
    return null;
}

export default function SessionRunDetailsScreen() {
    const { theme } = useUnistyles();
    const params = useLocalSearchParams();
    const sessionId = normalizeParam((params as any)?.id);
    const runId = normalizeParam((params as any)?.runId);

    const [state, setState] = React.useState<LoadState>({ status: 'loading' });
    const [daemonProcessLine, setDaemonProcessLine] = React.useState<string | null>(null);
    const [sendText, setSendText] = React.useState('');
    const [sendError, setSendError] = React.useState<string | null>(null);
    const [stopError, setStopError] = React.useState<string | null>(null);
    const [isSending, setIsSending] = React.useState(false);
    const [isStopping, setIsStopping] = React.useState(false);
    const headerTint = theme.colors.header?.tint ?? theme.colors.text;

    const load = React.useCallback(async () => {
        if (!sessionId || !runId) {
            setState({ status: 'error', error: 'missing_params' });
            return;
        }
        setState({ status: 'loading' });
        setDaemonProcessLine(null);
        const res = await sessionExecutionRunGet(sessionId, { runId, includeStructured: true });
        if ((res as any)?.ok === false) {
            setState({ status: 'error', error: String((res as any).error ?? 'failed_to_load_run') });
            return;
        }
        const run = (res as any)?.run;
        if (!run || typeof run.runId !== 'string') {
            setState({ status: 'error', error: 'unsupported_response' });
            return;
        }
        setState({
            status: 'loaded',
            run,
            latestToolResult: (res as any).latestToolResult,
            structuredMeta: (res as any).structuredMeta,
        });

        // Best-effort: enrich run details with daemon-level process stats when available.
        // This is specifically useful for long-lived runs (voice agent), but can apply to any run.
        const machineId = (() => {
            const session = (storage.getState() as any)?.sessions?.[sessionId];
            const raw = session?.metadata?.machineId;
            return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : null;
        })();
        if (!machineId) return;
        const serverId = resolveServerIdForSessionIdFromLocalCache(sessionId);

        try {
            const listed = await machineExecutionRunsList(machineId, { ...(serverId ? { serverId } : {}) });
            if (!listed || (listed as any).ok !== true) return;
            const runs = (listed as any).runs as any[];
            const match = Array.isArray(runs) ? runs.find((r) => String(r?.runId ?? '') === runId) : null;
            const proc = match?.process;
            if (!proc || typeof proc !== 'object') return;
            const pid = typeof proc.pid === 'number' ? proc.pid : null;
            const cpu = typeof proc.cpu === 'number' ? proc.cpu : null;
            const memory = typeof proc.memory === 'number' ? proc.memory : null;

            const memMb = typeof memory === 'number' && Number.isFinite(memory) ? Math.round((memory / (1024 * 1024)) * 10) / 10 : null;
            const parts = [
                typeof pid === 'number' ? `pid ${pid}` : null,
                typeof cpu === 'number' ? `cpu ${cpu}` : null,
                typeof memMb === 'number' ? `mem ${memMb}MB` : null,
            ].filter(Boolean) as string[];
            if (parts.length > 0) setDaemonProcessLine(parts.join(' · '));
        } catch {
            // ignore best-effort daemon stats enrichment failures
        }
    }, [runId, sessionId]);

    React.useEffect(() => {
        void load();
    }, [load]);

    const structuredCard = React.useMemo(() => {
        if (state.status !== 'loaded') return null;
        if (!sessionId) return null;
        const meta = state.structuredMeta as any;
        if (!meta || typeof meta !== 'object') return null;
        const kind = typeof meta.kind === 'string' ? meta.kind : '';
        if (!kind) return null;
        return renderExecutionRunStructuredMeta({ meta: { kind, payload: meta.payload }, sessionId });
    }, [sessionId, state]);

    const headerRight = React.useCallback(() => (
        <Pressable
            accessibilityRole="button"
            accessibilityLabel="Refresh run"
            onPress={() => void load()}
            hitSlop={10}
            style={({ pressed }) => ({ padding: 4, opacity: pressed ? 0.7 : 1 })}
        >
            <Ionicons name="refresh" size={20} color={headerTint} />
        </Pressable>
    ), [headerTint, load]);

    const screenOptions = React.useMemo(() => ({
        headerShown: true,
        headerTitle: 'Run',
        headerRight,
    }), [headerRight]);

    return (
        <View style={{ flex: 1, backgroundColor: theme.colors.groupped?.background ?? theme.colors.surface }}>
            <Stack.Screen options={screenOptions} />
            <ConstrainedScreenContent style={{ flex: 1, paddingHorizontal: 16, paddingVertical: 16, gap: 12 }}>
            {state.status === 'loading' ? (
                <ActivityIndicator size="small" color={theme.colors.textSecondary} />
            ) : state.status === 'error' ? (
                <Text style={{ color: theme.colors.textSecondary }}>{state.error}</Text>
            ) : (
                <View style={{ gap: 10 }}>
                    <View style={{ gap: 4 }}>
                        <Text style={{ color: theme.colors.text, fontWeight: '600' }}>{state.run.runId}</Text>
                        <Text style={{ color: theme.colors.textSecondary }}>
                            {state.run.intent} · {state.run.status} · {state.run.backendId}
                        </Text>
                        <ExecutionRunDetailsPanel run={state.run} daemonProcessLine={daemonProcessLine} />
                    </View>

                    {structuredCard ? (
                        <View style={{ gap: 8 }}>
                            {structuredCard}
                        </View>
                    ) : null}

                    {state.run.status === 'running' ? (
                        <View style={{ gap: 8 }}>
                            {stopError ? <Text style={{ color: theme.colors.textSecondary }}>{stopError}</Text> : null}
                            <Pressable
                                accessibilityRole="button"
                                accessibilityLabel="Stop run"
                                onPress={() => {
                                    if (!sessionId || !runId) return;
                                    void (async () => {
                                        setStopError(null);
                                        setIsStopping(true);
                                        try {
                                            const res = await sessionExecutionRunStop(sessionId, { runId });
                                            if ((res as any)?.ok === false) {
                                                setStopError(String((res as any).error ?? 'Failed to stop run'));
                                            } else {
                                                await load();
                                            }
                                        } catch (e) {
                                            setStopError(e instanceof Error ? e.message : 'Failed to stop run');
                                        } finally {
                                            setIsStopping(false);
                                        }
                                    })();
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
                                    {isStopping ? 'Stopping…' : 'Stop run'}
                                </Text>
                            </Pressable>
                        </View>
                    ) : null}

                    {state.run.status === 'running' && (state.run as any).runClass === 'long_lived' ? (
                        <View style={{ gap: 8 }}>
                            {sendError ? <Text style={{ color: theme.colors.textSecondary }}>{sendError}</Text> : null}
                            <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
                                <TextInput
                                    value={sendText}
                                    onChangeText={setSendText}
                                    placeholder="Send to run…"
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
                                    accessibilityLabel="Send to run"
                                    onPress={() => {
                                        if (!sessionId || !runId) return;
                                        const msg = sendText.trim();
                                        if (!msg) return;
                                        void (async () => {
                                            setSendError(null);
                                            setIsSending(true);
                                            try {
                                                const res = await sessionExecutionRunSend(sessionId, { runId, message: msg });
                                                if ((res as any)?.ok === false) {
                                                    setSendError(String((res as any).error ?? 'Failed to send'));
                                                } else {
                                                    setSendText('');
                                                }
                                            } catch (e) {
                                                setSendError(e instanceof Error ? e.message : 'Failed to send');
                                            } finally {
                                                setIsSending(false);
                                            }
                                        })();
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
                                        {isSending ? 'Sending…' : 'Send'}
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
                            <Text style={{ color: theme.colors.text, fontWeight: '600' }}>latestToolResult</Text>
                            <Text style={{ color: theme.colors.textSecondary, fontFamily: 'Menlo' }}>
                                {JSON.stringify(state.latestToolResult, null, 2)}
                            </Text>
                        </View>
                    ) : null}
                </View>
            )}
            </ConstrainedScreenContent>
        </View>
    );
}
