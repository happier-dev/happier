import * as React from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

import type { DaemonExecutionRunEntry } from '@happier-dev/protocol';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { ExecutionRunRow } from '@/components/sessions/runs/ExecutionRunRow';
import { Modal } from '@/modal';
import { t } from '@/text';
import { useMachineListByServerId, useMachineListStatusByServerId } from '@/sync/domains/state/storage';
import { machineExecutionRunsList } from '@/sync/ops/machineExecutionRuns';
import { sessionExecutionRunStop } from '@/sync/ops/sessionExecutionRuns';
import { machineStopSession } from '@/sync/ops/machines';
import { isMachineOnline } from '@/utils/sessions/machineUtils';

type MachineRunsState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'loaded'; runsByMachineId: Record<string, readonly DaemonExecutionRunEntry[]> }
  | { status: 'error'; error: string };

function getMachineTitle(machine: any): string {
  const displayName = typeof machine?.metadata?.displayName === 'string' ? machine.metadata.displayName.trim() : '';
  if (displayName) return displayName;
  const host = typeof machine?.metadata?.host === 'string' ? machine.metadata.host.trim() : '';
  if (host) return host;
  return String(machine?.id ?? 'Unknown machine');
}

function formatRunDetails(run: DaemonExecutionRunEntry): string {
  const detailParts: string[] = [`session ${run.happySessionId}`, `pid ${run.pid}`];
  const cpu = (run as any).process?.cpu;
  const memory = (run as any).process?.memory;
  if (typeof cpu === 'number' && Number.isFinite(cpu)) {
    detailParts.push(`${cpu.toFixed(1)}% cpu`);
  }
  if (typeof memory === 'number' && Number.isFinite(memory)) {
    detailParts.push(`${Math.round(memory / (1024 * 1024))} MB`);
  }
  return `run ${run.runId} · ${detailParts.join(' · ')}`;
}

export default function RunsScreen() {
  const { theme } = useUnistyles();
  const router = useRouter();
  const machineListByServerId = useMachineListByServerId();
  const machineListStatusByServerId = useMachineListStatusByServerId();
  const [showFinished, setShowFinished] = React.useState(false);
  const [stoppingRunId, setStoppingRunId] = React.useState<string | null>(null);
  const [state, setState] = React.useState<MachineRunsState>({ status: 'idle' });

  const serverEntries = React.useMemo(() => {
    const entries = Object.entries(machineListByServerId ?? {})
      .filter(([serverId, machines]) => typeof serverId === 'string' && serverId.trim().length > 0 && Array.isArray(machines));
    entries.sort(([a], [b]) => a.localeCompare(b));
    return entries as Array<[string, any[]]>;
  }, [machineListByServerId]);

  const load = React.useCallback(async () => {
    setState({ status: 'loading' });

    const runsByMachineId: Record<string, readonly DaemonExecutionRunEntry[]> = {};

    try {
      await Promise.all(
        serverEntries.flatMap(([serverId, machines]) => {
          const serverStatus = machineListStatusByServerId?.[serverId] ?? 'idle';
          if (serverStatus === 'signedOut') return [];

          return machines.map(async (machine) => {
            const machineId = String(machine?.id ?? '').trim();
            if (!machineId) return;
            if (!isMachineOnline(machine)) return;

            const res = await machineExecutionRunsList(machineId, { serverId });
            if (res.ok) {
              runsByMachineId[machineId] = res.runs;
            }
          });
        }),
      );

      setState({ status: 'loaded', runsByMachineId });
    } catch (error) {
      setState({ status: 'error', error: error instanceof Error ? error.message : 'Failed to load runs' });
    }
  }, [machineListStatusByServerId, serverEntries]);

  React.useEffect(() => {
    void load();
  }, [load]);

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.surface }}>
      <View style={{ padding: 16, gap: 12 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <Text style={{ color: theme.colors.text, fontSize: 18, fontWeight: '600' }}>
            {t('runs.title') ?? 'Runs'}
          </Text>
          <Pressable onPress={() => void load()} accessibilityRole="button" accessibilityLabel="Refresh runs">
            <Text style={{ color: theme.colors.textSecondary }}>{t('common.refresh') ?? 'Refresh'}</Text>
          </Pressable>
        </View>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Toggle finished runs"
          onPress={() => setShowFinished((v) => !v)}
          style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
        >
          <Text style={{ color: theme.colors.textSecondary }}>
            {showFinished ? 'Showing finished runs' : 'Showing running runs'}
          </Text>
        </Pressable>
      </View>

      <ItemList style={{ paddingTop: 0 }}>
        {state.status === 'loading' ? (
          <Item
            title={t('common.loading')}
            showChevron={false}
            rightElement={<ActivityIndicator size="small" color={theme.colors.textSecondary} />}
          />
        ) : state.status === 'error' ? (
          <Item title={t('common.error')} subtitle={state.error} showChevron={false} />
        ) : serverEntries.length === 0 ? (
          <Item title={t('status.unknown')} subtitle="No machines available." showChevron={false} />
        ) : (
          serverEntries.flatMap(([serverId, machines]) => {
            if (!Array.isArray(machines) || machines.length === 0) return [];
            const header = (
              <Item
                key={`server:${serverId}`}
                title={`Server ${serverId}`}
                subtitle="Machines"
                showChevron={false}
              />
            );

            const machineGroups = machines.map((machine) => {
              const machineId = String(machine?.id ?? '').trim();
              const title = getMachineTitle(machine);

              const rawRuns = (state.status === 'loaded' ? state.runsByMachineId[machineId] : null) ?? [];
              const runs = showFinished ? rawRuns : rawRuns.filter((r) => r.status === 'running');

              return (
                <ItemGroup key={`machine:${serverId}:${machineId}`} title={title}>
                  <Item
                    title={machineId}
                    subtitle="Open machine"
                    subtitleStyle={{ color: theme.colors.textSecondary, fontFamily: 'Menlo' as any, fontSize: 12 }}
                    rightElement={<Ionicons name="chevron-forward" size={18} color={theme.colors.textSecondary} />}
                    onPress={() => {
                      const query = serverId ? `?serverId=${encodeURIComponent(serverId)}` : '';
                      router.push(`/machine/${machineId}${query}` as any);
                    }}
                  />
                  {runs.length === 0 ? (
                    <Item title={t('runs.empty')} subtitle={t('runs.empty') ?? 'No runs yet.'} showChevron={false} />
                  ) : (
                    runs.slice(0, 50).map((run) => {
                      const canStop = run.status === 'running';
                      const onStop = async () => {
                        if (!canStop) return;
                        setStoppingRunId(run.runId);
                        try {
                          const res = await sessionExecutionRunStop(run.happySessionId, { runId: run.runId }, { serverId });
                          if ((res as any)?.ok === false) {
                            const confirmed = await Modal.confirm(
                              'Stop run failed',
                              'Stopping this run via session RPC failed. Do you want to stop the entire session process instead? This is destructive and will stop all runs in that session.',
                              { confirmText: 'Stop session', cancelText: 'Cancel', destructive: true },
                            );
                            if (confirmed) {
                              const stopResult = await machineStopSession(machineId, run.happySessionId, { serverId });
                              if (!stopResult.ok) {
                                Modal.alert(t('common.error'), stopResult.error || 'Failed to stop session');
                              }
                            } else {
                              Modal.alert(t('common.error'), String((res as any).error ?? 'Failed to stop run'));
                            }
                          }
                        } catch (error) {
                          const confirmed = await Modal.confirm(
                            'Stop run failed',
                            'Stopping this run via session RPC failed. Do you want to stop the entire session process instead? This is destructive and will stop all runs in that session.',
                            { confirmText: 'Stop session', cancelText: 'Cancel', destructive: true },
                          );
                          if (confirmed) {
                            const stopResult = await machineStopSession(machineId, run.happySessionId, { serverId });
                            if (!stopResult.ok) {
                              Modal.alert(t('common.error'), stopResult.error || 'Failed to stop session');
                            }
                          } else {
                            Modal.alert(t('common.error'), error instanceof Error ? error.message : 'Failed to stop run');
                          }
                        } finally {
                          setStoppingRunId(null);
                          await load();
                        }
                      };

                      return (
                        <ExecutionRunRow
                          key={run.runId}
                          run={run as any}
                          subtitle={formatRunDetails(run)}
                          onPress={() => router.push(`/session/${run.happySessionId}/runs/${run.runId}` as any)}
                          rightAccessory={canStop ? (
                            <Pressable
                              accessibilityRole="button"
                              accessibilityLabel="Stop run"
                              onPress={onStop}
                              disabled={stoppingRunId === run.runId}
                              style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
                            >
                              {stoppingRunId === run.runId ? (
                                <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                              ) : (
                                <Ionicons name="stop-circle-outline" size={20} color="#FF9500" />
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

            return [header, ...machineGroups];
          })
        )}
      </ItemList>
    </View>
  );
}
