import * as React from 'react';
import { resolveVoiceSpeechDiagnosticsHealthPresentation } from '@happier-dev/protocol';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
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
import { useVoiceExecutionMachinePresentation } from '@/voice/credentials/useExecutionMachinePresentation';

import { createVoiceDiagnosticsClientForMachine } from './client';
import { exportVoiceDiagnosticArtifact } from './exportDiagnosticArtifact';
import { applyVoiceDiagnosticsMachinePolicy } from './runtimeRevocation';
import { useVoiceDiagnosticsRuntimeStatus } from './runtimeStatus';
import { VoiceDiagnosticsIndicator } from './VoiceDiagnosticsIndicator';
import { applyVoiceDiagnosticsCaptureDirection } from './diagnosticsSettings';

type DiagnosticsClient = ReturnType<typeof createVoiceDiagnosticsClientForMachine>;
type DiagnosticsStatus = Awaited<ReturnType<DiagnosticsClient['status']>>;

function DiagnosticsExportRows(props: Readonly<{
  status: DiagnosticsStatus | null;
  showEmpty: boolean;
  busy: boolean;
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
        disabled={props.busy}
        loading={props.busy}
        title={artifact.direction === 'stt_input'
          ? tLoose('settingsVoice.diagnostics.exportSttArtifact')
          : tLoose('settingsVoice.diagnostics.exportTtsArtifact')}
        subtitle={`${artifact.format.toUpperCase()} · ${Math.max(1, Math.ceil(artifact.byteLength / 1024))} KB`}
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
  const { machineId } = useVoiceExecutionMachinePresentation();
  const runtimeStatus = useVoiceDiagnosticsRuntimeStatus();
  const client = React.useMemo(
    () => machineId ? createVoiceDiagnosticsClientForMachine(machineId) : null,
    [machineId],
  );
  const [status, setStatus] = React.useState<DiagnosticsStatus | null>(null);
  const [busy, setBusy] = React.useState(false);
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
    setStatus(null);
    const selectedMachineIsReconciling = runtimeStatus.machineId === machineId
      && runtimeStatus.phase === 'transitioning';
    if (!client || selectedMachineIsReconciling) return () => { active = false; };
    void client.status()
      .then((next) => { if (active) setStatus(next); })
      .catch(() => { if (active) setStatus(null); });
    return () => { active = false; };
  }, [client, diagnostics, machineId, runtimeStatus.machineId, runtimeStatus.phase]);

  const toggleEnabled = (enabled: boolean) => {
    fireAndForget((async () => {
      if (!enabled) {
        await commit({ ...diagnostics, enabled: false, consentVersion: null });
        return;
      }
      const confirmed = await Modal.confirm(
        tLoose('settingsVoice.diagnostics.consentTitle'),
        tLoose('settingsVoice.diagnostics.consentBody'),
        { confirmText: tLoose('settingsVoice.diagnostics.consentAction') },
      );
      if (!confirmed) return;
      await commit({
        ...diagnostics,
        enabled: true,
        consentVersion: 1,
        captureSttInput: diagnostics.captureSttInput || !diagnostics.captureTtsOutput,
      });
    })(), { tag: 'VoiceDiagnosticsSettingsSection.toggleEnabled' });
  };

  const toggleDirection = (direction: 'captureSttInput' | 'captureTtsOutput', enabled: boolean) => {
    const next = applyVoiceDiagnosticsCaptureDirection(diagnostics, direction, enabled);
    fireAndForget(commit(next), { tag: `VoiceDiagnosticsSettingsSection.${direction}` });
  };

  const exportArtifact = React.useCallback(async (artifact: NonNullable<DiagnosticsStatus>['artifacts'][number]) => {
    if (busy || !client) return;
    setBusy(true);
    try {
      await exportVoiceDiagnosticArtifact({ client, artifact });
    } catch {
      await Modal.alert(tLoose('common.error'), tLoose('settingsVoice.diagnostics.exportFailed'));
    } finally {
      setBusy(false);
    }
  }, [busy, client]);

  const retryCleanup = React.useCallback(async () => {
    if (busy || !client || !machineId) return;
    setBusy(true);
    try {
      const result = await applyVoiceDiagnosticsMachinePolicy({
        machineId,
        settings: diagnostics,
      });
      setStatus(result.applied && result.acknowledged ? result.status : null);
    } catch {
      await Modal.alert(
        tLoose('common.error'),
        tLoose('settingsVoice.diagnostics.cleanupRetryFailed'),
      );
    } finally {
      setBusy(false);
    }
  }, [busy, client, diagnostics, machineId]);

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
        disabled={busy}
        rightElementOutsidePressable
        rightElement={(
          <Switch
            ref={diagnosticsEnabledSwitchRef}
            testID="settings-voice-diagnostics-enabled-switch"
            accessibilityLabel={tLoose('settingsVoice.diagnostics.enabled')}
            disabled={busy}
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
            setting={VOICE_PRIVACY_SETTINGS.settings.diagnosticsLocation}
            testID={status?.settings.enabled && status.settings.consentVersion === 1
              ? 'settings-voice-diagnostics-status-active'
              : status
                ? 'settings-voice-diagnostics-status-inactive'
                : 'settings-voice-diagnostics-status-unavailable'}
            mode="info"
            subtitle={status?.root ?? tLoose('settingsVoice.diagnostics.unavailable')}
            subtitleTestID="settings-voice-diagnostics-root"
            subtitleLines={2}
          />
          <SettingRow
            setting={VOICE_PRIVACY_SETTINGS.settings.diagnosticsRetention}
            mode="info"
            detail={t('settingsVoice.diagnostics.retentionDetail', {
              hours: Math.round(diagnostics.maxAgeMs / 3_600_000),
              files: diagnostics.maxFiles,
              megabytes: Math.round(diagnostics.maxBytes / (1024 * 1024)),
            })}
          />
          <SettingRow
            setting={VOICE_PRIVACY_SETTINGS.settings.diagnosticsBackupPolicy}
            mode="info"
            subtitle={status?.backupPolicy.status === 'best_effort'
              ? tLoose('settingsVoice.diagnostics.backupPolicyBestEffort')
              : tLoose('settingsVoice.diagnostics.unavailable')}
          />
          <DiagnosticsExportRows
            status={status}
            showEmpty={!status || (healthPresentation?.severity === 'healthy' && status.artifacts.length === 0)}
            busy={busy}
            onExport={(artifact) => { fireAndForget(exportArtifact(artifact), { tag: 'VoiceDiagnosticsSettingsSection.exportArtifact' }); }}
          />
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
              disabled={busy || !client}
              loading={busy}
              subtitle={tLoose('settingsVoice.diagnostics.retryCleanupSubtitle')}
              onPress={() => {
                fireAndForget(retryCleanup(), { tag: 'VoiceDiagnosticsSettingsSection.retryCleanup' });
              }}
            />
          ) : null}
          <SettingRow
            setting={VOICE_PRIVACY_SETTINGS.settings.diagnosticsDelete}
            testID="settings-voice-diagnostics-delete-all"
            destructive
            disabled={busy || !canDelete}
            subtitle={tLoose('settingsVoice.diagnostics.deleteAllSubtitle')}
            onPress={() => {
              fireAndForget((async () => {
                const confirmed = await Modal.confirm(
                  tLoose('settingsVoice.diagnostics.deleteConfirmTitle'),
                  tLoose('settingsVoice.diagnostics.deleteConfirmBody'),
                  { confirmText: tLoose('settingsVoice.diagnostics.deleteAction'), destructive: true },
                );
                if (!confirmed || busy) return;
                setBusy(true);
                try {
                  if (!client) return;
                  await client.deleteAll();
                  setStatus(await client.status());
                } catch {
                  await Modal.alert(
                    tLoose('common.error'),
                    tLoose('settingsVoice.diagnostics.deleteFailed'),
                  );
                } finally {
                  setBusy(false);
                }
              })(), { tag: 'VoiceDiagnosticsSettingsSection.deleteAll' });
            }}
          />
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
