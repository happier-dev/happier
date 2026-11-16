import { buildApprovalHref } from '@/components/approvals/approvalNavigation';
import * as React from 'react';
import { Pressable, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useUnistyles } from 'react-native-unistyles';


import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { ExecutionRunRow } from '@/components/sessions/runs/ExecutionRunRow';
import { readExecutionRunSessionAssociation } from '@/components/sessions/runs/readExecutionRunSessionAssociation';
import { aggregateMachineRunReads, executionRunMachineAddressKey, formatDaemonRunProcessFacts, selectMachineRunsForPresentation,
  summarizeRunListPresentation, machineRunReadFailureDetail, type MachineRunReadAggregate, type RunListUnavailableMachine } from '@/components/sessions/runs/runListPresentation';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { isAcceptedPendingSessionStop, readSessionStopActionResponse } from '@/components/sessions/sessionStopArchiveFlow';
import { ConstrainedScreenContent } from '@/components/ui/layout/ConstrainedScreenContent';
import { Modal } from '@/modal';
import { t } from '@/text';
import { showDaemonUnavailableAlert, tryShowDaemonUnavailableAlertForRpcFailure } from '@/utils/errors/daemonUnavailableAlert';
import { useAllProfileMachineInventorySnapshots } from '@/sync/domains/machines/useMachineInventorySnapshots';
import { filterVisibleMachines } from '@/sync/domains/machines/resolveServerScopedMachines';
import { formatMachineDisplayNameParts, resolveMachineDisplayNameParts } from '@/utils/sessions/machineDisplayNames';
import { CountedDisclosureItem } from '@/components/ui/lists/CountedDisclosureItem';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { machineExecutionRunsList, type MachineExecutionRunsListResult } from '@/sync/ops/machineExecutionRuns';
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
import { useOpenExecutionRunDetails } from '@/components/sessions/runs/useOpenExecutionRunDetails';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { machinePageHref } from '@/components/settings/machines/collection/machineCollectionModel';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';
import { subscribeMachineUpdates } from '@/sync/store/domains/machines';
import { useLayoutPresentationSignal } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';


type MachineRunsState =
  | { status: 'idle' }
  | { status: 'loading' }
  | MachineRunReadAggregate
  | { status: 'error'; error: string };

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

function unavailableMachineDetail(machine: RunListUnavailableMachine | undefined): string | undefined {
  return machine?.reason === 'read_failed' ? machineRunReadFailureDetail(machine.errorCode) : undefined;
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
  const openRunDetails = useOpenExecutionRunDetails();
  const routeParams = useLocalSearchParams<{
    serverId?: string | string[];
    machineId?: string | string[];
    runId?: string | string[];
  }>();
  const routeServerId = readExactRouteIdentity(routeParams.serverId);
  const routeMachineId = readExactRouteIdentity(routeParams.machineId);
  const routeRunId = readExactRouteIdentity(routeParams.runId);
  // A full address scopes the read. A bare Run id resolves through this
  // collection's admitted reads, and opens only when exactly one row matches.
  // Other partial or malformed addresses remain ordinary collection navigation.
  const requestedTarget = routeServerId && routeMachineId && routeRunId
    ? { serverId: routeServerId, machineId: routeMachineId, runId: routeRunId }
    : null;
  const requestedServerId = requestedTarget?.serverId ?? null;
  const requestedMachineId = requestedTarget?.machineId ?? null;
  const requestedRunId = requestedTarget?.runId
    ?? (routeParams.serverId === undefined && routeParams.machineId === undefined ? routeRunId : null);
  const shouldContinue = useMountedShouldContinue();
  const presentedSignal = useLayoutPresentationSignal();
  const inventory = useAllProfileMachineInventorySnapshots();
  const machineScopeBindings = useServerCredentialAccountScopeBindings(inventory.flatMap(snapshot =>
    snapshot.kind === 'resolved' ? [snapshot.serverIdentityId] : []));
  const [showFinished, setShowFinished] = React.useState(requestedRunId !== null);
  const [stoppingRunAddressKey, setStoppingRunAddressKey] = React.useState<string | null>(null);
  const [state, setState] = React.useState<MachineRunsState>({ status: 'idle' });
  const loadControllerRef = React.useRef<AbortController | null>(null);
  const openedRunAddressRef = React.useRef<string | null>(null);
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
        ? [{ serverId, machineId, accountId: binding.scope.accountId, role: machine.access?.role,
          automatic: requestedRunId !== null || isMachineReachable(binding.scope, machine) }]
        : [];
    });
  });
  // Presence timestamps and display metadata do not change a Run read's target
  // or authority. Keep the admitted read alive while those projections refresh.
  const nextMachineAddresses = serverEntries.flatMap(([serverId, machines]) =>
    machines.map(machine => ({ serverId, machineId: machine.id.trim() })));
  const readTargetsKey = JSON.stringify([requestedRunId, nextReadTargets, nextMachineAddresses]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const { readTargets, machineAddresses } = React.useMemo(() => ({
    readTargets: nextReadTargets, machineAddresses: nextMachineAddresses,
  }), [readTargetsKey]);

  const load = React.useCallback(async (intent?: 'retry', changedMachine?: Readonly<{ serverId: string; machineId: string }>) => {
    const targets = changedMachine ? readTargets.filter(target => target.serverId === changedMachine.serverId
      && target.machineId === changedMachine.machineId) : readTargets;
    if (changedMachine && targets.length === 0) return;
    // Push reads share this presentation's admitted lifetime; they do not cancel
    // another Machine's update or replace the list with a loading state.
    if (!changedMachine) loadControllerRef.current?.abort();
    const controller = changedMachine ? loadControllerRef.current : new AbortController();
    if (!controller || controller.signal.aborted) return;
    if (!changedMachine) {
      loadControllerRef.current = controller;
      setState({ status: 'loading' });
    }
    const addresses = changedMachine ? [changedMachine] : machineAddresses;

    const readsByMachineAddressKey: Record<string, MachineExecutionRunsListResult> = {};
    const retirements = [...new Set(targets.map(target => target.serverId))].flatMap(serverId => {
      const binding = machineScopeBindings.get(serverId);
      return binding ? [binding.onRetire(() => controller.abort())] : [];
    });

    try {
      await Promise.all(
        targets.map(async ({ serverId, machineId, accountId, automatic }) => {
          const binding = machineScopeBindings.get(serverId);
          if (!binding?.isCurrent() || binding.scope.accountId !== accountId) return;
          // Opening one exact Run is a user-requested read, like Refresh.
          // A previous request failure must not turn that navigation into an empty list.
          if (intent !== 'retry' && !changedMachine && !automatic) return;

          const res = await machineExecutionRunsList(machineId, { serverId, accountId, signal: controller.signal });
          if (!controller.signal.aborted && binding.isCurrent()) {
            readsByMachineAddressKey[executionRunMachineAddressKey(serverId, machineId)] = res;
          }
        }),
      );

      if (!controller.signal.aborted) setState(previous => aggregateMachineRunReads(addresses.map(address => ({
        ...address, result: readsByMachineAddressKey[executionRunMachineAddressKey(address.serverId, address.machineId)],
      })), changedMachine && 'unavailableMachines' in previous ? previous : undefined));
    } catch (error) {
      if (!controller.signal.aborted) {
        const message = error instanceof Error ? error.message : t('runs.failedToLoad');
        setState(previous => changedMachine ? aggregateMachineRunReads([
          { ...changedMachine, result: { ok: false, error: message } },
        ], 'unavailableMachines' in previous ? previous : undefined) : { status: 'error', error: message });
      }
    } finally {
      for (const retirement of retirements) retirement.dispose();
    }
  }, [machineScopeBindings, readTargets, machineAddresses]);

  React.useEffect(() => {
    // Presentation only starts and stops this work: a subscription, so a show/hide renders nothing here.
    const start = (presented: boolean): (() => void) | void => {
      if (!presented) return;
      void load();
      return () => loadControllerRef.current?.abort();
    };
    let current = presentedSignal.get();
    let stop = start(current);
    const unsubscribe = presentedSignal.subscribe(() => {
      if (presentedSignal.get() === current) return;
      current = presentedSignal.get();
      stop?.();
      stop = start(current);
    });
    return () => { unsubscribe(); stop?.(); };
  }, [load, presentedSignal]);

  React.useEffect(() => {
    // Presentation only starts and stops this work: a subscription, so a show/hide renders nothing here.
    const start = (presented: boolean): (() => void) | void => {
      if (!presented) return;
      return subscribeMachineUpdates((serverId, machineIds, facts) => {
        if (!facts?.workSummaryChanged) return;
        for (const machineId of machineIds) void load(undefined, { serverId, machineId });
      }, { workSummary: true });
    };
    let current = presentedSignal.get();
    let stop = start(current);
    const unsubscribe = presentedSignal.subscribe(() => {
      if (presentedSignal.get() === current) return;
      current = presentedSignal.get();
      stop?.();
      stop = start(current);
    });
    return () => { unsubscribe(); stop?.(); };
  }, [load, presentedSignal]);

  React.useEffect(() => {
    if (requestedRunId === null) {
      openedRunAddressRef.current = null;
      return;
    }
    if (state.status !== 'loaded') return;
    const matches = serverEntries.flatMap(([serverId, machines]) => machines.flatMap(machine => {
      const machineId = machine.id.trim();
      const runs = state.runsByMachineAddressKey[executionRunMachineAddressKey(serverId, machineId)] ?? [];
      return runs.filter(run => run.runId === requestedRunId).map(run => ({ serverId, machineId, run }));
    }));
    if (matches.length !== 1) return;
    const { serverId, machineId, run } = matches[0];
    const address = executionRunRowAddressKey(serverId, machineId, run.runId);
    if (openedRunAddressRef.current === address) return;
    openedRunAddressRef.current = address;
    const sessionId = readExecutionRunSessionAssociation(run);
    void openRunDetails({ serverId, machineId, runId: run.runId, sessionId });
  }, [openRunDetails, requestedRunId, serverEntries, state]);

  const headerRight = React.useCallback(() => {
    return (
      <HappierPressable
        accessibilityRole="button"
        accessibilityLabel={t('runs.a11y.refresh')}
        onPress={() => void load('retry')}
        style={({ pressed }) => ({ padding: theme.space.s4, opacity: pressed ? motionTokens.press.opacity : 1 })}
      >
        <Icon name="arrow-clockwise" size={20} color={headerTint} />
      </HappierPressable>
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

  const openMachine = (serverId: string, machineId: string) => {
    router.push(machinePageHref({ door: 'rail', target: { machineId, serverId: serverId || undefined } }) as never);
  };
  // Every visible Machine is either read (its rows, possibly none) or unknown; unknown is never zero.
  // Same-named machines on one Home are told apart by the machine name owner (as the Machines list does).
  const machineRunEntries = state.status !== 'loaded' ? [] : serverEntries.flatMap(([serverId, machines]) => {
    const names = resolveMachineDisplayNameParts(machines);
    return machines.map((machine) => {
      const machineId = String(machine?.id ?? '').trim();
      const addressKey = executionRunMachineAddressKey(serverId, machineId);
      const name = names.get(machine.id) ?? { name: t('runs.unknownMachine'), hint: null };
      return { serverId, machine, machineId, addressKey, name, runs: selectMachineRunsForPresentation({
        runs: state.runsByMachineAddressKey[addressKey], showFinished, requestedRunId,
      }) };
    });
  });
  const runsSummary = summarizeRunListPresentation(machineRunEntries.map(entry => entry.runs));
  const unavailableByAddressKey = new Map(state.status === 'loaded' ? state.unavailableMachines.map(machine =>
    [executionRunMachineAddressKey(machine.serverId, machine.machineId), machine] as const) : []);
  // A refused or failed read is a fact about that Machine, so it leads the quiet ones (nothing running).
  // A Machine that was not asked (offline when the page read) folds into one counted row: dozens of
  // offline machines must not bury the ones that answered.
  const otherMachineEntries = machineRunEntries.filter(entry => !entry.runs || entry.runs.length === 0);
  const notReadEntries = otherMachineEntries.filter(entry => unavailableByAddressKey.get(entry.addressKey)?.reason === 'not_read');
  const answeredEntries = otherMachineEntries.filter(entry => unavailableByAddressKey.get(entry.addressKey)?.reason !== 'not_read')
    .sort((a, b) => Number(unavailableByAddressKey.get(b.addressKey)?.reason === 'read_failed')
      - Number(unavailableByAddressKey.get(a.addressKey)?.reason === 'read_failed'));

  const renderMachineRow = ({ serverId, machineId, addressKey, name }: (typeof machineRunEntries)[number]) => (
    <Item
      key={addressKey}
      testID="runs.open-machine"
      title={name.name}
      titleQualifier={name.hint}
      subtitle={showsHomeNames
        ? t('detailPages.runs.onHome', { home: resolveHomeDisplayLabel(getServerProfileById(serverId), serverId) })
        : undefined}
      detail={unavailableMachineDetail(unavailableByAddressKey.get(addressKey))}
      icon={<Icon name="desktop" size={20} color={theme.colors.text.secondary} />}
      onPress={() => openMachine(serverId, machineId)}
    />
  );

  const screenOptions = React.useMemo(() => ({
    headerShown: true,
    headerTitle: t('runs.title'),
    headerRight,
  }), [headerRight]);

  return (
    <View style={{ flex: 1 }}>
      <Stack.Screen options={screenOptions} />
      <ConstrainedScreenContent style={{ flex: 1 }}>
        <ItemList>
          <PageHeader
            title={t('runs.title')}
            description={t('detailPages.runs.description')}
            // The filter decides what the page lists: it stays on the page on a phone, not in the overflow.
            actionsPlacement="page"
            actions={(
              <View style={{ width: 180 }}>
                <SegmentedTabBar
                  tabs={filterTabs}
                  activeTabId={showFinished ? 'all' : 'running'}
                  onSelectTab={onSelectFilter}
                  testIDPrefix="runs.filter"
                  accessibilityLabel={t('detailPages.runs.filterLabel')}
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
          ) : (<>
            {runsSummary.emptyState === 'empty' ? (
              <EmptyState
                layout="inline"
                iconName="play-circle"
                title={showFinished ? t('detailPages.runs.emptyAll') : t('detailPages.runs.emptyRunning')}
                subtitle={t('detailPages.runs.emptyDescription')}
                testID="runs.empty"
              />
            ) : null}
            {machineRunEntries.flatMap(({ serverId, machine, machineId, addressKey, name, runs }) => {
                if (!runs || runs.length === 0) return [];
                const homeName = showsHomeNames
                  ? resolveHomeDisplayLabel(getServerProfileById(serverId), serverId)
                  : null;
                return [(
                  <ItemGroup
                    key={addressKey}
                    title={formatMachineDisplayNameParts(name)}
                    description={homeName ? t('detailPages.runs.onHome', { home: homeName }) : undefined}
                    action={(
                      <SectionActionButton
                        testID="runs.open-machine"
                        title={t('runs.openMachine')}
                        destination
                        onPress={() => openMachine(serverId, machineId)}
                      />
                    )}
                  >
                    {runs.slice(0, 50).map((run) => {
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
                            machineId={machineId}
                            selected={run.runId === requestedRunId}
                            subtitle={formatDaemonRunProcessFacts(run)}
                            onPress={() => openRunDetails({ sessionId, serverId, machineId, runId: run.runId })}
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
                    })}
                  </ItemGroup>
                )];
            })}
            {otherMachineEntries.length > 0 ? (
              <ItemGroup
                title={otherMachineEntries.length < machineRunEntries.length
                  ? t('detailPages.runs.otherMachinesTitle') : t('detailPages.runs.machinesTitle')}
                description={runsSummary.unknownMachineCount > 0
                  ? t('detailPages.runs.uncheckedDescription', { count: runsSummary.unknownMachineCount }) : undefined}
              >
                {answeredEntries.map(renderMachineRow)}
                {notReadEntries.length > 0 ? (
                  <CountedDisclosureItem testID="runs.offline-machines" title={t('status.offline')} count={notReadEntries.length}>
                    {notReadEntries.map(renderMachineRow)}
                  </CountedDisclosureItem>
                ) : null}
              </ItemGroup>
            ) : null}
          </>)}
        </ItemList>
      </ConstrainedScreenContent>
    </View>
  );
}
