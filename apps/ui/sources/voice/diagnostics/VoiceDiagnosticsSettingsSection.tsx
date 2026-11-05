import * as React from 'react';
import { useServerScopedMachineLabel } from '@/sync/store/hooks';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { resolveVoiceSpeechDiagnosticsHealthPresentation, VoiceSpeechDiagnosticsStatusResponseV1Schema } from '@happier-dev/protocol/voice/diagnostics';
import { SettingsDeclarationActionOutputSchemasV1, type SettingsDeclarationOperationInputV1 } from '@happier-dev/protocol/actions/settingsDeclarationActionFamily';
import { isActionApprovalDeclinedErrorCode } from '@happier-dev/protocol/actions/actionExecutionResult';
import { formatHappierDataBytes } from '@happier-dev/plugin-ui/presentation';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { SettingAnchor, SettingRow, SettingSection } from '@/components/settings/shell/SettingRow';
import { VOICE_PRIVACY_SETTINGS } from '@/voice/settings/voiceSettingsDeclarations';
import { Switch } from '@/components/ui/forms/Switch';
import {
  useVoiceAttemptControl,
  VOICE_ATTEMPT_IDLE_TARGET_GLOBAL,
} from '@/components/voice/attempt/useVoiceAttemptControl';
import { Modal } from '@/modal';
import type { VoiceSettings } from '@/sync/domains/settings/voiceSettings';
import {
  readVoiceDiagnosticsSettings,
  writeVoiceDiagnosticsSettings,
} from '@/sync/domains/settings/voiceSettings';
import { t, tLoose } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { useVoiceExecutionMachineId } from '@/voice/credentials/useExecutionMachinePresentation';
import { useActiveServerAccountScopeLifetime } from '@/sync/store/hooks';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { requireActionSuccess } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { presentActionTurnedOffNoticeIfOff } from '@/sync/ops/actions/actionTurnedOffNotice';
import { resolveActionSurfaceAvailability } from '@happier-dev/protocol/actions/actionSurfaceAvailability';
import { useSettingsSelector } from '@/sync/store/settingsReadHooks';

import { createVoiceDiagnosticsClientForMachine } from './client';
import { useVoiceDiagnosticsRuntimeStatus } from './runtimeStatus';
import { VoiceDiagnosticsIndicator } from './VoiceDiagnosticsIndicator';
import { applyVoiceDiagnosticsCaptureDirection } from './diagnosticsSettings';

type DiagnosticsClient = ReturnType<typeof createVoiceDiagnosticsClientForMachine>;
type DiagnosticsStatus = Awaited<ReturnType<DiagnosticsClient['status']>>;

function DiagnosticsExportRows(props: Readonly<{
  status: DiagnosticsStatus | null;
  showEmpty: boolean;
  busy: boolean;
  available: boolean;
  onExport: (artifact: NonNullable<DiagnosticsStatus>['artifacts'][number]) => void;
  showDivider?: boolean;
}>) {
  const artifacts = props.status?.artifacts ?? [];
  if (artifacts.length === 0 && !props.showEmpty) return null;
  return <SettingAnchor setting={VOICE_PRIVACY_SETTINGS.settings.diagnosticsExport}>
    <>
    {props.status?.artifacts.map((artifact, index) => (
      <Item
        key={artifact.id}
        testID={`settings-voice-diagnostics-artifact-${artifact.id}`}
        showDivider={index === 0 ? props.showDivider : true}
        disabled={props.busy || !props.available}
        loading={props.busy}
        title={artifact.direction === 'stt_input'
          ? tLoose('settingsVoice.diagnostics.exportSttArtifact')
          : tLoose('settingsVoice.diagnostics.exportTtsArtifact')}
        subtitle={`${artifact.format.toUpperCase()} · ${formatHappierDataBytes(artifact.byteLength, { kind: 'storage' })}`}
        accessibilityLabel={tLoose('settingsVoice.diagnostics.exportArtifactAccessibility')}
        onPress={() => props.onExport(artifact)}
      />
    ))}
    {props.showEmpty ? <Item
      showDivider={props.showDivider}
      mode="info"
      title={tLoose('settingsVoice.diagnostics.exportTitle')}
      subtitle={props.status ? tLoose('settingsVoice.diagnostics.noArtifacts') : tLoose('settingsVoice.diagnostics.unavailable')}
    /> : null}
    </>
  </SettingAnchor>;
}

export function VoiceDiagnosticsSettingsSection(props: Readonly<{
  voice: VoiceSettings;
  setVoice: (next: VoiceSettings) => void;
}>) {
  // The app-level attempt projection is the single owner of the active Voice
  // session. Settings reads it only to preserve the existing per-session
  // diagnostics opt-out; it does not infer a route or own a second lifecycle.
  const activeVoiceAttempt = useVoiceAttemptControl(VOICE_ATTEMPT_IDLE_TARGET_GLOBAL);
  // This Switch is a persistent, already meaningful Settings control. It is
  // the local focus return owner when an acknowledged diagnostics action
  // removes itself from the DOM.
  const diagnosticsEnabledSwitchRef = React.useRef<React.ElementRef<typeof Switch> | null>(null);
  const diagnostics = React.useMemo(
    () => readVoiceDiagnosticsSettings(props.voice),
    [props.voice.diagnostics],
  );
  const machineId = useVoiceExecutionMachineId();
  const machineLabel = useServerScopedMachineLabel(getActiveServerSnapshot().serverId ?? null, machineId);
  const accountLifetime = useActiveServerAccountScopeLifetime();
  const { execute } = useMountedActionExecution(accountLifetime?.scope);
  const actionAvailable = useSettingsSelector(settings => resolveActionSurfaceAvailability({
    actionId: 'settings.invoke', surface: 'ui', settings: settings.actionsSettingsV1,
  }).available, ['actionsSettingsV1']);
  const runtimeStatus = useVoiceDiagnosticsRuntimeStatus();
  const client = React.useMemo(
    () => machineId ? createVoiceDiagnosticsClientForMachine(machineId) : null,
    [machineId, accountLifetime],
  );
  const [status, setStatus] = React.useState<DiagnosticsStatus | null>(null);
  const [busy, setBusy] = React.useState(false);
  const operationLifetimeRef = React.useRef<AbortController | null>(null);
  React.useEffect(() => {
    const controller = new AbortController();
    const retirement = accountLifetime?.onRetire(() => controller.abort());
    operationLifetimeRef.current = controller;
    setBusy(false);
    return () => {
      if (operationLifetimeRef.current === controller) operationLifetimeRef.current = null;
      controller.abort();
      retirement?.dispose();
    };
  }, [client, accountLifetime]);
  const healthPresentation = status
    ? resolveVoiceSpeechDiagnosticsHealthPresentation(status.health)
    : null;
  const cleanupObligation = healthPresentation?.cleanupRequired === true;
  const captureFailure = status?.health.captureFailure === true;
  const canDelete = Boolean(status)
    && (status!.artifacts.length > 0 || cleanupObligation);

  const commit = React.useCallback(async (next: typeof diagnostics) => {
    if (busy) return;
    setBusy(true);
    try {
      props.setVoice(writeVoiceDiagnosticsSettings(props.voice, next));
      // Runtime sync is the sole desired-versus-actual policy writer. This
      // surface commits account intent and invalidates its read-only daemon
      // status until the owner reconciles the selected machine.
      setStatus(null);
    } finally {
      setBusy(false);
    }
  }, [busy, props]);

  React.useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const retirement = accountLifetime?.onRetire(() => controller.abort());
    setStatus(null);
    const selectedMachineIsReconciling = runtimeStatus.machineId === machineId
      && runtimeStatus.phase === 'transitioning';
    if (!client || selectedMachineIsReconciling) return () => { active = false; controller.abort(); retirement?.dispose(); };
    void client.status(controller.signal)
      .then((next) => { if (active && !controller.signal.aborted) setStatus(next); })
      .catch(() => { if (active) setStatus(null); });
    return () => { active = false; controller.abort(); retirement?.dispose(); };
  }, [client, diagnostics, machineId, runtimeStatus.machineId, runtimeStatus.phase, accountLifetime]);

  const invokeOperation = React.useCallback(async (
    anchor: string,
    input: SettingsDeclarationOperationInputV1 | undefined,
    failureKey: string,
    refresh?: (value: unknown, signal: AbortSignal) => DiagnosticsStatus | null | Promise<DiagnosticsStatus | null>,
  ) => {
    if (busy) return;
    const lifetime = operationLifetimeRef.current;
    if (!lifetime || lifetime.signal.aborted) return;
    const isCurrent = () => operationLifetimeRef.current === lifetime && !lifetime.signal.aborted;
    setBusy(true);
    try {
      const outcome = await execute('settings.invoke', { anchor, ...(input ? { input } : {}) }, { signal: lifetime.signal });
      if (!outcome.ok && presentActionTurnedOffNoticeIfOff(outcome, 'settings.invoke')) return;
      if (!outcome.ok && isActionApprovalDeclinedErrorCode(outcome.errorCode)) return;
      requireActionSuccess(outcome);
      const result = SettingsDeclarationActionOutputSchemasV1['settings.invoke'].parse(outcome.result);
      if (result.status === 'unavailable') throw new Error(result.reason ?? 'diagnostics_unavailable');
      if (result.status === 'completed' && refresh && isCurrent()) {
        const next = await refresh(result.value, lifetime.signal);
        if (isCurrent()) setStatus(next);
      }
    } catch {
      if (isCurrent()) await Modal.alert(tLoose('common.error'), tLoose(failureKey));
    } finally {
      if (isCurrent()) setBusy(false);
    }
  }, [busy, execute]);

  const toggleEnabled = (enabled: boolean) => {
    fireAndForget(invokeOperation(VOICE_PRIVACY_SETTINGS.settings.diagnosticsEnabled.anchor,
      { kind: 'diagnostics_enabled', enabled }, 'errors.operationFailed', () => null),
    { tag: 'VoiceDiagnosticsSettingsSection.toggleEnabled' });
  };

  const toggleDirection = (direction: 'captureSttInput' | 'captureTtsOutput', enabled: boolean) => {
    const next = applyVoiceDiagnosticsCaptureDirection(diagnostics, direction, enabled);
    fireAndForget(commit(next), { tag: `VoiceDiagnosticsSettingsSection.${direction}` });
  };

  const exportArtifact = (artifact: NonNullable<DiagnosticsStatus>['artifacts'][number]) => invokeOperation(
    VOICE_PRIVACY_SETTINGS.settings.diagnosticsExport.anchor,
    { kind: 'diagnostics_export', artifactId: artifact.id, ...(machineId ? { machineId } : {}) },
    'settingsVoice.diagnostics.exportFailed',
  );

  const retryCleanup = () => invokeOperation(VOICE_PRIVACY_SETTINGS.settings.diagnosticsCleanup.anchor,
    undefined, 'settingsVoice.diagnostics.cleanupRetryFailed', value => VoiceSpeechDiagnosticsStatusResponseV1Schema.parse(value));

  return (
    <SettingSection section={VOICE_PRIVACY_SETTINGS.sectionRefs.diagnostics}>
    <ItemGroup
      title={tLoose('settingsVoice.diagnostics.title')}
      description={tLoose('settingsVoice.diagnostics.footer')}
    >
      <SettingRow
        setting={VOICE_PRIVACY_SETTINGS.settings.diagnosticsEnabled}
        testID="settings-voice-diagnostics-enabled"
        subtitle={tLoose('settingsVoice.diagnostics.enabledSubtitle')}
        disabled={busy || !actionAvailable}
        rightElementOutsidePressable
        rightElement={(
          <Switch
            ref={diagnosticsEnabledSwitchRef}
            testID="settings-voice-diagnostics-enabled-switch"
            accessibilityLabel={tLoose('settingsVoice.diagnostics.enabled')}
            disabled={busy || !actionAvailable}
            value={diagnostics.enabled}
            onValueChange={toggleEnabled}
          />
        )}
      />
      {diagnostics.enabled ? (
        <>
          <SettingRow
            setting={VOICE_PRIVACY_SETTINGS.settings.diagnosticsSttInput}
            testID="settings-voice-diagnostics-stt-input"
            disabled={busy}
            rightElementOutsidePressable
            rightElement={(
              <Switch
                testID="settings-voice-diagnostics-stt-input-switch"
                accessibilityLabel={tLoose('settingsVoice.diagnostics.sttInput')}
                disabled={busy}
                value={diagnostics.captureSttInput}
                onValueChange={(value) => toggleDirection('captureSttInput', value)}
              />
            )}
          />
          <SettingRow
            setting={VOICE_PRIVACY_SETTINGS.settings.diagnosticsTtsOutput}
            testID="settings-voice-diagnostics-tts-output"
            disabled={busy}
            rightElementOutsidePressable
            rightElement={(
              <Switch
                testID="settings-voice-diagnostics-tts-output-switch"
                accessibilityLabel={tLoose('settingsVoice.diagnostics.ttsOutput')}
                disabled={busy}
                value={diagnostics.captureTtsOutput}
                onValueChange={(value) => toggleDirection('captureTtsOutput', value)}
              />
            )}
          />
        </>
      ) : null}
          <SettingRow
            setting={VOICE_PRIVACY_SETTINGS.settings.diagnosticsRetention}
            mode="info"
            subtitle={t('settingsVoice.diagnostics.retentionDetail', {
              hours: Math.round(diagnostics.maxAgeMs / 3_600_000),
              files: diagnostics.maxFiles,
              megabytes: Math.round(diagnostics.maxBytes / (1024 * 1024)),
            })}
            subtitleLines={0}
          />
          {/* What is on the Voice computer is known only once it answers; until then one line says so. */}
          {status ? (
            <>
          <SettingRow
            setting={VOICE_PRIVACY_SETTINGS.settings.diagnosticsLocation}
            testID={status.settings.enabled && status.settings.consentVersion === 1
              ? 'settings-voice-diagnostics-status-active'
              : 'settings-voice-diagnostics-status-inactive'}
            mode="info"
            // Where recordings live, said as a place on the person's machine; the path is plumbing.
            subtitle={machineLabel
              ? t('settingsVoice.diagnostics.locationOnMachine', { machine: machineLabel })
              : t('settingsVoice.diagnostics.locationPrivate')}
            subtitleLines={0}
          />
          <SettingRow
            setting={VOICE_PRIVACY_SETTINGS.settings.diagnosticsBackupPolicy}
            mode="info"
            subtitle={status.backupPolicy.status === 'best_effort'
              ? tLoose('settingsVoice.diagnostics.backupPolicyBestEffort')
              : tLoose('settingsVoice.diagnostics.unavailable')}
          />
          <DiagnosticsExportRows
            status={status}
            showEmpty={healthPresentation?.severity === 'healthy' && status.artifacts.length === 0}
            busy={busy}
            available={actionAvailable}
            onExport={(artifact) => { fireAndForget(exportArtifact(artifact), { tag: 'VoiceDiagnosticsSettingsSection.exportArtifact' }); }}
          />
            </>
          ) : (
            <SurfaceStateCard
              testID="settings-voice-diagnostics-unavailable"
              size="line"
              kind="unavailable"
              title={t('settingsVoice.pages.privacy.diagnosticsUnreachable')}
            />
          )}
          {captureFailure ? (
            <Item
              mode="info"
              title={tLoose('settingsVoice.diagnostics.captureFailed')}
              subtitle={tLoose('settingsVoice.diagnostics.captureFailedSubtitle')}
            />
          ) : null}
          {cleanupObligation ? (
            <Item
              mode="info"
              title={tLoose('settingsVoice.diagnostics.cleanupRequired')}
              subtitle={tLoose('settingsVoice.diagnostics.cleanupRequiredSubtitle')}
            />
          ) : null}
          {cleanupObligation ? (
            <SettingRow
              setting={VOICE_PRIVACY_SETTINGS.settings.diagnosticsCleanup}
              disabled={busy || !client || !actionAvailable}
              loading={busy}
              subtitle={tLoose('settingsVoice.diagnostics.retryCleanupSubtitle')}
              onPress={() => {
                fireAndForget(retryCleanup(), { tag: 'VoiceDiagnosticsSettingsSection.retryCleanup' });
              }}
            />
          ) : null}
          {canDelete ? <SettingRow
            setting={VOICE_PRIVACY_SETTINGS.settings.diagnosticsDelete}
            testID="settings-voice-diagnostics-delete-all"
            destructive
            disabled={busy || !actionAvailable}
            subtitle={tLoose('settingsVoice.diagnostics.deleteAllSubtitle')}
            onPress={() => {
              fireAndForget(invokeOperation(VOICE_PRIVACY_SETTINGS.settings.diagnosticsDelete.anchor,
                undefined, 'settingsVoice.diagnostics.deleteFailed', (_value, signal) => client?.status(signal) ?? null),
              { tag: 'VoiceDiagnosticsSettingsSection.deleteAll' });
            }}
          /> : null}
          <VoiceDiagnosticsIndicator
            wrapAction={(action, operation) => <SettingAnchor setting={operation === 'retry_shutdown'
              ? VOICE_PRIVACY_SETTINGS.settings.diagnosticsRetryShutdown
              : VOICE_PRIVACY_SETTINGS.settings.diagnosticsSessionOptOut}>{action}</SettingAnchor>}
            sessionId={activeVoiceAttempt.sessionId}
            focusFallbackRef={diagnosticsEnabledSwitchRef}
          />
    </ItemGroup>
    </SettingSection>
  );
}
