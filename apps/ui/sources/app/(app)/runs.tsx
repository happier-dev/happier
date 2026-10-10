import * as React from 'react';
import { Pressable, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useUnistyles } from 'react-native-unistyles';

import type { DaemonExecutionRunEntry } from '@happier-dev/protocol';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { ExecutionRunRow } from '@/components/sessions/runs/ExecutionRunRow';
import { readExecutionRunSessionAssociation } from '@/components/sessions/runs/readExecutionRunSessionAssociation';
import { ConstrainedScreenContent } from '@/components/ui/layout/ConstrainedScreenContent';
import { Modal } from '@/modal';
import { t } from '@/text';
import { tryShowDaemonUnavailableAlertForRpcFailure } from '@/utils/errors/daemonUnavailableAlert';
import { useAllProfileMachineInventorySnapshots } from '@/sync/domains/machines/useMachineInventorySnapshots';
import { filterVisibleMachines } from '@/sync/domains/machines/resolveServerScopedMachines';
import type { MachineDisplayRenderable } from '@/sync/domains/machines/machineDisplayRenderable';
import { machineExecutionRunsList } from '@/sync/ops/machineExecutionRuns';
import { sessionExecutionRunStop } from '@/sync/ops/sessionExecutionRuns';
import { machineStopSession } from '@/sync/ops/machines';
import { isMachineOnline } from '@/utils/sessions/machineUtils';
import { useMountedShouldContinue } from '@/hooks/ui/useMountedShouldContinue';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { Icon } from '@/components/ui/icons/Icon';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { resolveHomeDisplayName } from '@/components/settings/server/homeDisplayName';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';
import { buildScopedSessionRouteHref } from '@/hooks/session/sessionRouteServerScope';
import { motionTokens } from '@/components/ui/motion/motionTokens';


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
  const [showFinished, setShowFinished] = React.useState(requestedRunId !== null);
  const [stoppingRunAddressKey, setStoppingRunAddressKey] = React.useState<string | null>(null);
  const [state, setState] = React.useState<MachineRunsState>({ status: 'idle' });
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

  const load = React.useCallback(async () => {
    setState({ status: 'loading' });

    const runsByMachineAddressKey: Record<string, readonly DaemonExecutionRunEntry[]> = {};

    try {
      await Promise.all(
        serverEntries.flatMap(([serverId, machines]) => {
          return machines.map(async (machine) => {
            const machineId = String(machine?.id ?? '').trim();
            if (!machineId) return;
            if (!isMachineOnline(machine)) return;

            const res = await machineExecutionRunsList(machineId, { serverId });
            if (res.ok) {
              runsByMachineAddressKey[executionRunMachineAddressKey(serverId, machineId)] = res.runs;
            }
          });
        }),
      );

      setState({ status: 'loaded', runsByMachineAddressKey });
    } catch (error) {
      setState({ status: 'error', error: error instanceof Error ? error.message : t('runs.failedToLoad') });
    }
  }, [serverEntries]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const headerRight = React.useCallback(() => {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t('runs.a11y.refresh')}
        onPress={() => void load()}
        hitSlop={10}
        style={({ pressed }) => ({ padding: 4, opacity: pressed ? motionTokens.press.opacity : 1 })}
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
                  slidingThumb
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
            <ItemGroup>
              <Item title={t('runs.noMachinesAvailable')} showChevron={false} />
            </ItemGroup>
          ) : (
            serverEntries.flatMap(([serverId, machines]) => {
              if (!Array.isArray(machines) || machines.length === 0) return [];
              const homeName = showsHomeNames
                ? resolveHomeDisplayName(getServerProfileById(serverId)) ?? serverId
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
                        const query = serverId ? `?serverId=${encodeURIComponent(serverId)}` : '';
                        router.push(`/machine/${machineId}${query}` as any);
                      }}
                    />
                    {runs.length === 0 ? (
                      <Item title={t('runs.empty')} showChevron={false} />
                    ) : (
                      runs.slice(0, 50).map((run) => {
                        const sessionId = readExecutionRunSessionAssociation(run);
                        const canStop = run.status === 'running' && sessionId !== null;
                        const runAddressKey = executionRunRowAddressKey(serverId, machineId, run.runId);
                        const onStop = async () => {
                          if (!sessionId) return;
                          if (!canStop) return;
                          setStoppingRunAddressKey(runAddressKey);
                          const stopSessionProcess = async () => {
                            const stopResult = await machineStopSession(machineId, sessionId, { serverId });
                            if (stopResult.ok) return;

                            const shownDaemonUnavailable = tryShowDaemonUnavailableAlertForRpcFailure({
                              rpcErrorCode: stopResult.errorCode ?? null,
                              message: stopResult.error ?? null,
                              machine,
                              onRetry: () => {
                                void stopSessionProcess();
                              },
                              shouldContinue,
                            });
                            if (!shownDaemonUnavailable) {
                              Modal.alert(t('common.error'), stopResult.error || t('runs.stop.failedToStopSession'));
                            }
                          };
                          try {
                            const res = await sessionExecutionRunStop(sessionId, { runId: run.runId }, { serverId });
                            if ((res as any)?.ok === false) {
                              const confirmed = await Modal.confirm(
                                t('runs.stop.stopRunFailedTitle'),
                                t('runs.stop.stopRunFailedBody'),
                                { confirmText: t('runs.stop.stopSession'), cancelText: t('common.cancel'), destructive: true },
                              );
                              if (confirmed) {
                                await stopSessionProcess();
                              } else {
                                Modal.alert(t('common.error'), String((res as any).error ?? t('runs.stop.failedToStopRun')));
                              }
                            }
                          } catch (error) {
                            const confirmed = await Modal.confirm(
                              t('runs.stop.stopRunFailedTitle'),
                              t('runs.stop.stopRunFailedBody'),
                              { confirmText: t('runs.stop.stopSession'), cancelText: t('common.cancel'), destructive: true },
                            );
                            if (confirmed) {
                              await stopSessionProcess();
                            } else {
                              Modal.alert(t('common.error'), error instanceof Error ? error.message : t('runs.stop.failedToStopRun'));
                            }
                          } finally {
                            setStoppingRunAddressKey(null);
                            await load();
                          }
                        };

                        return (
                          <ExecutionRunRow
                            key={run.runId}
                            run={run as any}
                            selected={run.runId === requestedRunId}
                            subtitle={formatRunDetails(run)}
                            onPress={sessionId ? () => router.push(buildScopedSessionRouteHref({
                              sessionId,
                              serverId,
                              suffix: `/runs/${encodeURIComponent(run.runId)}`,
                            }) as any) : undefined}
                            rightAccessory={canStop ? (
                              <Pressable
                                accessibilityRole="button"
                                accessibilityLabel={t('runs.stop.stopRunA11y')}
                                onPress={onStop}
                                disabled={stoppingRunAddressKey === runAddressKey}
                                style={({ pressed }) => ({ opacity: pressed ? motionTokens.press.opacity : 1 })}
                              >
                                {stoppingRunAddressKey === runAddressKey ? (
                                  <ActivitySpinner size="small" color={theme.colors.text.secondary} />
                                ) : (
                                  <Icon name="stop-circle" size={20} color={theme.colors.accent.orange} />
                                )}
                              </Pressable>
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
