import * as React from 'react';
import { Platform, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Constants from 'expo-constants';
import { useRouter } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';
import {
  sanitizeBugReportUrl,
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
import { readCurrentAppRuntimeInfo } from '@/sync/runtime/readCurrentAppRuntimeInfo';
import {
  useIsDataReady,
  useLastSyncAt,
  useMachineListByServerId,
  useMachineListStatusByServerId,
  useProfile,
  useRealtimeStatus,
  useSocketStatus,
} from '@/sync/domains/state/storage';
import { t } from '@/text';
import { isMachineOnline } from '@/utils/sessions/machineUtils';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { CopiedPill } from '@/components/ui/copy/CopiedPill';
import { useTemporaryCopyFeedback } from '@/components/ui/copy/useTemporaryCopyFeedback';
import { setClipboardStringSafe } from '@/utils/ui/clipboard';

import { MachineDoctorRuntimeInventorySection } from '@/components/machines/doctorSnapshot/MachineDoctorRuntimeInventorySection';
import {
  buildMachineDoctorSnapshotTargetKey,
  useMachineDoctorSnapshotCollection,
} from '@/components/machines/doctorSnapshot/useMachineDoctorSnapshotCollection';
import { createServerUrlComparableKey } from '@/sync/domains/server/url/serverUrlCanonical';
import { OtaUpdateStatusSection } from './OtaUpdateStatusSection';

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

function doServerUrlsMismatch(left: string, right: string): boolean {
  const leftKey = createServerUrlComparableKey(left);
  const rightKey = createServerUrlComparableKey(right);
  if (leftKey && rightKey) return leftKey !== rightKey;
  return left.replace(/\/+$/, '') !== right.replace(/\/+$/, '');
}

export const SystemStatusView = React.memo(function SystemStatusView() {
  const router = useRouter();
  const { theme } = useUnistyles();
  const copyFeedback = useTemporaryCopyFeedback();

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
  const appRuntimeInfo = React.useMemo(() => readCurrentAppRuntimeInfo(), []);

  const machineListByServerId = useMachineListByServerId();
  const machineListStatusByServerId = useMachineListStatusByServerId();

  const serverProfiles = React.useMemo(() => {
    try {
      return listServerProfiles().slice();
    } catch {
      return [];
    }
  }, [activeServerSnapshot.generation]);

  const activeServerOnlineMachineTargets = React.useMemo(() => {
    const serverMachines = Array.isArray(machineListByServerId[activeServerSnapshot.serverId])
      ? (machineListByServerId[activeServerSnapshot.serverId] ?? [])
      : [];
    return serverMachines
      .filter((machine) => isMachineOnline(machine))
      .slice(0, 3)
      .map((machine) => ({
        serverId: activeServerSnapshot.serverId,
        machineId: machine.id,
      }));
  }, [activeServerSnapshot.serverId, machineListByServerId]);

  const activeServerOnlineMachineTargetKeys = React.useMemo(() => (
    activeServerOnlineMachineTargets.map((target) => buildMachineDoctorSnapshotTargetKey(target))
  ), [activeServerOnlineMachineTargets]);

  const machineDoctorTargetsByKey = React.useMemo(() => {
    const map = new Map<string, { machineId: string; serverId: string }>();
    for (const [serverId, list] of Object.entries(machineListByServerId)) {
      if (!Array.isArray(list)) continue;
      for (const machine of list) {
        const machineId = String(machine.id ?? '').trim();
        if (!machineId) continue;
        const target = { machineId, serverId };
        map.set(buildMachineDoctorSnapshotTargetKey(target), target);
      }
    }
    return map;
  }, [machineListByServerId]);

  const {
    machineDoctorSnapshotByTargetKey,
    fetchMachineDoctorSnapshots,
  } = useMachineDoctorSnapshotCollection({
    machineDoctorTargetsByKey,
    prefetchMachineTargetKeys: activeServerOnlineMachineTargetKeys,
    enabled: true,
  });

  const refreshMachineAttribution = React.useCallback(async () => {
    await fetchMachineDoctorSnapshots(activeServerOnlineMachineTargets);
  }, [activeServerOnlineMachineTargets, fetchMachineDoctorSnapshots]);

  const [refreshingMachines, runRefreshMachineAttribution] = useHappyAction(refreshMachineAttribution);

  const [copying, copySystemStatusJson] = useHappyAction(async () => {
    const payload = {
      capturedAt: new Date().toISOString(),
      environment: {
        appVersion: appRuntimeInfo.appVersion ?? 'unknown',
        nativeApplicationVersion: appRuntimeInfo.nativeApplicationVersion,
        nativeBuildVersion: appRuntimeInfo.nativeBuildVersion,
        applicationId: appRuntimeInfo.applicationId,
        platform: Platform.OS,
        osVersion: typeof Platform.Version === 'string' ? Platform.Version : String(Platform.Version ?? ''),
        deviceModel: Constants.deviceName ?? undefined,
        updates: {
          channel: appRuntimeInfo.updateChannel,
          updateId: appRuntimeInfo.updateId,
          runtimeVersion: appRuntimeInfo.runtimeVersion,
          createdAt: appRuntimeInfo.updateCreatedAt,
          launchSource: appRuntimeInfo.launchSource,
        },
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
      machines: Object.entries(machineListByServerId).flatMap(([serverId, list]) =>
        (Array.isArray(list) ? list : []).map((machine) => {
          const snapshotKey = buildMachineDoctorSnapshotTargetKey({
            serverId,
            machineId: machine.id,
          });
          const entry = machineDoctorSnapshotByTargetKey[snapshotKey];
          return {
            id: machine.id,
            serverId,
            active: machine.active,
            activeAt: machine.activeAt,
            updatedAt: machine.updatedAt,
            metadata: machine.metadata
              ? {
                host: machine.metadata.host,
                platform: machine.metadata.platform,
                arch: machine.metadata.arch ?? null,
                username: machine.metadata.username ?? null,
                displayName: machine.metadata.displayName ?? null,
                happyCliVersion: machine.metadata.happyCliVersion,
                happyHomeDirBasename: String(machine.metadata.happyHomeDir ?? '').split('/').filter(Boolean).slice(-1)[0] ?? '',
              }
              : null,
            doctorSnapshot: entry && entry.status === 'ready'
              ? { cachedAt: entry.cachedAt, source: entry.source, snapshot: entry.snapshot }
              : null,
          };
        }),
      ),
      machineListStatusByServerId,
    };

    const copied = await setClipboardStringSafe(JSON.stringify(payload, null, 2));
    if (!copied) {
      Modal.alert(t('common.error'), t('items.failedToCopyToClipboard'));
      return;
    }
    copyFeedback.markCopied('system-status');
  });

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
    router.push('/settings/diagnosis');
  }, [router]);

  return (
    <ItemList style={{ paddingTop: 0 }} testID="system-status-screen">
      <React.Fragment>
        <ItemGroup title={t('systemStatus.sections.appHealth')}>
          <Item
            title={t('bugReports.composer.environment.appVersionLabel')}
            detail={appRuntimeInfo.appVersion ?? t('status.unknown')}
            icon={<Ionicons name="phone-portrait-outline" size={24} color={theme.colors.accent.indigo} />}
            copy={appRuntimeInfo.appVersion ?? false}
          />
          <Item
            title={t('settingsAgents.releaseChannelTitle')}
            detail={appRuntimeInfo.updateChannel ?? t('status.unknown')}
            icon={<Ionicons name="git-branch-outline" size={24} color={theme.colors.accent.blue} />}
            copy={appRuntimeInfo.updateChannel ?? false}
          />
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
                ? <Text style={{ color: theme.colors.text.secondary }}>{t('systemStatus.ui.socketLastError', { error: socket.lastError })}</Text>
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

        <OtaUpdateStatusSection />

        <ItemGroup title={t('systemStatus.sections.currentServer')}>
          <Item
            title={t('systemStatus.server.activeServer')}
            subtitle={<Text style={{ color: theme.colors.text.secondary }}>{activeServerUrl || t('status.unknown')}</Text>}
            detail={activeServerSnapshot.serverId}
            icon={<Ionicons name="server-outline" size={24} color={theme.colors.accent.blue} />}
            onPress={() => router.push('/settings/server')}
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
              icon={<Ionicons name="server-outline" size={24} color={theme.colors.text.secondary} />}
              disabled
            />
          ) : serverProfiles.map((p) => (
            <Item
              key={p.id}
              title={resolveServerProfileLabel(p)}
              subtitle={<Text style={{ color: theme.colors.text.secondary }}>{sanitizeBugReportUrl(p.serverUrl) ?? p.serverUrl}</Text>}
              detail={p.id === activeServerSnapshot.serverId ? t('systemStatus.servers.active') : p.id}
              icon={<Ionicons name="server-outline" size={24} color={p.id === activeServerSnapshot.serverId ? theme.colors.state.success.foreground : theme.colors.accent.blue} />}
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
                    icon={<Ionicons name="laptop-outline" size={24} color={theme.colors.text.secondary} />}
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
                  const snapshotKey = buildMachineDoctorSnapshotTargetKey({
                    serverId,
                    machineId: machine.id,
                  });
                  const displayName = resolveMachineDisplayName({
                    host: meta?.host,
                    displayName: meta?.displayName ?? null,
                  });
                  const online = isMachineOnline(machine);

                  const fetchEntry = machineDoctorSnapshotByTargetKey[snapshotKey] ?? { status: 'idle' as const };
                  const doctorRow = (() => {
                    if (fetchEntry.status === 'loading') {
                      return <Text style={{ color: theme.colors.text.secondary }}>{t('systemStatus.machine.fetchDoctorSnapshot.loading')}</Text>;
                    }
                    if (fetchEntry.status === 'error') {
                      return <Text style={{ color: theme.colors.state.danger.foreground }}>{fetchEntry.detail}</Text>;
                    }
                    if (fetchEntry.status === 'ready') {
                      const daemonServerUrl = fetchEntry.snapshot.server.serverUrl;
                      const daemonAccountId = fetchEntry.snapshot.accountId ?? t('status.unknown');
                      const serverMismatch = Boolean(activeServerUrl && daemonServerUrl && doServerUrlsMismatch(activeServerUrl, daemonServerUrl));
                      const accountMismatch = profile?.id && fetchEntry.snapshot.accountId && fetchEntry.snapshot.accountId !== profile.id;

                      const mismatchLabel = serverMismatch || accountMismatch ? ` • ${t('systemStatus.mismatch')}` : '';
                      return (
                        <Text style={{ color: serverMismatch || accountMismatch ? theme.colors.state.danger.foreground : theme.colors.text.secondary }}>
                          {t('systemStatus.machine.daemonAttribution', { serverUrl: daemonServerUrl, accountId: daemonAccountId })}
                          {mismatchLabel}
                          {'\n'}
                          {t('systemStatus.machine.daemonAttributionAge', { age: formatRelativeTimeMs(fetchEntry.cachedAt) })}
                        </Text>
                      );
                    }
                    return (
                      <Text style={{ color: theme.colors.text.secondary }}>
                        {t('systemStatus.machine.daemonAttributionUnknown')}
                      </Text>
                    );
                  })();

                  const subtitle = (
                    <View>
                      <Text style={{ color: online ? theme.colors.state.success.foreground : theme.colors.text.secondary }}>
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
                    <React.Fragment key={snapshotKey}>
                      <Item
                        title={displayName}
                        subtitle={subtitle}
                        icon={<Ionicons name="laptop-outline" size={24} color={online ? theme.colors.state.success.foreground : theme.colors.text.secondary} />}
                        onPress={() => {
                          const query = serverId ? `?serverId=${encodeURIComponent(serverId)}` : '';
                          router.push(`/machine/${machine.id}${query}`);
                        }}
                        onLongPress={() => {
                          if (!online) return;
                          fireAndForget(fetchMachineDoctorSnapshots([{
                            serverId,
                            machineId: machine.id,
                          }]), { tag: 'SystemStatusView.fetchDoctorSnapshotForMachine' });
                        }}
                        detail={formatRelativeTimeMs(machine.activeAt)}
                      />
                      {fetchEntry.status !== 'idle' ? (
                        <MachineDoctorRuntimeInventorySection snapshotState={fetchEntry} mode="summary" />
                      ) : null}
                    </React.Fragment>
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
            onPress={runRefreshMachineAttribution}
            loading={refreshingMachines}
            showChevron={false}
          />
          <Item
            testID="system-status-copy-json"
            title={t('systemStatus.actions.copyJson')}
            subtitle={t('systemStatus.actions.copyJsonSubtitle')}
            icon={<Ionicons name="copy-outline" size={24} color={theme.colors.accent.indigo} />}
            onPress={copySystemStatusJson}
            rightElement={<CopiedPill visible={copyFeedback.isCopied('system-status')} testID="system-status-copy-feedback" />}
            loading={copying}
            showChevron={false}
          />
        </ItemGroup>
      </React.Fragment>
    </ItemList>
  );
});
