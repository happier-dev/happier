import * as React from 'react';
import { Pressable } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import type { DaemonExecutionRunEntry } from '@happier-dev/protocol/daemon/executionRuns';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { ActionApprovalPendingNotice } from '@/components/approvals/ActionApprovalPendingNotice';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { ExecutionRunRow } from '@/components/sessions/runs/ExecutionRunRow';
import { readExecutionRunSessionAssociation } from '@/components/sessions/runs/readExecutionRunSessionAssociation';
import { formatDaemonRunProcessFacts } from '@/components/sessions/runs/runListPresentation';
import { isAcceptedPendingSessionStop, readSessionStopActionResponse } from '@/components/sessions/sessionStopArchiveFlow';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { Switch } from '@/components/ui/forms/Switch';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { useOpenExecutionRunDetails } from '@/components/sessions/runs/useOpenExecutionRunDetails';
import { useSessionRecordingVisibility } from '@/hooks/session/useSessionListRecordingPrivacy';
import { useNavigateToSession } from '@/hooks/session/useNavigateToSession';
import { useMountedShouldContinue } from '@/hooks/ui/useMountedShouldContinue';
import { Modal } from '@/modal';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { machineExecutionRunsList } from '@/sync/ops';
import { isExecutionRunMutationCancelled } from '@/sync/ops/sessionExecutionRuns';
import { t } from '@/text';
import { showDaemonUnavailableAlert, tryShowDaemonUnavailableAlertForRpcFailure } from '@/utils/errors/daemonUnavailableAlert';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { mergeAbortSignals } from '@/utils/runtime/abortSignals';
import { useSessionDisplayTitles } from '@/utils/sessions/sessionDisplayTitle';

type ExecutionRunsState =
    | { status: 'idle' | 'loading'; runs: readonly DaemonExecutionRunEntry[] }
    | { status: 'loaded'; runs: readonly DaemonExecutionRunEntry[] }
    | { status: 'error'; runs: readonly DaemonExecutionRunEntry[]; error: string };

/**
 * The processes sessions started on this machine (Project work), grouped by session, each stoppable
 * while it runs. Loads when the machine is reachable and again on the page's refresh; absent until
 * the machine has answered once.
 */
export const MachineRunsSection = React.memo(function MachineRunsSection(props: Readonly<{
    machine: Machine;
    serverId: string;
    online: boolean | null;
    /** The focused Home is switching to this machine's: no machine RPC until it settles. */
    isServerSwitching: boolean;
    /** Bumped by the page's refresh. */
    refreshKey: number;
}>) {
    const { theme } = useUnistyles();
    const router = useRouter();
    const openRunDetails = useOpenExecutionRunDetails();
    const shouldContinue = useMountedShouldContinue();
    const navigateToSession = useNavigateToSession();
    const { machine, online: isOnline, isServerSwitching } = props;
    const machineId = machine.id;
    const machineServerId = props.serverId;
    const stopExecution = useMountedActionExecution(machineServerId);
    const [executionRunsState, setExecutionRunsState] = React.useState<ExecutionRunsState>({ status: 'idle', runs: [] });
    const [showFinishedRuns, setShowFinishedRuns] = React.useState(false);
    const [stoppingRunId, setStoppingRunId] = React.useState<string | null>(null);
    const visibleRuns = React.useMemo(() => showFinishedRuns
        ? executionRunsState.runs
        : executionRunsState.runs.filter(run => run.status === 'running'), [executionRunsState.runs, showFinishedRuns]);
    const sessionAddresses = React.useMemo(() => Array.from(new Set(visibleRuns.flatMap(run => {
        const sessionId = readExecutionRunSessionAssociation(run);
        return sessionId === null ? [] : [sessionId];
    }))).map(sessionId => ({ sessionId, serverId: machineServerId })), [visibleRuns, machineServerId]);
    const sessionTitles = useSessionDisplayTitles(sessionAddresses);
    const isSessionVisible = useSessionRecordingVisibility();
    const sessionTitleById = new Map(sessionAddresses.map((address, index) => [address.sessionId, sessionTitles[index]]));
    const readLifetime = React.useMemo(() => ({ controller: new AbortController() }), [machineId, machineServerId]);
    React.useEffect(() => {
        if (readLifetime.controller.signal.aborted) readLifetime.controller = new AbortController();
        const controller = readLifetime.controller;
        return () => controller.abort();
    }, [readLifetime]);

    React.useEffect(() => {
        if (!machineId) return;
        if (!isOnline) return;
        if (isServerSwitching) return;

        const controller = new AbortController();
        setExecutionRunsState((prev) => ({ status: 'loading', runs: prev.runs }));
        fireAndForget((async () => {
            const res = await machineExecutionRunsList(machineId, { serverId: machineServerId, signal: controller.signal });
            if (controller.signal.aborted) return;
            if (res.ok) {
                setExecutionRunsState({ status: 'loaded', runs: res.runs });
            } else {
                setExecutionRunsState((prev) => ({ status: 'error', runs: prev.runs, error: res.error }));
            }
        })(), { tag: 'MachineRunsSection.fetchExecutionRuns' });

        return () => {
            controller.abort();
            // A load abandoned because the machine went offline (or the Home changed) has no answer
            // coming: leave "Loading…" rather than hold it forever. Loaded rows stay as they were.
            setExecutionRunsState((prev) => (prev.status === 'loading' ? { status: 'idle', runs: prev.runs } : prev));
        };
    }, [isOnline, isServerSwitching, machineId, machineServerId, machine.access?.role, props.refreshKey]);

    // On the Overview (MPG-8) Runs is there once the machine has some: no section, and no loading line, for a machine
    // that has none or whose first read is still out. A failed read still says so once.
    if (executionRunsState.runs.length === 0 && executionRunsState.status !== 'error') return null;
    return (
        <ItemGroup title={t('runs.title')} description={t('machineDetailPage.runsSectionDescription')}>
            {executionRunsState.runs.some((run) => run.status !== 'running') ? <Item
                title={t('runs.showFinished')}
                showChevron={false}
                rightElement={(
                    <Switch
                        value={showFinishedRuns}
                        onValueChange={setShowFinishedRuns}
                        disabled={executionRunsState.status === 'loading'}
                    />
                )}
            /> : null}
            {stopExecution.approval.approvalPending && stopExecution.approval.approvalId ? (
                <ActionApprovalPendingNotice testID="machine-run-stop-approval"
                    message={t('approvals.status.open')}
                    onOpenApproval={() => router.push(`/inbox/approvals/${encodeURIComponent(stopExecution.approval.approvalId!)}?serverId=${encodeURIComponent(machineServerId)}`)} />
            ) : null}
            {/* The section's states are the one in-sheet state line, like the Project work sections above it. A refresh
                keeps the runs it already shows. */}
            {executionRunsState.status === 'error' ? (
                <SurfaceStateCard testID="machine-runs-error" size="line" kind="error" title={t('machineDetailPage.runsLoadFailed')} reason={executionRunsState.error || undefined} />
            ) : visibleRuns.length === 0 ? (
                <SurfaceStateCard testID="machine-runs-empty" size="line" kind="empty" title={t('runs.empty')} />
            ) : (
                (() => {
                    const grouped = new Map<string | null, DaemonExecutionRunEntry[]>();
                    for (const run of visibleRuns) {
                        const key = readExecutionRunSessionAssociation(run);
                        const list = grouped.get(key) ?? [];
                        list.push(run);
                        grouped.set(key, list);
                    }
                    const orderedSessionIds = Array.from(grouped.keys()).sort((left, right) => {
                        if (left === null || right === null) {
                            if (left === right) return 0;
                            return left === null ? 1 : -1;
                        }
                        return left.localeCompare(right);
                    });

                    return orderedSessionIds.flatMap((sessionId) => {
                        const runs = grouped.get(sessionId) ?? [];
                        runs.sort((a, b) => (a.startedAtMs ?? 0) - (b.startedAtMs ?? 0));

                        const header = sessionId === null ? null : (
                            <Item
                                key={`sess-${sessionId}`}
                                title={isSessionVisible({ sessionId, serverId: machineServerId })
                                    ? sessionTitleById.get(sessionId) ?? t('session.untitled') : t('session.untitled')}
                                icon={<Icon name="chat-circle-dots" />}
                                subtitle={t('runs.openSession')}
                                subtitleStyle={{ color: theme.colors.text.secondary }}
                                onPress={() => navigateToSession(sessionId, { serverId: machineServerId })}
                                showChevron
                            />
                        );

                        const rows = runs.slice(0, 20).map((run) => {
                            const canStop = run.status === 'running';
                            const onStop = async () => {
                                if (!machineId) return;
                                if (!canStop) return;
                                setStoppingRunId(run.runId);
                                let issued = false;
                                let refreshRuns = false;
                                const stopSessionProcess = async () => {
                                    if (!sessionId) return;
                                    if (!stopExecution.isCurrent()) return;
                                    const stopResult = await stopExecution.execute('session.stop', { sessionId, stopIntent: 'lifecycle_control' });
                                    if (!stopExecution.isCurrent() || isExecutionRunMutationCancelled(stopResult)) return;
                                    const response = stopResult.ok ? readSessionStopActionResponse(stopResult.result) : null;
                                    if (response && (response.success || isAcceptedPendingSessionStop(response))) return;
                                    const errorCode = stopResult.ok ? response?.code ?? null : stopResult.errorCode;
                                    const error = stopResult.ok ? response?.message : stopResult.error;

                                    const retryPresentation = {
                                        machine,
                                        onRetry: () => {
                                            void stopSessionProcess();
                                        },
                                        shouldContinue,
                                    };
                                    if (response?.recovery === 'retry_when_runtime_available') {
                                        showDaemonUnavailableAlert({ ...retryPresentation,
                                            titleKey: 'errors.daemonUnavailableTitle', bodyKey: 'errors.daemonUnavailableBody' });
                                        return;
                                    }
                                    const shownDaemonUnavailable = tryShowDaemonUnavailableAlertForRpcFailure({
                                        ...retryPresentation, rpcErrorCode: errorCode, message: error,
                                    });
                                    if (!shownDaemonUnavailable) {
                                        Modal.alert(t('common.error'), error || t('runs.stop.failedToStopSession'));
                                    }
                                };
                                const showStopFailure = async (error: string) => {
                                    if (!stopExecution.isCurrent()) return;
                                    if (!issued || sessionId === null) {
                                        Modal.alert(t('common.error'), error);
                                        return;
                                    }
                                    let stopSessionRequested = false;
                                    await Modal.alertAsync(
                                        t('runs.stop.stopRunFailedTitle'),
                                        t('runs.stop.stopRunFailedBody'),
                                        [
                                            { text: t('common.cancel'), style: 'cancel' },
                                            { text: t('runs.stop.stopSession'), onPress: () => { stopSessionRequested = true; } },
                                        ],
                                    );
                                    if (!stopExecution.isCurrent()) return;
                                    if (stopSessionRequested) await stopSessionProcess();
                                };
                                try {
                                    const res = await stopExecution.execute('execution.run.stop',
                                        { sessionId, runId: run.runId }, { ...(sessionId === null ? { executionRunTargetMachineId: machineId } : {}),
                                            onTransportIssued: () => { issued = true; } });
                                    refreshRuns = res.ok || issued;
                                    if (!res.ok && !isExecutionRunMutationCancelled(res)) {
                                        await showStopFailure(res.error || t('runs.stop.failedToStopRun'));
                                    }
                                } catch (error) {
                                    refreshRuns = issued;
                                    if (!isExecutionRunMutationCancelled(error)) {
                                        await showStopFailure(error instanceof Error ? error.message : t('runs.stop.failedToStopRun'));
                                    }
                                } finally {
                                    setStoppingRunId(null);
                                    if (refreshRuns && stopExecution.isCurrent()) {
                                        const cancellation = mergeAbortSignals([readLifetime.controller.signal, stopExecution.getSignal()]);
                                        try {
                                            const refreshed = await machineExecutionRunsList(machineId, {
                                                serverId: machineServerId, signal: cancellation.signal,
                                            });
                                            if (refreshed.ok && !cancellation.signal.aborted && stopExecution.isCurrent()) {
                                                setExecutionRunsState({ status: 'loaded', runs: refreshed.runs });
                                            }
                                        } finally {
                                            cancellation.dispose();
                                        }
                                    }
                                }
                            };

                            return (
                                <ExecutionRunRow
                                    key={run.runId}
                                    run={run as any}
                                    serverId={machineServerId}
                                    subtitle={formatDaemonRunProcessFacts(run)}
                                    onPress={() => openRunDetails({ sessionId, serverId: machineServerId, machineId, runId: run.runId })}
                                    rightAccessory={canStop ? (
                                        <Pressable
                                            accessibilityRole="button"
                                            accessibilityLabel={t('runs.stop.stopRunA11y')}
                                            onPress={onStop}
                                            disabled={stoppingRunId === run.runId}
                                            style={({ pressed }) => ({
                                                opacity: pressed ? motionTokens.press.opacity : 1,
                                            })}
                                        >
                                            {stoppingRunId === run.runId ? (
                                                <ActivitySpinner size="small" color={theme.colors.text.secondary} />
                                            ) : (
                                                <Icon name="stop-circle" size={20} color={theme.colors.accent.orange} />
                                            )}
                                        </Pressable>
                                    ) : null}
                                />
                            );
                        });

                        return header ? [header, ...rows] : rows;
                    });
                })()
            )}
        </ItemGroup>
    );
});
