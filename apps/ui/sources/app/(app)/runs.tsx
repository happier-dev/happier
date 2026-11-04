import { buildApprovalHref } from '@/components/approvals/approvalNavigation';
import * as React from 'react';
import { Pressable, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useUnistyles } from 'react-native-unistyles';

import type { DaemonExecutionRunEntry } from '@happier-dev/protocol';

import { EmptyState } from '@/components/ui/empty/EmptyState';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { ExecutionRunRow } from '@/components/sessions/runs/ExecutionRunRow';
import { readExecutionRunSessionAssociation } from '@/components/sessions/runs/readExecutionRunSessionAssociation';
import { isAcceptedPendingSessionStop, readSessionStopActionResponse } from '@/components/sessions/sessionStopArchiveFlow';
import { ConstrainedScreenContent } from '@/components/ui/layout/ConstrainedScreenContent';
import { Modal } from '@/modal';
import { t } from '@/text';
import { showDaemonUnavailableAlert, tryShowDaemonUnavailableAlertForRpcFailure } from '@/utils/errors/daemonUnavailableAlert';
import { useAllProfileMachineInventorySnapshots } from '@/sync/domains/machines/useMachineInventorySnapshots';
import { filterVisibleMachines } from '@/sync/domains/machines/resolveServerScopedMachines';
import type { MachineDisplayRenderable } from '@/sync/domains/machines/machineDisplayRenderable';
import { machineExecutionRunsList } from '@/sync/ops/machineExecutionRuns';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { ActionApprovalPendingNotice } from '@/components/approvals/ActionApprovalPendingNotice';
import { isExecutionRunMutationCancelled } from '@/sync/ops/sessionExecutionRuns';
import { isMachineReachable } from '@/sync/domains/machines/reachability/machineReachability';
import { isMachineVisibleForLaunchSelection } from '@/sync/domains/machines/identity/filterVisibleMachines';
import { useServerCredentialAccountScopeBindings } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { useMountedShouldContinue } from '@/hooks/ui/useMountedShouldContinue';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { Icon } from '@/components/ui/icons/Icon';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { resolveHomeDisplayLabel } from '@/components/settings/server/homeDisplayName';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';
import { buildScopedSessionRouteHref } from '@/hooks/session/sessionRouteServerScope';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { machinePageHref } from '@/components/settings/machines/collection/machineCollectionModel';


type MachineRunsState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'loaded'; runsByMachineAddressKey: Record<string, readonly DaemonExecutionRunEntry[]> }
  | { status: 'error'; error: string };

/** Opaque Home-qualified machine identity. Never parse this key. */
function executionRunMachineAddressKey(serverId: string, machineId: string): string {
  return JSON.stringify([serverId, machineId]);
}

/** Exact pending-row identity for duplicate Run ids across Homes or machines. */
function executionRunRowAddressKey(serverId: string, machineId: string, runId: string): string {
  return JSON.stringify([serverId, machineId, runId]);
}

function readExactRouteIdentity(value: string | string[] | undefined): string | null {
  if (Array.isArray(value) && value.length !== 1) return null;
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw || raw !== raw.trim()) return null;
  return raw;
}

function getMachineTitle(machine: MachineDisplayRenderable): string {
  const displayName = typeof machine?.metadata?.displayName === 'string' ? machine.metadata.displayName.trim() : '';
  if (displayName) return displayName;
  const host = typeof machine?.metadata?.host === 'string' ? machine.metadata.host.trim() : '';
  if (host) return host;
  return String(machine?.id ?? t('runs.unknownMachine'));
}

function formatRunDetails(run: DaemonExecutionRunEntry): string {
  const sessionId = readExecutionRunSessionAssociation(run);
  const detailParts: string[] = [t('runs.detail.pid', { pid: run.pid })];
  if (sessionId) {
    detailParts.unshift(t('runs.sessionTitle', { sessionId }));
  }
  const cpu = (run as any).process?.cpu;
  const memory = (run as any).process?.memory;
  if (typeof cpu === 'number' && Number.isFinite(cpu)) {
    detailParts.push(t('runs.detail.cpu', { percent: cpu.toFixed(1) }));
  }
  if (typeof memory === 'number' && Number.isFinite(memory)) {
    detailParts.push(t('runs.detail.memory', { megabytes: Math.round(memory / (1024 * 1024)) }));
  }
  return `${t('runs.runLabel', { runId: run.runId })} · ${detailParts.join(' · ')}`;
}

/** Each collection row retains its own exact Home through admission and approval. */
function RunStopButton(props: Readonly<{
  serverId: string;
  stopping: boolean;
  spinnerColor: string;
  stopColor: string;
  onStop: (execution: ReturnType<typeof useMountedActionExecution>) => Promise<void>;
}>) {
  const execution = useMountedActionExecution(props.serverId);
  const router = useRouter();
  return (<>
    <Pressable accessibilityRole="button" accessibilityLabel={t('runs.stop.stopRunA11y')}
      onPress={() => props.onStop(execution)} disabled={props.stopping}
      style={({ pressed }) => ({ opacity: pressed ? motionTokens.press.opacity : 1 })}>
      {props.stopping ? <ActivitySpinner size="small" color={props.spinnerColor} />
        : <Icon name="stop-circle" size={20} color={props.stopColor} />}
    </Pressable>
    {execution.approval.approvalPending && execution.approval.approvalId ? (
      <ActionApprovalPendingNotice message={t('approvals.status.open')}
        onOpenApproval={() => router.push(buildApprovalHref(execution.approval.approvalId!, props.serverId))} />
    ) : null}
  </>);
}

export default function RunsScreen() {
  const { theme } = useUnistyles();
  const router = useRouter();
  const routeParams = useLocalSearchParams<{
    serverId?: string | string[];
    machineId?: string | string[];
    runId?: string | string[];
  }>();
  const routeServerId = readExactRouteIdentity(routeParams.serverId);
  const routeMachineId = readExactRouteIdentity(routeParams.machineId);
  const routeRunId = readExactRouteIdentity(routeParams.runId);
  // A daemon Run is only exact as one Home + Machine + Run tuple. Treat a
  // partial query as ordinary collection navigation so duplicate opaque ids on
  // another Home cannot be selected, revealed, or acted on by accident.
  const requestedTarget = routeServerId && routeMachineId && routeRunId
    ? { serverId: routeServerId, machineId: routeMachineId, runId: routeRunId }
    : null;
  const requestedServerId = requestedTarget?.serverId ?? null;
  const requestedMachineId = requestedTarget?.machineId ?? null;
  const requestedRunId = requestedTarget?.runId ?? null;
  const shouldContinue = useMountedShouldContinue();
  const inventory = useAllProfileMachineInventorySnapshots();
  const machineScopeBindings = useServerCredentialAccountScopeBindings(inventory.flatMap(snapshot =>
    snapshot.kind === 'resolved' ? [snapshot.serverIdentityId] : []));
  const [showFinished, setShowFinished] = React.useState(requestedRunId !== null);
  const [stoppingRunAddressKey, setStoppingRunAddressKey] = React.useState<string | null>(null);
  const [state, setState] = React.useState<MachineRunsState>({ status: 'idle' });
  const loadControllerRef = React.useRef<AbortController | null>(null);
  const headerTint = theme.colors.chrome.header.foreground ?? theme.colors.text.primary;

  React.useEffect(() => {
    if (requestedRunId !== null) setShowFinished(true);
  }, [requestedRunId]);

  const serverEntries = React.useMemo(() => {
    const entries = inventory.flatMap(snapshot => snapshot.kind === 'resolved'
      && snapshot.inventoryStatus !== 'signedOut'
      && (requestedServerId === null || snapshot.serverIdentityId === requestedServerId || snapshot.profileId === requestedServerId)
      ? [[
        snapshot.serverIdentityId,
        filterVisibleMachines(snapshot.machines).filter(machine => requestedMachineId === null || machine.id === requestedMachineId),
      ] as const] : []);
    entries.sort(([a], [b]) => a.localeCompare(b));
    return entries;
  }, [inventory, requestedMachineId, requestedServerId]);

  const nextReadTargets = serverEntries.flatMap(([serverId, machines]) => {
    const binding = machineScopeBindings.get(serverId);
    const snapshot = inventory.find(snapshot => snapshot.kind === 'resolved' && snapshot.serverIdentityId === serverId);
    if (!binding?.isCurrent() || snapshot?.kind !== 'resolved' || snapshot.observation !== 'live'
      || snapshot.accountId !== binding.scope.accountId) return [];
    return machines.flatMap(machine => {
      const machineId = machine.id.trim();
      return machineId && isMachineVisibleForLaunchSelection(machine) && machine.availability?.kind !== 'locked'
        ? [{ serverId, machineId, accountId: binding.scope.accountId,
          automatic: requestedRunId !== null || isMachineReachable(binding.scope, machine) }]
        : [];
    });
  });
  // Presence timestamps and display metadata do not change a Run read's target
  // or authority. Keep the admitted read alive while those projections refresh.
  const readTargetsKey = JSON.stringify([requestedRunId, nextReadTargets]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const readTargets = React.useMemo(() => nextReadTargets, [readTargetsKey]);

  const load = React.useCallback(async (intent?: 'retry') => {
    loadControllerRef.current?.abort();
    const controller = new AbortController();
    loadControllerRef.current = controller;
    setState({ status: 'loading' });

    const runsByMachineAddressKey: Record<string, readonly DaemonExecutionRunEntry[]> = {};
    const retirements = [...machineScopeBindings.values()].map(binding => binding.onRetire(() => controller.abort()));

    try {
      await Promise.all(
        readTargets.map(async ({ serverId, machineId, accountId, automatic }) => {
          const binding = machineScopeBindings.get(serverId);
          if (!binding?.isCurrent() || binding.scope.accountId !== accountId) return;
          // Opening one exact Run is a user-requested read, like Refresh.
          // A previous request failure must not turn that navigation into an empty list.
          if (intent !== 'retry' && !automatic) return;

          const res = await machineExecutionRunsList(machineId, { serverId, accountId, signal: controller.signal });
          if (!res.ok) throw new Error(res.error || t('runs.failedToLoad'));
          if (!controller.signal.aborted && binding.isCurrent()) {
            runsByMachineAddressKey[executionRunMachineAddressKey(serverId, machineId)] = res.runs;
          }
        }),
      );

      if (!controller.signal.aborted) setState({ status: 'loaded', runsByMachineAddressKey });
    } catch (error) {
      if (!controller.signal.aborted) setState({ status: 'error', error: error instanceof Error ? error.message : t('runs.failedToLoad') });
    } finally {
      for (const retirement of retirements) retirement.dispose();
    }
  }, [machineScopeBindings, readTargets]);

  React.useEffect(() => {
    void load();
    return () => loadControllerRef.current?.abort();
  }, [load]);

  const headerRight = React.useCallback(() => {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t('runs.a11y.refresh')}
        onPress={() => void load('retry')}
        hitSlop={10}
        style={({ pressed }) => ({ padding: theme.space.s4, opacity: pressed ? motionTokens.press.opacity : 1 })}
      >
        <Icon name="arrow-clockwise" size={20} color={headerTint} />
      </Pressable>
    );
  }, [headerTint, load]);

  const filterTabs = React.useMemo(() => ([
    { id: 'running' as const, label: t('detailPages.runs.filterRunning') },
    { id: 'all' as const, label: t('detailPages.runs.filterAll') },
  ]), []);
  const onSelectFilter = React.useCallback((tabId: 'running' | 'all') => {
    setShowFinished(tabId === 'all');
  }, []);
  // A Home is named only when runs from more than one Home share the page.
  const showsHomeNames = serverEntries.filter(([, machines]) => machines.length > 0).length > 1;

  const screenOptions = React.useMemo(() => ({
    headerShown: true,
    headerTitle: t('runs.title'),
    headerRight,
  }), [headerRight]);

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.surface.base }}>
      <Stack.Screen options={screenOptions} />
      <ConstrainedScreenContent style={{ flex: 1 }}>
        <ItemList>
          <PageHeader
            title={t('runs.title')}
            description={t('detailPages.runs.description')}
            actions={(
              <View style={{ width: 180 }}>
                <SegmentedTabBar
                  tabs={filterTabs}
                  activeTabId={showFinished ? 'all' : 'running'}
                  onSelectTab={onSelectFilter}
                  testIDPrefix="runs.filter"
                  accessibilityLabel={t('detailPages.runs.filterLabel')}
                  compact
                />
              </View>
            )}
          />
          {state.status === 'loading' ? (
            <ItemGroup>
              <Item
                title={t('common.loading')}
                showChevron={false}
                rightElement={<ActivitySpinner size="small" color={theme.colors.text.secondary} />}
              />
            </ItemGroup>
          ) : state.status === 'error' ? (
            <ItemGroup>
              <Item title={t('common.error')} subtitle={state.error} showChevron={false} />
            </ItemGroup>
          ) : !serverEntries.some(([, machines]) => machines.length > 0) ? (
            <ItemGroup surface="none">
              <EmptyState layout="line" title={t('runs.noMachinesAvailable')} primaryAction={{
                label: t('settings.addMachine'), testID: 'runs.no-machines.add', onPress: () => router.push('/settings/machines/add' as never),
              }} />
            </ItemGroup>
          ) : (
            serverEntries.flatMap(([serverId, machines]) => {
              if (!Array.isArray(machines) || machines.length === 0) return [];
              const homeName = showsHomeNames
                ? resolveHomeDisplayLabel(getServerProfileById(serverId), serverId)
                : null;

              return machines.map((machine) => {
                const machineId = String(machine?.id ?? '').trim();
                const title = getMachineTitle(machine);

                const rawRuns = (state.status === 'loaded'
                  ? state.runsByMachineAddressKey[executionRunMachineAddressKey(serverId, machineId)]
                  : null) ?? [];
                const visibleByStatus = showFinished ? rawRuns : rawRuns.filter((r) => r.status === 'running');
                const runs = requestedRunId === null
                  ? visibleByStatus
                  : visibleByStatus.filter((run) => run.runId === requestedRunId);

                return (
                  <ItemGroup
                    key={executionRunMachineAddressKey(serverId, machineId)}
                    title={title}
                    description={homeName ? t('detailPages.runs.onHome', { home: homeName }) : undefined}
                  >
                    <Item
                      testID="runs.open-machine"
                      title={t('runs.openMachine')}
                      onPress={() => {
                        router.push(machinePageHref({ door: 'rail', target: { machineId, serverId: serverId || undefined } }) as never);
                      }}
                    />
                    {runs.length === 0 ? (
                      <Item title={t('runs.empty')} showChevron={false} />
                    ) : (
                      runs.slice(0, 50).map((run) => {
                        const sessionId = readExecutionRunSessionAssociation(run);
                        const canStop = run.status === 'running';
                        const runAddressKey = executionRunRowAddressKey(serverId, machineId, run.runId);
                        const onStop = async (execution: ReturnType<typeof useMountedActionExecution>) => {
                          if (!canStop) return;
                          setStoppingRunAddressKey(runAddressKey);
                          let issued = false;
                          let refreshRuns = false;
                          const stopSessionProcess = async () => {
                            if (!sessionId) return;
                            if (!execution.isCurrent()) return;
                            const stopResult = await execution.execute('session.stop', { sessionId });
                            if (!execution.isCurrent() || isExecutionRunMutationCancelled(stopResult)) return;
                            const response = stopResult.ok ? readSessionStopActionResponse(stopResult.result) : null;
                            if (response && (response.success || isAcceptedPendingSessionStop(response))) return;
                            const error = stopResult.ok ? response?.message : stopResult.error;
                            const retryPresentation = {
                              machine,
                              onRetry: () => { void stopSessionProcess(); },
                              shouldContinue,
                            };
                            if (response?.recovery === 'retry_when_runtime_available') {
                              showDaemonUnavailableAlert({ ...retryPresentation,
                                titleKey: 'errors.daemonUnavailableTitle', bodyKey: 'errors.daemonUnavailableBody' });
                              return;
                            }

                            const shownDaemonUnavailable = tryShowDaemonUnavailableAlertForRpcFailure({
                              ...retryPresentation,
                              rpcErrorCode: stopResult.ok ? response?.code ?? null : stopResult.errorCode,
                              message: error ?? null,
                            });
                            if (!shownDaemonUnavailable) {
                              Modal.alert(t('common.error'), error || t('runs.stop.failedToStopSession'));
                            }
                          };
                          const showStopFailure = async (error: string) => {
                            if (!execution.isCurrent()) return;
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
                            if (!execution.isCurrent()) return;
                            if (stopSessionRequested) await stopSessionProcess();
                          };
                          try {
                            const res = await execution.execute('execution.run.stop', { sessionId, runId: run.runId },
                              { ...(sessionId === null ? { executionRunTargetMachineId: machineId } : {}),
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
                            setStoppingRunAddressKey(null);
                            if (refreshRuns && execution.isCurrent()) await load();
                          }
                        };

                        return (
                          <ExecutionRunRow
                            key={run.runId}
                            run={run as any}
                            serverId={serverId}
                            selected={run.runId === requestedRunId}
                            subtitle={formatRunDetails(run)}
                            onPress={sessionId ? () => router.push(buildScopedSessionRouteHref({
                              sessionId,
                              serverId,
                              suffix: `/runs/${encodeURIComponent(run.runId)}`,
                            }) as any) : undefined}
                            rightAccessory={canStop ? (
                              <RunStopButton
                                serverId={serverId}
                                onStop={onStop}
                                stopping={stoppingRunAddressKey === runAddressKey}
                                spinnerColor={theme.colors.text.secondary}
                                stopColor={theme.colors.accent.orange}
                              />
                            ) : null}
                          />
                        );
                      })
                    )}
                  </ItemGroup>
                );
              });
            })
          )}
        </ItemList>
      </ConstrainedScreenContent>
    </View>
  );
}
