import * as React from 'react';
import { resolveVoiceSpeechDiagnosticsHealthPresentation } from '@happier-dev/protocol';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Switch } from '@/components/ui/forms/Switch';
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
import { createVoiceDiagnosticArtifactExportTarget } from './artifactExportTarget';
import { applyVoiceDiagnosticsMachinePolicy } from './runtimeRevocation';
import { useVoiceDiagnosticsRuntimeStatus } from './runtimeStatus';

type DiagnosticsClient = ReturnType<typeof createVoiceDiagnosticsClientForMachine>;
type DiagnosticsStatus = Awaited<ReturnType<DiagnosticsClient['status']>>;

export function VoiceDiagnosticsSettingsSection(props: Readonly<{
  voice: VoiceSettings;
  setVoice: (next: VoiceSettings) => void;
}>) {
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
    const next = { ...diagnostics, [direction]: enabled };
    if (!next.captureSttInput && !next.captureTtsOutput) {
      next.enabled = false;
      next.consentVersion = null;
    }
    fireAndForget(commit(next), { tag: `VoiceDiagnosticsSettingsSection.${direction}` });
  };

  const exportArtifact = React.useCallback(async (artifact: NonNullable<DiagnosticsStatus>['artifacts'][number]) => {
    if (busy || !client) return;
    const confirmed = await Modal.confirm(
      tLoose('settingsVoice.diagnostics.exportConfirmTitle'),
      tLoose('settingsVoice.diagnostics.exportConfirmBody'),
      { confirmText: tLoose('settingsVoice.diagnostics.exportAction') },
    );
    if (!confirmed) return;
    const name = `voice-diagnostic-${artifact.createdAtMs}-${artifact.direction}.${artifact.format}`;
    const targetResult = await createVoiceDiagnosticArtifactExportTarget({ name, sizeBytes: artifact.byteLength });
    if (!targetResult.ok) {
      await Modal.alert(tLoose('common.error'), tLoose('settingsVoice.diagnostics.exportFailed'));
      return;
    }
    setBusy(true);
    try {
      const result = await client.downloadArtifact({ artifactId: artifact.id, destination: targetResult.target.destination });
      if (!result.ok) throw new Error(result.error);
      await targetResult.target.complete(result.name);
    } catch {
      await Modal.alert(tLoose('common.error'), tLoose('settingsVoice.diagnostics.exportFailed'));
    } finally {
      await targetResult.target.cleanup();
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
    <ItemGroup
      title={tLoose('settingsVoice.diagnostics.title')}
      footer={tLoose('settingsVoice.diagnostics.footer')}
    >
      <Item
        testID="settings-voice-diagnostics-enabled"
        title={tLoose('settingsVoice.diagnostics.enabled')}
        subtitle={tLoose('settingsVoice.diagnostics.enabledSubtitle')}
        disabled={busy}
        rightElementOutsidePressable
        rightElement={(
          <Switch
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
          <Item
            testID="settings-voice-diagnostics-stt-input"
            title={tLoose('settingsVoice.diagnostics.sttInput')}
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
          <Item
            testID="settings-voice-diagnostics-tts-output"
            title={tLoose('settingsVoice.diagnostics.ttsOutput')}
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
          <Item
            testID={status?.settings.enabled && status.settings.consentVersion === 1
              ? 'settings-voice-diagnostics-status-active'
              : status
                ? 'settings-voice-diagnostics-status-inactive'
                : 'settings-voice-diagnostics-status-unavailable'}
            mode="info"
            title={tLoose('settingsVoice.diagnostics.location')}
            subtitle={status?.root ?? tLoose('settingsVoice.diagnostics.unavailable')}
            subtitleTestID="settings-voice-diagnostics-root"
            subtitleLines={2}
          />
          <Item
            mode="info"
            title={tLoose('settingsVoice.diagnostics.retention')}
            detail={t('settingsVoice.diagnostics.retentionDetail', {
              hours: Math.round(diagnostics.maxAgeMs / 3_600_000),
              files: diagnostics.maxFiles,
              megabytes: Math.round(diagnostics.maxBytes / (1024 * 1024)),
            })}
          />
          <Item
            mode="info"
            title={tLoose('settingsVoice.diagnostics.backupPolicy')}
            subtitle={status?.backupPolicy.status === 'best_effort'
              ? tLoose('settingsVoice.diagnostics.backupPolicyBestEffort')
              : tLoose('settingsVoice.diagnostics.unavailable')}
          />
          {status?.artifacts.map((artifact) => (
            <Item
              key={artifact.id}
              testID={`settings-voice-diagnostics-artifact-${artifact.id}`}
              disabled={busy}
              loading={busy}
              title={artifact.direction === 'stt_input'
                ? tLoose('settingsVoice.diagnostics.exportSttArtifact')
                : tLoose('settingsVoice.diagnostics.exportTtsArtifact')}
              subtitle={`${artifact.format.toUpperCase()} · ${Math.max(1, Math.ceil(artifact.byteLength / 1024))} KB`}
              accessibilityLabel={tLoose('settingsVoice.diagnostics.exportArtifactAccessibility')}
              onPress={() => { fireAndForget(exportArtifact(artifact), { tag: 'VoiceDiagnosticsSettingsSection.exportArtifact' }); }}
            />
          ))}
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
            <Item
              disabled={busy || !client}
              loading={busy}
              title={tLoose('settingsVoice.diagnostics.retryCleanup')}
              subtitle={tLoose('settingsVoice.diagnostics.retryCleanupSubtitle')}
              onPress={() => {
                fireAndForget(retryCleanup(), { tag: 'VoiceDiagnosticsSettingsSection.retryCleanup' });
              }}
            />
          ) : null}
          {!status || (healthPresentation?.severity === 'healthy' && status.artifacts.length === 0) ? (
            <Item
              mode="info"
              title={tLoose('settingsVoice.diagnostics.exportTitle')}
              subtitle={status ? tLoose('settingsVoice.diagnostics.noArtifacts') : tLoose('settingsVoice.diagnostics.unavailable')}
            />
          ) : null}
          <Item
            testID="settings-voice-diagnostics-delete-all"
            destructive
            disabled={busy || !canDelete}
            title={tLoose('settingsVoice.diagnostics.deleteAll')}
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
    </ItemGroup>
  );
}
