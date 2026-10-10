import * as React from 'react';
import { Platform, View } from 'react-native';
import Constants from 'expo-constants';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useUnistyles } from 'react-native-unistyles';
import { sanitizeBugReportUrl } from '@happier-dev/protocol/bugs/reports/sanitize';
import { sanitizeDoctorDiagnosticErrorMessage } from '@happier-dev/protocol/diagnostics/doctorSnapshot';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { Text } from '@/components/ui/text/Text';
import { layout } from '@/components/ui/layout/layout';
import { Modal } from '@/modal';
import { useHappyAction } from '@/hooks/ui/useHappyAction';
import { listServerProfiles, type ServerProfile } from '@/sync/domains/server/serverProfiles';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { readCurrentAppRuntimeInfo } from '@/sync/runtime/readCurrentAppRuntimeInfo';
import {
  readIrohHomeTransportDiagnostics,
  readIrohHomeTransportDiagnosticsRevision,
  subscribeIrohHomeTransportDiagnostics,
} from '@/sync/runtime/irohHomeTransportDiagnostics';
import {
  useIsDataReady,
  useLastSyncAt,
  useMachineListByServerId,
  useMachineListStatusByServerId,
  useProfile,
  useSocketStatus,
} from '@/sync/domains/state/storage';
import { useVoiceSessionSnapshot } from '@/voice/session/voiceSession';
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
import { OtaUpdateStatusSection } from './OtaUpdateStatusSection';
import { Icon } from '@/components/ui/icons/Icon';
import { sanitizeActiveServerSnapshotForDiagnostics } from './systemStatusDiagnostics';
import { isDaemonOfAnotherAccount } from '@/sync/domains/server/relayDrift/relayDriftModel';
import { createServerUrlComparableKey } from '@/sync/domains/server/url/serverUrlCanonical';
import { useActiveHomeConnectionHealth } from '@/components/navigation/connectionStatus/useConnectionHealth';
import { formatIrohRelayConfiguration } from '@/components/navigation/connectionStatus/formatIrohRelayConfiguration';
import { projectIrohHomeTransportPresentation } from '@/components/navigation/connectionStatus/projectIrohHomeTransportPresentation';
import { resolveHomeConnectionSummary } from '@/components/navigation/connectionStatus/resolveHomeConnectionSummary';
import { formatRelativeTimeShort } from '@/utils/time/formatShortRelativeTime';
import { SettingsPageHeader } from '@/components/settings/shell/SettingsPageHeader';
import { SettingAnchor, SettingRow } from '@/components/settings/shell/SettingRow';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { SYSTEM_STATUS_SETTINGS } from '@/components/settings/systemStatus/systemStatusSettings';
import { resolveHomeDisplayLabel } from '@/components/settings/server/homeDisplayName';

function resolveMachineDisplayName(params: Readonly<{ host?: string; displayName?: string | null }>): string {
  const displayName = String(params.displayName ?? '').trim();
  if (displayName) return displayName;
  const host = String(params.host ?? '').trim();
  if (host) return host;
  return t('systemStatus.machine.unknownHost');
}

function resolveServerProfileLabel(profile: ServerProfile): string {
  return resolveHomeDisplayLabel(profile, profile.id);
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

  const activeServerSnapshot = useActiveServerSnapshot();
  const activeServerUrl = React.useMemo(
    () => sanitizeBugReportUrl(activeServerSnapshot.serverUrl) ?? activeServerSnapshot.serverUrl,
    [activeServerSnapshot.serverUrl],
  );
  const homeTransportDiagnosticsRevision = React.useSyncExternalStore(
    subscribeIrohHomeTransportDiagnostics,
    readIrohHomeTransportDiagnosticsRevision,
    readIrohHomeTransportDiagnosticsRevision,
  );
  const homeTransportDiagnostics = React.useMemo(
    () => readIrohHomeTransportDiagnostics(),
    [homeTransportDiagnosticsRevision],
  );

  const profile = useProfile();
  const isDataReady = useIsDataReady();
  const voiceStatus = useVoiceSessionSnapshot().status;
  const socket = useSocketStatus();
  const lastSyncAt = useLastSyncAt();
  const activeHomeHealth = useActiveHomeConnectionHealth();
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
        voiceStatus,
        socketStatus: socket.status,
        socketLastError: socket.lastError
          ? sanitizeDoctorDiagnosticErrorMessage(socket.lastError)
          : socket.lastError,
        socketLastErrorAt: socket.lastErrorAt,
        lastSyncAt,
      },
      activeServer: sanitizeActiveServerSnapshotForDiagnostics(activeServerSnapshot),
      profile: profile
        ? {
          id: profile.id,
          username: profile.username,
          connectedServices: profile.connectedServices ?? [],
        }
        : null,
      serverProfiles: serverProfiles.map((p) => ({
        id: p.id,
        serverIdentityId: p.serverIdentityId ?? null,
        name: p.name,
        source: p.source ?? null,
        serverUrl: sanitizeBugReportUrl(p.serverUrl) ?? p.serverUrl,
        canonicalServerUrl: p.canonicalServerUrl
          ? sanitizeBugReportUrl(p.canonicalServerUrl) ?? p.canonicalServerUrl
          : null,
        publicServerUrl: p.publicServerUrl === undefined
          ? 'unknown'
          : p.publicServerUrl === null
            ? null
            : sanitizeBugReportUrl(p.publicServerUrl) ?? p.publicServerUrl,
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
      homeTransports: homeTransportDiagnostics,
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

  const activeHomeProfile = React.useMemo(() => serverProfiles.find((candidate) => (
    candidate.id === activeServerSnapshot.serverId
    || candidate.serverIdentityId === activeServerSnapshot.serverId
  )) ?? null, [activeServerSnapshot.serverId, serverProfiles]);
  const activeTransportDiagnostics = homeTransportDiagnostics.find((candidate) => (
    candidate.homeServerIdentityId === (activeHomeProfile?.serverIdentityId ?? activeServerSnapshot.serverId)
  )) ?? null;
  const irohTransportPresentation = React.useMemo(() => projectIrohHomeTransportPresentation({
    effectiveCarrier: activeServerSnapshot.carrier,
    diagnostics: activeTransportDiagnostics,
  }), [activeServerSnapshot.carrier, activeTransportDiagnostics]);
  const effectiveCarrier = irohTransportPresentation.effectiveCarrier;
  const primaryTransportPath = irohTransportPresentation.primaryPath;
  const observedCarrier = primaryTransportPath?.observation.carrier ?? null;
  const effectiveObservedPath = primaryTransportPath?.observation.observedPath ?? null;
  const observedPathLabel = effectiveObservedPath === 'direct'
    ? t('connectionStatus.values.pathDirect')
    : effectiveObservedPath === 'relay'
      ? t('connectionStatus.values.pathRelay')
      : t('status.unknown');
  const appliedIrohConfiguration = activeTransportDiagnostics?.effectiveConfiguration;
  const transportStateLabel = t(irohTransportPresentation.transportStatus?.labelKey ?? 'status.unknown');

  const openDiagnosis = React.useCallback(() => {
    router.push('/settings/diagnosis');
  }, [router]);

  return (
    <ItemList style={{ paddingTop: 0 }} testID="system-status-screen">
      <SettingsPageHeader
        description={t('systemStatus.pageDescription')}
        actions={(
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <CopiedPill visible={copyFeedback.isCopied('system-status')} testID="system-status-copy-feedback" />
            <SettingAnchor setting={SYSTEM_STATUS_SETTINGS.settings.copyJson}>
              <RoundButton
                testID="system-status-copy-json"
                size="small"
                display="inverted"
                title={t(SYSTEM_STATUS_SETTINGS.settings.copyJson.titleKey)}
                accessibilityHint={t('systemStatus.actions.copyJsonSubtitle')}
                leading={<Icon name="copy" size={14} color={theme.colors.text.secondary} />}
                loading={copying}
                onPress={copySystemStatusJson}
              />
            </SettingAnchor>
            <RoundButton
              testID="system-status-run-diagnosis"
              size="small"
              display="secondary"
              title={t('systemStatus.actions.runDiagnosis')}
              accessibilityHint={t('systemStatus.actions.runDiagnosisSubtitle')}
              onPress={openDiagnosis}
            />
          </View>
        )}
      />
      <React.Fragment>
        <ItemGroup title={t('systemStatus.sections.appHealth')}>
          <Item
            title={t('bugReports.composer.environment.appVersionLabel')}
            detail={appRuntimeInfo.appVersion ?? t('status.unknown')}
            copy={appRuntimeInfo.appVersion ?? false}
          />
          <Item
            title={t('settingsAgents.releaseChannelTitle')}
            detail={appRuntimeInfo.updateChannel ?? t('status.unknown')}
            copy={appRuntimeInfo.updateChannel ?? false}
          />
          <Item
            title={t('systemStatus.ui.dataReady')}
            detail={isDataReady ? t('common.yes') : t('common.no')}
          />
          <Item
            title={t('systemStatus.ui.realtime')}
            detail={String(voiceStatus)}
          />
          <Item
            title={t('systemStatus.ui.socket')}
            detail={String(socket.status)}
            subtitle={
              socket.lastError
                ? <Text style={{ color: theme.colors.text.secondary }}>{t('systemStatus.ui.socketLastError', { error: sanitizeDoctorDiagnosticErrorMessage(socket.lastError) })}</Text>
                : undefined
            }
          />
          <Item
            title={t('systemStatus.ui.lastSync')}
            detail={lastSyncAt ? new Date(lastSyncAt).toLocaleString() : t('status.unknown')}
          />
        </ItemGroup>

        <OtaUpdateStatusSection />

        <ItemGroup title={t('systemStatus.sections.currentServer')}>
          <SettingRow
            setting={SYSTEM_STATUS_SETTINGS.settings.activeHomeHealth}
            icon={<Icon name="hard-drives" />}
            subtitle={<Text style={{ color: theme.colors.text.secondary }}>{activeServerUrl || t('status.unknown')}</Text>}
            detail={t(resolveHomeConnectionSummary({ healthKind: activeHomeHealth.kind }).statusLabelKey)}
            onPress={() => router.push('/settings/server')}
          />
          <Item
            title={t('connectionStatus.labels.homeIdentity')}
            detail={activeHomeProfile?.serverIdentityId ?? activeServerSnapshot.serverId ?? t('status.unknown')}
            copy={activeHomeProfile?.serverIdentityId ?? activeServerSnapshot.serverId ?? false}
          />
          <Item
            title={t('connectionStatus.labels.canonicalAddress')}
            detail={activeHomeProfile?.canonicalServerUrl ?? activeServerSnapshot.serverUrl ?? t('status.unknown')}
            copy={activeHomeProfile?.canonicalServerUrl ?? activeServerSnapshot.serverUrl ?? false}
          />
          <Item
            title={t('connectionStatus.labels.publicIngress')}
            detail={activeHomeProfile?.publicServerUrl === null
              ? t('connectionStatus.values.publicIngressAbsent')
              : activeHomeProfile?.publicServerUrl === undefined
                ? t('status.unknown')
                : activeHomeProfile.publicServerUrl}
            copy={typeof activeHomeProfile?.publicServerUrl === 'string' ? activeHomeProfile.publicServerUrl : false}
          />
          <Item
            title={t('connectionStatus.labels.effectiveCarrier')}
            detail={effectiveCarrier === 'iroh'
              ? 'Iroh'
              : effectiveCarrier === 'https'
                ? 'HTTPS'
                : t('status.unknown')}
          />
          {activeTransportDiagnostics ? (
            <Item
              title={t(irohTransportPresentation.heading === 'current'
                ? 'systemStatus.transport.irohCurrent'
                : 'systemStatus.transport.irohHistory')}
              detail={transportStateLabel}
            />
          ) : null}
          {primaryTransportPath ? (
            <Item
              title={primaryTransportPath.role === 'current'
                ? t('connectionStatus.labels.currentPath')
                : t('connectionStatus.labels.lastKnownPath')}
              detail={observedCarrier
                ? `${observedCarrier === 'iroh' ? 'Iroh' : 'HTTPS'} · ${observedPathLabel}`
                : observedPathLabel}
            />
          ) : null}
          {appliedIrohConfiguration ? (
            <Item
              title={t('connectionStatus.labels.relayConfiguration')}
              detail={formatIrohRelayConfiguration(appliedIrohConfiguration)}
            />
          ) : null}
        </ItemGroup>

        <ItemGroup title={t('systemStatus.sections.identity')}>
          <Item
            title={t('systemStatus.identity.accountId')}
            detail={profile?.id ?? t('status.unknown')}
            copy={profile?.id ?? false}
          />
          <Item
            title={t('systemStatus.identity.username')}
            detail={profile?.username ?? t('status.unknown')}
            copy={profile?.username ?? false}
          />
        </ItemGroup>

        <ItemGroup title={t('systemStatus.sections.configuredServers')}>
          {serverProfiles.length === 0 ? (
            <Item
              title={t('systemStatus.servers.noneConfigured')}
              disabled
            />
          ) : serverProfiles.map((p) => (
            <Item
              key={p.id}
              title={resolveServerProfileLabel(p)}
              subtitle={<Text style={{ color: theme.colors.text.secondary }}>{sanitizeBugReportUrl(p.serverUrl) ?? p.serverUrl}</Text>}
              detail={p.id === activeServerSnapshot.serverId ? t('systemStatus.servers.active') : p.id}
              icon={<Icon name="hard-drives" size={24} color={theme.colors.text.secondary} />}
              copy
            />
          ))}
        </ItemGroup>

        <View style={{ maxWidth: layout.maxWidth, alignSelf: 'center', width: '100%' }}>
          {machineGroups.map((serverId, groupIndex) => {
            const list = machineListByServerId[serverId];
            // One refresh for every Home's machines, on the first machines section.
            const refreshAction = groupIndex === 0 ? (
              <RoundButton
                testID="system-status-refresh-machine-attribution"
                size="small"
                display="inverted"
                title={t('systemStatus.actions.refreshMachineAttribution')}
                accessibilityHint={t('systemStatus.actions.refreshMachineAttributionSubtitle')}
                leading={refreshingMachines
                  ? <ActivitySpinner size="small" />
                  : <Icon name="arrows-clockwise" size={14} color={theme.colors.text.secondary} />}
                disabled={refreshingMachines}
                onPress={runRefreshMachineAttribution}
              />
            ) : undefined;
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
                  description={statusSubtitle}
                  action={refreshAction}
                >
                  <Item
                    title={t('systemStatus.machines.none')}
                    mode="info"
                  />
                </ItemGroup>
              );
            }

            return (
              <ItemGroup
                key={serverId}
                title={title}
                description={statusSubtitle}
                action={refreshAction}
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
                      // The account comparison is the drift owner's, shared with every daemon surface.
                      const accountMismatch = isDaemonOfAnotherAccount({ daemonAccountId: fetchEntry.snapshot.accountId, appAccountId: profile?.id });

                      const mismatchLabel = serverMismatch || accountMismatch ? ` • ${t('systemStatus.mismatch')}` : '';
                      return (
                        <Text style={{ color: serverMismatch || accountMismatch ? theme.colors.state.danger.foreground : theme.colors.text.secondary }}>
                          {t('systemStatus.machine.daemonAttribution', { serverUrl: daemonServerUrl, accountId: daemonAccountId })}
                          {mismatchLabel}
                          {'\n'}
                          {t('systemStatus.machine.daemonAttributionAge', { age: fetchEntry.cachedAt ? formatRelativeTimeShort(fetchEntry.cachedAt, Date.now()) : t('status.unknown') })}
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
                        icon={<Icon name="laptop" size={24} color={theme.colors.text.secondary} />}
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
                        detail={machine.activeAt ? formatRelativeTimeShort(machine.activeAt, Date.now()) : t('status.unknown')}
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

      </React.Fragment>
    </ItemList>
  );
});
