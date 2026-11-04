import * as React from 'react';
import { Platform, View } from 'react-native';
import Constants from 'expo-constants';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useUnistyles } from 'react-native-unistyles';
import { sanitizeBugReportUrl } from '@happier-dev/protocol/bugs/reports/sanitize';
import { sanitizeDoctorDiagnosticErrorMessage } from '@happier-dev/protocol/diagnostics/doctorSnapshot';
import { DiagnosticsActionOutputSchemas } from '@happier-dev/protocol/actions/diagnosticsActionFamily';
import { ClipboardWriteResultSchema } from '@happier-dev/protocol/actions/clipboardActionFamily';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { CountedDisclosureItem } from '@/components/ui/lists/CountedDisclosureItem';
import { Text } from '@/components/ui/text/Text';
import { layout } from '@/components/ui/layout/layout';
import { Modal } from '@/modal';
import { useHappyAction } from '@/hooks/ui/useHappyAction';
import { listServerProfiles, resolveServerProfileScopeIdForIdentifier, type ServerProfile } from '@/sync/domains/server/serverProfiles';
import { useServerCredentialAccountScopeBindings } from '@/sync/domains/scope/useServerCredentialAccountScopes';
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
import { isMachineReachable, resolveMachineReachability } from '@/sync/domains/machines/reachability/machineReachability';
import { normalizeFileSystemPath } from '@/sync/domains/fileSystem/normalizeFileSystemPath';
import { useMachineReachabilityRevision } from '@/sync/domains/machines/reachability/useMachineReachabilityRevision';
import { isMachineVisibleForLaunchSelection } from '@/sync/domains/machines/identity/filterVisibleMachines';
import { useMachinePresenceNowMs } from '@/hooks/machine/useMachinePresenceNowMs';
import { resolveMachineDisplayNames } from '@/utils/sessions/machineDisplayNames';
import { Typography } from '@/constants/Typography';
import { StyleSheet } from 'react-native-unistyles';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { CopiedPill } from '@/components/ui/copy/CopiedPill';
import { useHappierCopyFeedback } from '@happier-dev/plugin-ui/presentation';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { requireActionSuccess } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { useMountedDiagnosticAction } from '../diagnosis/useMountedDiagnosticAction';
import type { DiagnosticInvocation } from '../diagnosis/diagnosticsActionRuntime';
import { readMachineDoctorSnapshot } from '@/components/machines/doctorSnapshot/readMachineDoctorSnapshot';

import type { MachineDoctorSnapshotState } from '@/components/machines/doctorSnapshot/readMachineDoctorSnapshot';
import { MachineDoctorRuntimeInventorySection } from '@/components/machines/doctorSnapshot/MachineDoctorRuntimeInventorySection';
import {
  buildMachineDoctorSnapshotTargetKey,
  useMachineDoctorSnapshotCollection,
} from '@/components/machines/doctorSnapshot/useMachineDoctorSnapshotCollection';
import { OtaUpdateStatusSection } from './OtaUpdateStatusSection';
import { Icon } from '@/components/ui/icons/Icon';
import { sanitizeActiveServerSnapshotForDiagnostics, UNKNOWN_VALUE } from './systemStatusDiagnostics';
import { isDaemonOfAnotherAccount } from '@/sync/domains/server/relayDrift/relayDriftModel';
import { createDiagnosticServerUrlKey } from '@/sync/domains/server/url/serverUrlCanonical';
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
import { formatAccountDisplayName } from '@/sync/domains/account/formatAccountDisplayName';
import { resolveThisComputerConnection } from '@/sync/domains/server/relayDrift/thisComputerConnection';
import { machinePageHref } from '@/components/settings/machines/collection/machineCollectionModel';

function resolveServerProfileLabel(profile: ServerProfile): string {
  return resolveHomeDisplayLabel(profile, profile.id);
}

export const SystemStatusView = React.memo(function SystemStatusView() {
  const router = useRouter();
  const { theme } = useUnistyles();
  const copyFeedback = useHappierCopyFeedback();

  const activeServerSnapshot = useActiveServerSnapshot();
  const execution = useMountedActionExecution(activeServerSnapshot.serverId);
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
  const machineHomeIds = React.useMemo(() => Object.keys(machineListByServerId), [machineListByServerId]);
  const machineScopeBindings = useServerCredentialAccountScopeBindings(machineHomeIds);
  // The Overview's machine rules: the same reachability decision (a failed request overrides pushed presence) and the same list.
  const reachabilityRevision = useMachineReachabilityRevision();
  const presenceNowMs = useMachinePresenceNowMs(React.useMemo(() => Object.values(machineListByServerId).flatMap((list) => (Array.isArray(list) ? list : [])), [machineListByServerId]));
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
      .filter((machine) => isMachineVisibleForLaunchSelection(machine) && machine.availability?.kind !== 'locked' && isMachineReachable(execution.isCurrent() ? execution.binding?.scope : null, machine, presenceNowMs))
      .slice(0, 3)
      .map((machine) => ({
        serverId: activeServerSnapshot.serverId,
        machineId: machine.id,
      }));
  }, [activeServerSnapshot.serverId, execution.binding, execution.isCurrent, machineListByServerId, presenceNowMs, reachabilityRevision]);

  const activeServerOnlineMachineTargetKeys = React.useMemo(() => (
    activeServerOnlineMachineTargets.map((target) => buildMachineDoctorSnapshotTargetKey(target))
  ), [activeServerOnlineMachineTargets]);
  // Check daemons is an explicit read. Its own request can restore reachability;
  // passive prefetch above still requires the canonical admission decision.
  const activeServerMachineCheckTargets = React.useMemo(() => (
    (machineListByServerId[activeServerSnapshot.serverId] ?? [])
      .filter(machine => isMachineVisibleForLaunchSelection(machine) && machine.availability?.kind !== 'locked')
      .slice(0, 3)
      .map(machine => ({ serverId: activeServerSnapshot.serverId, machineId: machine.id }))
  ), [activeServerSnapshot.serverId, machineListByServerId]);

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

  const refreshMachineAttribution = React.useCallback(async (invocation: DiagnosticInvocation) => {
    invocation.assertCurrent();
    await fetchMachineDoctorSnapshots(activeServerMachineCheckTargets);
    invocation.assertCurrent();
    return DiagnosticsActionOutputSchemas['diagnostics.daemons.check'].parse({ status: 'completed',
      machines: activeServerMachineCheckTargets.map(target => ({ machineId: target.machineId,
        status: readMachineDoctorSnapshot(target) ? 'ready' : 'error' })),
    });
  }, [activeServerMachineCheckTargets, fetchMachineDoctorSnapshots]);
  const refreshingMachines = useMountedDiagnosticAction('diagnostics.daemons.check', execution, refreshMachineAttribution);
  const [, runRefreshMachineAttribution] = useHappyAction(async () => {
    requireActionSuccess(await execution.execute('diagnostics.daemons.check', {}));
  });

  const readSystemStatusExport = React.useCallback(async (invocation: DiagnosticInvocation) => {
    invocation.assertCurrent();
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
                happyHomeDirBasename: (normalizeFileSystemPath(machine.metadata.happyHomeDir) ?? '').split('/').filter(Boolean).slice(-1)[0] ?? '',
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

    return DiagnosticsActionOutputSchemas['diagnostics.status.get'].parse({ status: 'available', json: JSON.stringify(payload, null, 2) });
  }, [activeServerSnapshot, appRuntimeInfo, homeTransportDiagnostics, isDataReady, lastSyncAt,
    machineDoctorSnapshotByTargetKey, machineListByServerId, machineListStatusByServerId, profile, serverProfiles, socket, voiceStatus]);
  useMountedDiagnosticAction('diagnostics.status.get', execution, readSystemStatusExport);
  const [copying, copySystemStatusJson] = useHappyAction(async () => {
    const result = await execution.execute('diagnostics.status.get', {});
    requireActionSuccess(result);
    if (!result.ok) return;
    const exported = DiagnosticsActionOutputSchemas['diagnostics.status.get'].parse(result.result);
    if (exported.status !== 'available') return;
    const copied = await execution.execute('clipboard.write', { text: exported.json });
    if (!copied.ok || !ClipboardWriteResultSchema.safeParse(copied.result).success) {
      Modal.alert(t('common.error'), t('items.failedToCopyToClipboard'));
      return;
    }
    copyFeedback.markCopied('system-status');
  });

  const machineGroups = React.useMemo(() => {
    const ids = new Set<string>();
    ids.add(activeServerSnapshot.serverId);
    for (const id of Object.keys(machineListByServerId)) ids.add(id);
    // The active Home is known by its identity and by its saved profile; it is one Home, one machines section.
    for (const sp of serverProfiles) if (sp.serverIdentityId !== activeServerSnapshot.serverId) ids.add(sp.id);
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
      : UNKNOWN_VALUE;
  const appliedIrohConfiguration = activeTransportDiagnostics?.effectiveConfiguration;
  const transportStateLabel = t(irohTransportPresentation.transportStatus?.labelKey ?? 'status.unknown');

  // What needs a person: a daemon on another Home or Account, or a daemon check that could not be read.
  // Everything else about an online machine is calm.
  const readMachineAttention = (entry: MachineDoctorSnapshotState): 'mismatch' | 'unreadable' | null => {
    if (entry.status === 'error') return 'unreadable';
    if (entry.status !== 'ready') return null;
    const daemonServerUrl = entry.snapshot.server.serverUrl;
    const activeServerKey = createDiagnosticServerUrlKey(activeServerUrl);
    const daemonServerKey = createDiagnosticServerUrlKey(daemonServerUrl);
    const serverMismatch = Boolean(activeServerKey && daemonServerKey && activeServerKey !== daemonServerKey);
    const accountMismatch = isDaemonOfAnotherAccount({ daemonAccountId: entry.snapshot.accountId, appAccountId: profile?.id });
    return serverMismatch || accountMismatch ? 'mismatch' : null;
  };

  const openDiagnosis = React.useCallback(() => {
    router.push('/settings/diagnosis');
  }, [router]);

  return (
    <ItemList style={{ paddingTop: 0 }} testID="system-status-screen">
      <SettingsPageHeader
        description={t('systemStatus.pageDescription')}
        actions={(
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space.s8 }}>
            <CopiedPill visible={copyFeedback.isCopied('system-status')} testID="system-status-copy-feedback" />
            <SettingAnchor setting={SYSTEM_STATUS_SETTINGS.settings.copyJson}>
              <RoundButton
                testID="system-status-copy-json"
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
            detail={appRuntimeInfo.appVersion ?? UNKNOWN_VALUE}
            copy={appRuntimeInfo.appVersion ?? false}
          />
          <Item
            title={t('settingsAgents.releaseChannelTitle')}
            detail={appRuntimeInfo.updateChannel ?? UNKNOWN_VALUE}
            copy={appRuntimeInfo.updateChannel ?? false}
          />
          <Item
            title={t('systemStatus.ui.dataReady')}
            detail={isDataReady ? t('common.yes') : t('common.no')}
          />
          {voiceStatus !== 'disconnected' ? (
            <Item
              title={t('systemStatus.ui.realtime')}
              detail={t(`status.${voiceStatus}`)}
            />
          ) : null}
          <Item
            title={t('systemStatus.ui.socket')}
            detail={t(`status.${socket.status}`)}
            subtitle={
              socket.lastError
                ? <Text style={{ color: theme.colors.text.secondary }}>{t('systemStatus.ui.socketLastError', { error: sanitizeDoctorDiagnosticErrorMessage(socket.lastError) })}</Text>
                : undefined
            }
          />
          <Item
            title={t('systemStatus.ui.lastSync')}
            detail={lastSyncAt ? new Date(lastSyncAt).toLocaleString() : UNKNOWN_VALUE}
          />
        </ItemGroup>

        <OtaUpdateStatusSection />

        <ItemGroup title={t('systemStatus.sections.currentServer')}>
          <SettingRow
            setting={SYSTEM_STATUS_SETTINGS.settings.activeHomeHealth}
            icon={<Icon name="hard-drives" />}
            subtitle={<Text style={{ color: theme.colors.text.secondary }}>{activeServerUrl || UNKNOWN_VALUE}</Text>}
            detail={t(resolveHomeConnectionSummary({ healthKind: activeHomeHealth.kind }).statusLabelKey)}
            onPress={() => router.push('/settings/server')}
          />
          <Item
            title={t('connectionStatus.labels.homeIdentity')}
            detailStyle={styles.mono}
            detail={activeHomeProfile?.serverIdentityId ?? activeServerSnapshot.serverId ?? UNKNOWN_VALUE}
            copy={activeHomeProfile?.serverIdentityId ?? activeServerSnapshot.serverId ?? false}
          />
          <Item
            title={t('connectionStatus.labels.canonicalAddress')}
            detail={activeHomeProfile?.canonicalServerUrl ?? activeServerSnapshot.serverUrl ?? UNKNOWN_VALUE}
            copy={activeHomeProfile?.canonicalServerUrl ?? activeServerSnapshot.serverUrl ?? false}
          />
          <Item
            title={t('connectionStatus.labels.publicIngress')}
            detail={activeHomeProfile?.publicServerUrl === null
              ? t('connectionStatus.values.publicIngressAbsent')
              : activeHomeProfile?.publicServerUrl === undefined
                ? UNKNOWN_VALUE
                : activeHomeProfile.publicServerUrl}
            copy={typeof activeHomeProfile?.publicServerUrl === 'string' ? activeHomeProfile.publicServerUrl : false}
          />
          <Item
            title={t('connectionStatus.labels.effectiveCarrier')}
            detail={effectiveCarrier === 'iroh'
              ? 'Iroh'
              : effectiveCarrier === 'https'
                ? 'HTTPS'
                : UNKNOWN_VALUE}
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
            detailStyle={styles.mono}
            detail={profile?.id ?? UNKNOWN_VALUE}
            copy={profile?.id ?? false}
          />
          {profile?.username ? (
            <Item
              title={t('systemStatus.identity.username')}
              detail={profile.username}
              copy={profile.username}
            />
          ) : null}
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
              detail={p.id === activeHomeProfile?.id ? t('systemStatus.servers.active') : undefined}
              icon={<Icon name="hard-drives" size={24} color={theme.colors.text.secondary} />}
              copy
            />
          ))}
        </ItemGroup>

        <View style={{ maxWidth: layout.maxWidth, alignSelf: 'center', width: '100%' }}>
          {machineGroups.map((serverId, groupIndex) => {
            const rawList = machineListByServerId[serverId];
            const list = Array.isArray(rawList) ? rawList.filter(isMachineVisibleForLaunchSelection) : rawList;
            const binding = machineScopeBindings.get(resolveServerProfileScopeIdForIdentifier(serverId));
            const isOnline = (machine: NonNullable<typeof list>[number]) => isMachineReachable(binding?.isCurrent() ? binding.scope : null, machine, presenceNowMs);
            const reachability = (machine: NonNullable<typeof list>[number]) => resolveMachineReachability(binding?.isCurrent() ? binding.scope : null, machine, presenceNowMs);
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
              : t('systemStatus.sections.machinesOtherServer', { server: resolveHomeDisplayLabel(serverProfile, serverId) });

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

            // The one machine-naming owner (the Overview widget's): same-named machines carry a short suffix.
            const machineNames = resolveMachineDisplayNames(list.map((machine) => ({ id: machine.id, metadata: machine.metadata, availability: machine.availability })));
            const renderMachine = (machine: (typeof list)[number]) => {
              const meta = machine.metadata;
              const snapshotKey = buildMachineDoctorSnapshotTargetKey({
                serverId,
                machineId: machine.id,
              });
              const displayName = machineNames.get(machine.id) ?? machine.id;
              const online = isOnline(machine);

              const fetchEntry = machineDoctorSnapshotByTargetKey[snapshotKey] ?? { status: 'idle' as const };
              const attention = readMachineAttention(fetchEntry);
              // Speak only about what was asked: nothing until "Check daemons" (or a long press) fetches this machine.
              const doctorRow = (() => {
                if (fetchEntry.status === 'loading') {
                  return <Text style={{ color: theme.colors.text.secondary }}>{t('systemStatus.machine.fetchDoctorSnapshot.loading')}</Text>;
                }
                if (fetchEntry.status === 'error') {
                  // A daemon check that could not be read is a fact about the check, not an alarm about the machine.
                  return <Text style={{ color: theme.colors.text.secondary }}>{t('systemStatus.machine.fetchDoctorSnapshot.invalid')}</Text>;
                }
                if (fetchEntry.status === 'ready') {
                  const daemonServerUrl = fetchEntry.snapshot.server.serverUrl;
                  const daemonAccountId = fetchEntry.snapshot.accountId ?? UNKNOWN_VALUE;
                  const mismatchLabel = attention === 'mismatch' ? ` • ${t('systemStatus.mismatch')}` : '';
                  return (
                    <Text style={{ color: attention === 'mismatch' ? theme.colors.state.danger.foreground : theme.colors.text.secondary }}>
                      {t('systemStatus.machine.daemonAttribution', { home: daemonServerUrl, account: daemonAccountId })}
                      {mismatchLabel}
                      {'\n'}
                      {t('systemStatus.machine.daemonAttributionAge', { age: fetchEntry.cachedAt ? formatRelativeTimeShort(fetchEntry.cachedAt, Date.now()) : UNKNOWN_VALUE })}
                    </Text>
                  );
                }
                return null;
              })();

              // Healthy is quiet: presence is a word in the secondary ink, colour is kept for trouble.
              const subtitle = (
                <View>
                  <Text style={{ color: theme.colors.text.secondary }}>
                    {online ? t('systemStatus.machine.online') : reachability(machine) === 'unknown' ? t('common.unknown') : t('systemStatus.machine.offline')}
                    {meta?.platform ? ` • ${meta.platform}` : ''}
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
                      router.push(machinePageHref({ door: 'rail', target: { machineId: machine.id, serverId: serverId || undefined } }) as never);
                    }}
                    onLongPress={() => {
                      if (!binding?.isCurrent()) return;
                      fireAndForget(fetchMachineDoctorSnapshots([{
                        serverId,
                        machineId: machine.id,
                      }]), { tag: 'SystemStatusView.fetchDoctorSnapshotForMachine' });
                    }}
                    detail={machine.activeAt ? formatRelativeTimeShort(machine.activeAt, Date.now()) : UNKNOWN_VALUE}
                  />
                  {fetchEntry.status === 'ready' ? (
                    <MachineDoctorRuntimeInventorySection snapshotState={fetchEntry} mode="summary" />
                  ) : null}
                </React.Fragment>
              );
            };
            const offlineMachines = list.filter((machine) => reachability(machine) === 'unreachable');
            const unknownMachines = list.filter((machine) => reachability(machine) === 'unknown');
            // Machines that need attention come first; calm online ones fold into one counted row (a lone one stays a row).
            const onlineMachines = list.filter(isOnline);
            const needsAttention = (machine: (typeof list)[number]) => readMachineAttention(
              machineDoctorSnapshotByTargetKey[buildMachineDoctorSnapshotTargetKey({ serverId, machineId: machine.id })] ?? { status: 'idle' as const },
            ) !== null;
            const attentionMachines = onlineMachines.filter(needsAttention);
            const calmMachines = onlineMachines.filter((machine) => !needsAttention(machine));
            const foldCalm = calmMachines.length > 1;

            return (
              <ItemGroup
                key={serverId}
                title={title}
                description={statusSubtitle}
                action={refreshAction}
              >
                {attentionMachines.map(renderMachine)}
                {foldCalm ? (
                  <CountedDisclosureItem testID="system-status-calm-machines" title={t('systemStatus.machines.calmOnline')} count={calmMachines.length}>
                    {calmMachines.map(renderMachine)}
                  </CountedDisclosureItem>
                ) : calmMachines.map(renderMachine)}
                {unknownMachines.map(renderMachine)}
                {offlineMachines.length > 0 ? (
                  <CountedDisclosureItem testID="system-status-offline-machines" title={t('systemStatus.machine.offline')} count={offlineMachines.length}>
                    {offlineMachines.map(renderMachine)}
                  </CountedDisclosureItem>
                ) : null}
              </ItemGroup>
            );
          })}
        </View>

      </React.Fragment>
    </ItemList>
  );
});

const styles = StyleSheet.create(() => ({
  mono: { ...Typography.mono() },
}));
