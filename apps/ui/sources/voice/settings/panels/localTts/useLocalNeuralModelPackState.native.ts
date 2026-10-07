import * as React from 'react';

import { Modal } from '@/modal';
import { t } from '@/text';
import { formatDownloadProgressDetail } from '@/voice/downloads/downloadProgress';
import { getModelPackInstallSummary } from '@/voice/modelPacks/installer.native';
import { invokeVoiceDeviceModelPackOperation } from '@/voice/settings/voiceDeviceModelPackOperation.native';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { captureActiveServerAccountScopeCurrentness } from '@/sync/domains/scope/activeServerAccountScope';

type ModelStatus = 'idle' | 'downloading' | 'ready' | 'error';

/** Native STT and TTS share settings state; consent and installer admission live in the operation owner. */
export function useLocalNeuralModelPackState(params: {
  packId: string;
  manifestUrl: string | null;
  role?: 'stt_sherpa' | 'tts_sherpa';
  enabled?: boolean;
}) {
  const role = params.role ?? 'tts_sherpa';
  const enabled = params.enabled ?? true;
  const selectionRef = React.useRef({ packId: params.packId, role, enabled });
  React.useLayoutEffect(() => {
    // Suspended replacement renders must not retarget a committed operation.
    selectionRef.current = { packId: params.packId, role, enabled };
  }, [enabled, params.packId, role]);
  const mountedRef = React.useRef(true);
  const [modelStatus, setModelStatus] = React.useState<ModelStatus>('idle');
  const [downloadProgress, setDownloadProgress] = React.useState<unknown | null>(null);
  const prepareAbortRef = React.useRef<AbortController | null>(null);
  const [installed, setInstalled] = React.useState(false);
  const [installSummary, setInstallSummary] = React.useState<Awaited<ReturnType<typeof getModelPackInstallSummary>> | null>(null);
  const [updateCheckedRemote, setUpdateCheckedRemote] = React.useState<{ build: string | null; updateAvailable: boolean } | null>(null);

  const isCurrent = React.useCallback(() => mountedRef.current && enabled
    && selectionRef.current.enabled && selectionRef.current.packId === params.packId
    && selectionRef.current.role === role, [enabled, params.packId, role]);

  const refreshInstallState = React.useCallback(async () => {
    if (!isCurrent()) return;
    const accountLifetime = captureActiveServerAccountScopeCurrentness();
    try {
      const summary = await getModelPackInstallSummary({ packId: params.packId });
      if (!isCurrent() || !accountLifetime.isCurrent()) return;
      setInstallSummary(summary);
      setInstalled(summary.installed);
      setModelStatus((cur) => cur === 'downloading' ? cur : summary.installed ? 'ready' : 'idle');
      setUpdateCheckedRemote(null);
    } catch {
      if (!isCurrent() || !accountLifetime.isCurrent()) return;
      setInstallSummary(null);
      setInstalled(false);
      setModelStatus((cur) => cur === 'downloading' ? cur : 'idle');
      setUpdateCheckedRemote(null);
    }
  }, [isCurrent, params.packId]);

  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      prepareAbortRef.current?.abort();
    };
  }, []);

  React.useEffect(() => {
    prepareAbortRef.current?.abort();
    prepareAbortRef.current = null;
    setModelStatus('idle');
    setDownloadProgress(null);
    setInstalled(false);
    setInstallSummary(null);
    setUpdateCheckedRemote(null);
    void refreshInstallState();
  }, [refreshInstallState]);

  const runOperation = React.useCallback(async (operation: 'prepare' | 'remove' | 'update') => {
    if (!isCurrent() || prepareAbortRef.current) return;
    const controller = new AbortController();
    const accountLifetime = captureActiveServerAccountScopeCurrentness();
    prepareAbortRef.current = controller;
    const accountRetirement = accountLifetime.onRetire(() => {
      controller.abort();
      if (prepareAbortRef.current === controller) prepareAbortRef.current = null;
      if (isCurrent()) {
        setModelStatus(installed ? 'ready' : 'idle');
        setDownloadProgress(null);
      }
    });
    const current = () => isCurrent() && accountLifetime.isCurrent() && !controller.signal.aborted;
    let checkedUpdateAvailable: boolean | null = null;
    try {
      const result = await invokeVoiceDeviceModelPackOperation({
        operation, packId: params.packId, role, manifestUrl: params.manifestUrl,
        signal: controller.signal, isCurrent: current,
        onDownloadStarted: () => {
          if (!current()) return;
          setModelStatus('downloading');
          setDownloadProgress(null);
        },
        onProgress: (progress) => { if (current()) setDownloadProgress(progress); },
        onUpdateChecked: (status) => {
          if (!current()) return;
          checkedUpdateAvailable = status.updateAvailable;
          setUpdateCheckedRemote(status);
        },
      });
      if (!current()) return;
      if (result.status === 'unavailable') {
        if (result.reason === 'model_manifest_unavailable') {
          await Modal.alert(t('settingsVoice.local.kokoro.alerts.missingManifest.title'),
            t('settingsVoice.local.kokoro.alerts.missingManifest.body'));
        } else if (result.reason === 'model_not_installed') {
          await Modal.alert(
            t(role === 'stt_sherpa' ? 'settingsVoice.local.localNeuralStt.alerts.notInstalledTitle' : 'settingsVoice.local.kokoro.alerts.notInstalledTitle'),
            t(role === 'stt_sherpa' ? 'settingsVoice.local.localNeuralStt.alerts.notInstalledBody' : 'settingsVoice.local.kokoro.alerts.notInstalledBody'));
        }
        return;
      }
      if (result.status !== 'completed') return;
      if (operation === 'update' && checkedUpdateAvailable === false) {
        await Modal.alert(
          t(role === 'stt_sherpa' ? 'settingsVoice.local.kokoro.updates.upToDate' : 'settingsVoice.local.kokoro.alerts.upToDateTitle'),
          t(role === 'stt_sherpa' ? 'settingsVoice.local.localNeuralStt.alerts.upToDateBody' : 'settingsVoice.local.kokoro.alerts.upToDateBody'));
        return;
      }
      setModelStatus(operation === 'remove' ? 'idle' : 'ready');
      await refreshInstallState();
      if (operation === 'update' && current()) {
        await Modal.alert(
          t(role === 'stt_sherpa' ? 'settingsVoice.local.localNeuralStt.alerts.updatedTitle' : 'settingsVoice.local.kokoro.alerts.updatedTitle'),
          t(role === 'stt_sherpa' ? 'settingsVoice.local.localNeuralStt.alerts.updatedBody' : 'settingsVoice.local.kokoro.alerts.updatedBody'));
      }
    } catch (error) {
      if (!isCurrent() || !accountLifetime.isCurrent()) return;
      if (controller.signal.aborted) {
        setModelStatus(installed ? 'ready' : 'idle');
        return;
      }
      setModelStatus('error');
      const message = error instanceof Error ? error.message : String(error);
      if (operation === 'update') {
        await Modal.alert(
          t(role === 'stt_sherpa' ? 'settingsVoice.local.localNeuralStt.alerts.updateFailedTitle' : 'settingsVoice.local.kokoro.alerts.updateFailedTitle'),
          role === 'stt_sherpa'
            ? t('settingsVoice.local.localNeuralStt.alerts.updateFailedBody', { message })
            : t('settingsVoice.local.kokoro.alerts.updateFailedBody', { message }));
      } else if (role === 'stt_sherpa' && operation === 'prepare') {
        await Modal.alert(t('settingsVoice.local.localNeuralStt.alerts.downloadFailedTitle'),
          t('settingsVoice.local.localNeuralStt.alerts.downloadFailedBody', { message }));
      } else {
        await Modal.alert(t('common.error'), message);
      }
    } finally {
      accountRetirement.dispose();
      if (prepareAbortRef.current === controller) {
        prepareAbortRef.current = null;
        if (isCurrent()) setDownloadProgress(null);
      }
    }
  }, [installed, isCurrent, params.manifestUrl, params.packId, refreshInstallState, role]);

  const prepareModel = React.useCallback(() => runOperation('prepare'), [runOperation]);
  const cancelPrepare = React.useCallback(() => { prepareAbortRef.current?.abort(); }, []);
  const clearAssets = React.useCallback(() => {
    fireAndForget(runOperation('remove'), { tag: 'useLocalNeuralModelPackState.clearAssets' });
  }, [runOperation]);
  const checkForUpdates = React.useCallback(() => {
    fireAndForget(runOperation('update'), { tag: 'useLocalNeuralModelPackState.checkForUpdates' });
  }, [runOperation]);
  const downloadDetail = React.useMemo(() => {
    if (modelStatus !== 'downloading') return null;
    return downloadProgress
      ? formatDownloadProgressDetail(downloadProgress, { prefix: t('settingsVoice.local.kokoro.modelStatus.downloadingPrefix') })
      : t('settingsVoice.local.kokoro.modelStatus.downloading');
  }, [downloadProgress, modelStatus]);

  return { modelStatus, downloadProgress, downloadDetail, installed, installSummary, updateCheckedRemote,
    refreshInstallState, prepareModel, cancelPrepare, clearAssets, checkForUpdates } as const;
}
