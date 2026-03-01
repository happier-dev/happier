import * as React from 'react';
import { Platform, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import Constants from 'expo-constants';
import { useRouter } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';
import {
  DoctorSnapshotSchema,
  sanitizeBugReportUrl,
  sanitizeDoctorSnapshotUrls,
  type DoctorSnapshot,
} from '@happier-dev/protocol';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { Text } from '@/components/ui/text/Text';
import { layout } from '@/components/ui/layout/layout';
import { Modal } from '@/modal';
import { useHappyAction } from '@/hooks/ui/useHappyAction';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { listServerProfiles, type ServerProfile } from '@/sync/domains/server/serverProfiles';
import {
  useAllMachines,
  useIsDataReady,
  useLastSyncAt,
  useMachineListByServerId,
  useMachineListStatusByServerId,
  useProfile,
  useRealtimeStatus,
  useSocketStatus,
} from '@/sync/domains/state/storage';
import { machineCollectBugReportDiagnostics } from '@/sync/ops/machines';
import { t } from '@/text';
import { isMachineOnline } from '@/utils/sessions/machineUtils';
import { fireAndForget } from '@/utils/system/fireAndForget';

import { readCachedMachineDoctorSnapshot, writeCachedMachineDoctorSnapshot } from './cache/machineDoctorSnapshotCache';

type MachineDoctorFetchStatus =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; snapshot: DoctorSnapshot; cachedAt: number; source: 'rpc' | 'cache' }
  | { status: 'error'; detail: string };

function formatRelativeTimeMs(ms: number | null | undefined): string {
  if (!ms) return t('status.unknown');
  const deltaSec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (deltaSec < 60) return t('systemStatus.time.secondsAgo', { count: deltaSec });
  const deltaMin = Math.floor(deltaSec / 60);
  if (deltaMin < 60) return t('systemStatus.time.minutesAgo', { count: deltaMin });
  const deltaHr = Math.floor(deltaMin / 60);
  if (deltaHr < 48) return t('systemStatus.time.hoursAgo', { count: deltaHr });
  const deltaDays = Math.floor(deltaHr / 24);
  return t('systemStatus.time.daysAgo', { count: deltaDays });
}

function resolveMachineDisplayName(params: Readonly<{ host?: string; displayName?: string | null }>): string {
  const displayName = String(params.displayName ?? '').trim();
  if (displayName) return displayName;
  const host = String(params.host ?? '').trim();
  if (host) return host;
  return t('systemStatus.machine.unknownHost');
}

function resolveServerProfileLabel(profile: ServerProfile): string {
  const name = String(profile.name ?? '').trim();
  return name || profile.id || profile.serverUrl;
}

export const SystemStatusView = React.memo(function SystemStatusView() {
  const router = useRouter();
  const { theme } = useUnistyles();

  const activeServerSnapshot = getActiveServerSnapshot();
  const activeServerUrl = React.useMemo(
    () => sanitizeBugReportUrl(activeServerSnapshot.serverUrl) ?? activeServerSnapshot.serverUrl,
    [activeServerSnapshot.serverUrl],
  );

  const profile = useProfile();
  const isDataReady = useIsDataReady();
  const realtimeStatus = useRealtimeStatus();
  const socket = useSocketStatus();
  const lastSyncAt = useLastSyncAt();

  const machines = useAllMachines();
  const machineListByServerId = useMachineListByServerId();
  const machineListStatusByServerId = useMachineListStatusByServerId();

  const serverProfiles = React.useMemo(() => {
    try {
      return listServerProfiles().slice();
    } catch {
      return [];
    }
  }, [activeServerSnapshot.generation]);

  const machineServerIdByMachineId = React.useMemo(() => {
    const map = new Map<string, string>();
    for (const [serverId, list] of Object.entries(machineListByServerId)) {
      if (!Array.isArray(list)) continue;
      for (const machine of list) map.set(machine.id, serverId);
    }
    return map;
  }, [machineListByServerId]);

  const [doctorFetchByMachineId, setDoctorFetchByMachineId] = React.useState<Record<string, MachineDoctorFetchStatus>>(() => ({}));

  const seedCachedDoctorSnapshots = React.useCallback(() => {
    const next: Record<string, MachineDoctorFetchStatus> = {};
    for (const [machineId, serverId] of machineServerIdByMachineId.entries()) {
      const cached = readCachedMachineDoctorSnapshot({ serverId, machineId });
      if (!cached) continue;
      next[machineId] = {
        status: 'ready',
        snapshot: cached.snapshot,
        cachedAt: cached.cachedAt,
        source: 'cache',
      };
    }
    setDoctorFetchByMachineId((prev) => ({ ...next, ...prev }));
  }, [machineServerIdByMachineId]);

  React.useEffect(() => {
    seedCachedDoctorSnapshots();
  }, [seedCachedDoctorSnapshots]);

  const fetchDoctorSnapshotForMachine = React.useCallback(async (params: { machineId: string; serverId: string; timeoutMs: number }) => {
    setDoctorFetchByMachineId((prev) => ({
      ...prev,
      [params.machineId]: { status: 'loading' },
    }));

    const diagnostics = await machineCollectBugReportDiagnostics(params.machineId, { timeoutMs: params.timeoutMs });
    const rawDoctorSnapshot = (diagnostics as { doctorSnapshot?: unknown } | null)?.doctorSnapshot;
    const parsed = DoctorSnapshotSchema.safeParse(rawDoctorSnapshot);
    if (!parsed.success) {
      setDoctorFetchByMachineId((prev) => ({
        ...prev,
        [params.machineId]: { status: 'error', detail: t('systemStatus.machine.fetchDoctorSnapshot.invalid') },
      }));
      return;
    }

    const snapshot = sanitizeDoctorSnapshotUrls(parsed.data);
    const cachedAt = Date.now();
    writeCachedMachineDoctorSnapshot({ serverId: params.serverId, machineId: params.machineId, cachedAt, snapshot });

    setDoctorFetchByMachineId((prev) => ({
      ...prev,
      [params.machineId]: { status: 'ready', snapshot, cachedAt, source: 'rpc' },
    }));
  }, []);

  const [refreshingMachines, refreshMachineAttribution] = useHappyAction(async () => {
    const serverMachines = Array.isArray(machineListByServerId[activeServerSnapshot.serverId])
      ? (machineListByServerId[activeServerSnapshot.serverId] ?? [])
      : [];
    const online = serverMachines.filter((m) => isMachineOnline(m)).slice(0, 3);
    for (const machine of online) {
      // Sequential to avoid creating bursts of RPCs.
      await fetchDoctorSnapshotForMachine({
        machineId: machine.id,
        serverId: activeServerSnapshot.serverId,
        timeoutMs: 4_000,
      });
    }
  });

  const [copying, copySystemStatusJson] = useHappyAction(async () => {
    const payload = {
      capturedAt: new Date().toISOString(),
      environment: {
        appVersion: Constants.expoConfig?.version ?? 'unknown',
        platform: Platform.OS,
        osVersion: typeof Platform.Version === 'string' ? Platform.Version : String(Platform.Version ?? ''),
        deviceModel: Constants.deviceName ?? undefined,
      },
      ui: {
        isDataReady,
        realtimeStatus,
        socketStatus: socket.status,
        socketLastError: socket.lastError,
        socketLastErrorAt: socket.lastErrorAt,
        lastSyncAt,
      },
      activeServer: {
        ...activeServerSnapshot,
        serverUrl: activeServerUrl,
      },
      profile: profile
        ? {
          id: profile.id,
          username: profile.username,
          connectedServices: profile.connectedServices ?? [],
        }
        : null,
      serverProfiles: serverProfiles.map((p) => ({
        id: p.id,
        name: p.name,
        source: p.source ?? null,
        serverUrl: sanitizeBugReportUrl(p.serverUrl) ?? p.serverUrl,
        lastUsedAt: p.lastUsedAt,
      })),
      machines: machines.map((m) => ({
        id: m.id,
        serverId: machineServerIdByMachineId.get(m.id) ?? null,
        active: m.active,
        activeAt: m.activeAt,
        updatedAt: m.updatedAt,
        metadata: m.metadata
          ? {
            host: m.metadata.host,
            platform: m.metadata.platform,
            arch: m.metadata.arch ?? null,
            username: m.metadata.username ?? null,
            displayName: m.metadata.displayName ?? null,
            happyCliVersion: m.metadata.happyCliVersion,
            happyHomeDirBasename: String(m.metadata.happyHomeDir ?? '').split('/').filter(Boolean).slice(-1)[0] ?? '',
          }
          : null,
        doctorSnapshot: (() => {
          const entry = doctorFetchByMachineId[m.id];
          if (!entry || entry.status !== 'ready') return null;
          return { cachedAt: entry.cachedAt, source: entry.source, snapshot: entry.snapshot };
        })(),
      })),
      machineListStatusByServerId,
    };

    await Clipboard.setStringAsync(JSON.stringify(payload, null, 2));
    Modal.alert(t('common.copied'), t('items.copiedToClipboard', { label: t('settings.systemStatus') }));
  });

  React.useEffect(() => {
    // Best-effort: warm cached attribution into the UI, then refresh a few online machines.
    refreshMachineAttribution();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeServerSnapshot.serverId]);

  const machineGroups = React.useMemo(() => {
    const ids = new Set<string>();
    ids.add(activeServerSnapshot.serverId);
    for (const id of Object.keys(machineListByServerId)) ids.add(id);
    for (const sp of serverProfiles) ids.add(sp.id);
    return Array.from(ids);
  }, [activeServerSnapshot.serverId, machineListByServerId, serverProfiles]);

  const serverProfileById = React.useMemo(() => {
    const map = new Map<string, ServerProfile>();
    for (const p of serverProfiles) map.set(p.id, p);
    return map;
  }, [serverProfiles]);

  const openDiagnosis = React.useCallback(() => {
    router.push('/(app)/settings/diagnosis');
  }, [router]);

  return (
    <ItemList style={{ paddingTop: 0 }} testID="system-status-screen">
      <React.Fragment>
        <ItemGroup title={t('systemStatus.sections.appHealth')}>
          <Item
            title={t('systemStatus.ui.dataReady')}
            detail={isDataReady ? t('common.yes') : t('common.no')}
            icon={<Ionicons name="pulse-outline" size={24} color={theme.colors.accent.indigo} />}
          />
          <Item
            title={t('systemStatus.ui.realtime')}
            detail={String(realtimeStatus)}
            icon={<Ionicons name="wifi-outline" size={24} color={theme.colors.accent.blue} />}
          />
          <Item
            title={t('systemStatus.ui.socket')}
            detail={String(socket.status)}
            subtitle={
              socket.lastError
                ? <Text style={{ color: theme.colors.textSecondary }}>{t('systemStatus.ui.socketLastError', { error: socket.lastError })}</Text>
                : undefined
            }
            icon={<Ionicons name="cloud-outline" size={24} color={theme.colors.accent.blue} />}
          />
          <Item
            title={t('systemStatus.ui.lastSync')}
            detail={lastSyncAt ? new Date(lastSyncAt).toLocaleString() : t('status.unknown')}
            icon={<Ionicons name="time-outline" size={24} color={theme.colors.accent.orange} />}
          />
        </ItemGroup>

        <ItemGroup title={t('systemStatus.sections.currentServer')}>
          <Item
            title={t('systemStatus.server.activeServer')}
            subtitle={<Text style={{ color: theme.colors.textSecondary }}>{activeServerUrl || t('status.unknown')}</Text>}
            detail={activeServerSnapshot.serverId}
            icon={<Ionicons name="server-outline" size={24} color={theme.colors.accent.blue} />}
            onPress={() => router.push('/server')}
          />
        </ItemGroup>

        <ItemGroup title={t('systemStatus.sections.identity')}>
          <Item
            title={t('systemStatus.identity.accountId')}
            detail={profile?.id ?? t('status.unknown')}
            icon={<Ionicons name="person-outline" size={24} color={theme.colors.accent.purple} />}
            copy={profile?.id ?? false}
          />
          <Item
            title={t('systemStatus.identity.username')}
            detail={profile?.username ?? t('status.unknown')}
            icon={<Ionicons name="at-outline" size={24} color={theme.colors.accent.purple} />}
            copy={profile?.username ?? false}
          />
        </ItemGroup>

        <ItemGroup title={t('systemStatus.sections.configuredServers')}>
          {serverProfiles.length === 0 ? (
            <Item
              title={t('systemStatus.servers.noneConfigured')}
              icon={<Ionicons name="server-outline" size={24} color={theme.colors.textSecondary} />}
              disabled
            />
          ) : serverProfiles.map((p) => (
            <Item
              key={p.id}
              title={resolveServerProfileLabel(p)}
              subtitle={<Text style={{ color: theme.colors.textSecondary }}>{sanitizeBugReportUrl(p.serverUrl) ?? p.serverUrl}</Text>}
              detail={p.id === activeServerSnapshot.serverId ? t('systemStatus.servers.active') : p.id}
              icon={<Ionicons name="server-outline" size={24} color={p.id === activeServerSnapshot.serverId ? theme.colors.success : theme.colors.accent.blue} />}
              copy
            />
          ))}
        </ItemGroup>

        <View style={{ maxWidth: layout.maxWidth, alignSelf: 'center', width: '100%' }}>
          {machineGroups.map((serverId) => {
            const list = machineListByServerId[serverId];
            const serverProfile = serverProfileById.get(serverId);
            const title = serverId === activeServerSnapshot.serverId
              ? t('systemStatus.sections.machinesActiveServer')
              : t('systemStatus.sections.machinesOtherServer', { server: serverProfile?.name ?? serverId });

            const status = machineListStatusByServerId[serverId];
            const showStatusSubtitle = typeof status === 'string' && status !== 'idle';
            const statusSubtitle = showStatusSubtitle ? t('systemStatus.machines.status', { status }) : undefined;

            if (!Array.isArray(list) || list.length === 0) {
              return (
                <ItemGroup
                  key={serverId}
                  title={title}
                  footer={statusSubtitle}
                >
                  <Item
                    title={t('systemStatus.machines.none')}
                    icon={<Ionicons name="laptop-outline" size={24} color={theme.colors.textSecondary} />}
                    disabled
                  />
                </ItemGroup>
              );
            }

            return (
              <ItemGroup
                key={serverId}
                title={title}
                footer={statusSubtitle}
              >
                {list.map((machine) => {
                  const meta = machine.metadata;
                  const displayName = resolveMachineDisplayName({
                    host: meta?.host,
                    displayName: meta?.displayName ?? null,
                  });
                  const online = isMachineOnline(machine);

                  const fetchEntry = doctorFetchByMachineId[machine.id] ?? { status: 'idle' as const };
                  const doctorRow = (() => {
                    if (fetchEntry.status === 'loading') {
                      return <Text style={{ color: theme.colors.textSecondary }}>{t('systemStatus.machine.fetchDoctorSnapshot.loading')}</Text>;
                    }
                    if (fetchEntry.status === 'error') {
                      return <Text style={{ color: theme.colors.warningCritical }}>{fetchEntry.detail}</Text>;
                    }
                    if (fetchEntry.status === 'ready') {
                      const daemonServerUrl = fetchEntry.snapshot.server.serverUrl;
                      const daemonAccountId = fetchEntry.snapshot.accountId ?? t('status.unknown');
                      const serverMismatch = activeServerUrl && daemonServerUrl && daemonServerUrl !== activeServerUrl;
                      const accountMismatch = profile?.id && fetchEntry.snapshot.accountId && fetchEntry.snapshot.accountId !== profile.id;

                      const mismatchLabel = serverMismatch || accountMismatch ? ` • ${t('systemStatus.mismatch')}` : '';
                      return (
                        <Text style={{ color: serverMismatch || accountMismatch ? theme.colors.warningCritical : theme.colors.textSecondary }}>
                          {t('systemStatus.machine.daemonAttribution', { serverUrl: daemonServerUrl, accountId: daemonAccountId })}
                          {mismatchLabel}
                          {'\n'}
                          {t('systemStatus.machine.daemonAttributionAge', { age: formatRelativeTimeMs(fetchEntry.cachedAt) })}
                        </Text>
                      );
                    }
                    return (
                      <Text style={{ color: theme.colors.textSecondary }}>
                        {t('systemStatus.machine.daemonAttributionUnknown')}
                      </Text>
                    );
                  })();

                  const subtitle = (
                    <View>
                      <Text style={{ color: online ? theme.colors.success : theme.colors.textSecondary }}>
                        {online ? t('systemStatus.machine.online') : t('systemStatus.machine.offline')}
                        {' • '}
                        {meta?.platform ?? t('status.unknown')}
                        {meta?.arch ? ` • ${meta.arch}` : ''}
                        {meta?.happyCliVersion ? t('systemStatus.machine.cliVersionBullet', { version: meta.happyCliVersion }) : ''}
                      </Text>
                      {doctorRow}
                    </View>
                  );

                  return (
                    <Item
                      key={machine.id}
                      title={displayName}
                      subtitle={subtitle}
                      icon={<Ionicons name="laptop-outline" size={24} color={online ? theme.colors.success : theme.colors.textSecondary} />}
                      onPress={() => {
                        const query = serverId ? `?serverId=${encodeURIComponent(serverId)}` : '';
                        router.push(`/machine/${machine.id}${query}`);
                      }}
                      onLongPress={() => {
                        if (!online) return;
                        fireAndForget(fetchDoctorSnapshotForMachine({
                          machineId: machine.id,
                          serverId,
                          timeoutMs: 4_000,
                        }), { tag: 'SystemStatusView.fetchDoctorSnapshotForMachine' });
                      }}
                      detail={formatRelativeTimeMs(machine.activeAt)}
                    />
                  );
                })}
              </ItemGroup>
            );
          })}
        </View>

        <ItemGroup title={t('systemStatus.sections.actions')}>
          <Item
            testID="system-status-run-diagnosis"
            title={t('systemStatus.actions.runDiagnosis')}
            subtitle={t('systemStatus.actions.runDiagnosisSubtitle')}
            icon={<Ionicons name="medkit-outline" size={24} color={theme.colors.accent.orange} />}
            onPress={openDiagnosis}
          />
          <Item
            title={t('systemStatus.actions.refreshMachineAttribution')}
            subtitle={t('systemStatus.actions.refreshMachineAttributionSubtitle')}
            icon={<Ionicons name="refresh-outline" size={24} color={theme.colors.accent.blue} />}
            onPress={refreshMachineAttribution}
            loading={refreshingMachines}
            showChevron={false}
          />
          <Item
            title={t('systemStatus.actions.copyJson')}
            subtitle={t('systemStatus.actions.copyJsonSubtitle')}
            icon={<Ionicons name="copy-outline" size={24} color={theme.colors.accent.indigo} />}
            onPress={copySystemStatusJson}
            loading={copying}
            showChevron={false}
          />
        </ItemGroup>
      </React.Fragment>
    </ItemList>
  );
});
