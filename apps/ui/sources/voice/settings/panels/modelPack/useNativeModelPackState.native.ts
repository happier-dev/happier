import * as React from 'react';

import { Modal } from '@/modal';
import { t } from '@/text';
import {
  checkModelPackUpdateAvailable,
  ensureModelPackInstalled,
  findRunningModelPackInstall,
  getModelPackInstallSummary,
  removeModelPack,
} from '@/voice/modelPacks/installer.native';
import { isModelPackCancellation } from '@/voice/modelPacks/installer/network';
import { formatModelPackBuildLabel } from '@/voice/modelPacks/formatBuildLabel';
import { fireAndForget } from '@/utils/system/fireAndForget';
import {
  confirmDiscardPartialDownload,
  describeModelPackInstallError,
  readPartialDownloadBytes,
  type ModelPackRowStatus,
} from '@/voice/settings/panels/modelPack/modelPackTransferRows';

type ModelStatus = ModelPackRowStatus;

const ttsCopy = {
  prepareFailedTitle: 'common.error',
  removeTitle: 'settingsVoice.local.kokoro.removeAssets.confirmTitle',
  removeBody: 'settingsVoice.local.kokoro.removeAssets.confirmBody',
  removeButton: 'settingsVoice.local.kokoro.removeAssets.confirmButton',
  notInstalledTitle: 'settingsVoice.local.kokoro.alerts.notInstalledTitle',
  notInstalledBody: 'settingsVoice.local.kokoro.alerts.notInstalledBody',
  upToDateTitle: 'settingsVoice.local.kokoro.alerts.upToDateTitle',
  upToDateBody: 'settingsVoice.local.kokoro.alerts.upToDateBody',
  updateAvailableTitle: 'settingsVoice.local.kokoro.alerts.updateAvailableTitle',
  updateAvailableBody: 'settingsVoice.local.kokoro.alerts.updateAvailableBody',
  updatedTitle: 'settingsVoice.local.kokoro.alerts.updatedTitle',
  updatedBody: 'settingsVoice.local.kokoro.alerts.updatedBody',
  updateFailedTitle: 'settingsVoice.local.kokoro.alerts.updateFailedTitle',
  updateFailedBody: 'settingsVoice.local.kokoro.alerts.updateFailedBody',
} as const;

const sttCopy = {
  prepareFailedTitle: 'settingsVoice.local.localNeuralStt.alerts.downloadFailedTitle',
  removeTitle: 'settingsVoice.local.localNeuralStt.removeModelFiles.confirmTitle',
  removeBody: 'settingsVoice.local.localNeuralStt.removeModelFiles.confirmBody',
  removeButton: 'common.remove',
  notInstalledTitle: 'settingsVoice.local.localNeuralStt.alerts.notInstalledTitle',
  notInstalledBody: 'settingsVoice.local.localNeuralStt.alerts.notInstalledBody',
  upToDateTitle: 'settingsVoice.local.kokoro.updates.upToDate',
  upToDateBody: 'settingsVoice.local.localNeuralStt.alerts.upToDateBody',
  updateAvailableTitle: 'settingsVoice.local.kokoro.updates.updateAvailable',
  updateAvailableBody: 'settingsVoice.local.localNeuralStt.alerts.updateAvailableBody',
  updatedTitle: 'settingsVoice.local.localNeuralStt.alerts.updatedTitle',
  updatedBody: 'settingsVoice.local.localNeuralStt.alerts.updatedBody',
  updateFailedTitle: 'settingsVoice.local.localNeuralStt.alerts.updateFailedTitle',
  updateFailedBody: 'settingsVoice.local.localNeuralStt.alerts.updateFailedBody',
} as const;

/** One install lifecycle for native STT files and Kokoro TTS files plus runtime warmup. */
export function useNativeModelPackState(params: {
  packId: string | null;
  manifestUrl: string | null;
} & ({ role: 'stt' } | { role: 'tts'; networkTimeoutMs: number })): Readonly<{
  modelStatus: ModelStatus;
  downloadProgress: unknown | null;
  installed: boolean;
  installSummary: Awaited<ReturnType<typeof getModelPackInstallSummary>> | null;
  updateCheckedRemote: null | { build: string | null; updateAvailable: boolean };
  refreshInstallState: () => Promise<void>;
  prepareModel: () => Promise<void>;
  cancelPrepare: () => void;
  clearAssets: () => void;
  checkForUpdates: () => void;
}> {
  const isStt = params.role === 'stt';
  const copy = isStt ? sttCopy : ttsCopy;
  const kind = isStt ? 'stt_sherpa' : 'tts_sherpa';
  const networkTimeoutMs = params.role === 'tts' ? params.networkTimeoutMs : 0;
  const [modelStatus, setModelStatus] = React.useState<ModelStatus>('idle');
  const [downloadProgress, setDownloadProgress] = React.useState<unknown | null>(null);
  const prepareAbortRef = React.useRef<AbortController | null>(null);
  const [installed, setInstalled] = React.useState<boolean>(false);
  const [installSummary, setInstallSummary] = React.useState<null | Awaited<ReturnType<typeof getModelPackInstallSummary>>>(null);
  const [updateCheckedRemote, setUpdateCheckedRemote] = React.useState<null | { build: string | null; updateAvailable: boolean }>(null);

  const mountedRef = React.useRef(true);
  const selection = React.useMemo(() => ({ packId: params.packId, kind }), [params.packId, kind]);
  const selectionRef = React.useRef(selection);
  React.useLayoutEffect(() => {
    selectionRef.current = selection;
    // Detach this view from its predecessor; the installer still owns that download.
    prepareAbortRef.current = null;
    setModelStatus('idle');
    setDownloadProgress(null);
    setInstalled(false);
    setInstallSummary(null);
    setUpdateCheckedRemote(null);
  }, [selection]);
  const isCurrent = React.useCallback(() => mountedRef.current && selectionRef.current === selection, [selection]);

  const refreshInstallState = React.useCallback(async () => {
    if (!params.packId || !isCurrent()) return;
    try {
      const summary = await getModelPackInstallSummary({ packId: params.packId });
      if (!isCurrent()) return;
      setInstallSummary(summary);
      setInstalled(summary.installed);
      setModelStatus((cur) => (cur === 'downloading' ? cur : summary.installed ? 'ready' : 'idle'));
      setUpdateCheckedRemote(null);
    } catch (error) {
      console.warn('[modelPacks] Failed to refresh native model pack state', error);
      if (!isCurrent()) return;
      setInstallSummary(null);
      setInstalled(false);
      setModelStatus((cur) => (cur === 'downloading' ? cur : 'idle'));
      setUpdateCheckedRemote(null);
    }
  }, [isCurrent, params.packId]);

  // An install outlives the screen that started it; only a mounted screen reports its outcome.
  React.useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const runInstall = React.useCallback(async (install: (signal: AbortSignal, onProgress: (progress: unknown) => void) => Promise<unknown>) => {
    if (!isCurrent()) return;
    const abortController = new AbortController();
    try {
      setModelStatus('downloading');
      setDownloadProgress(null);
      prepareAbortRef.current = abortController;
      await install(abortController.signal, progress => { if (isCurrent()) setDownloadProgress(progress); });
      if (!isCurrent()) return;
      setModelStatus('ready');
      await refreshInstallState();
    } catch (error) {
      if (!isCurrent()) return;
      if (isModelPackCancellation(error, abortController.signal)) {
        // Cancelling discards the partial pack; report what is on disk now.
        setModelStatus('idle');
        await refreshInstallState();
        return;
      }
      // Verified files stay on disk after a failure; read them so the screen can offer resume or discard.
      await refreshInstallState();
      if (!isCurrent()) return;
      setModelStatus('error');
      const message = describeModelPackInstallError(error);
      await Modal.alert(
        t(copy.prepareFailedTitle),
        isStt ? t('settingsVoice.local.localNeuralStt.alerts.downloadFailedBody', { message }) : message,
      );
    } finally {
      if (isCurrent() && prepareAbortRef.current === abortController) {
        prepareAbortRef.current = null;
        setDownloadProgress(null);
      }
    }
  }, [copy, isCurrent, isStt, refreshInstallState]);

  React.useEffect(() => {
    let active = true;
    fireAndForget((async () => {
      await refreshInstallState();
      if (!params.packId || !active) return;
      // A download started by an earlier visit to this screen keeps running; show it instead of its leftovers.
      const running = findRunningModelPackInstall({ packId: params.packId });
      if (!running || !active || prepareAbortRef.current) return;
      await runInstall((signal, onProgress) => running.follow({ signal, onProgress }));
    })(), { tag: 'useNativeModelPackState.followRunningInstall' });
    return () => { active = false; };
  }, [params.packId, refreshInstallState, runInstall]);

  const prepareModel = React.useCallback(async () => {
    if (!isCurrent() || !params.packId || modelStatus === 'downloading' || prepareAbortRef.current) return;
    if (isStt && !params.manifestUrl) {
      await Modal.alert(
        t('settingsVoice.local.kokoro.alerts.missingManifest.title'),
        t('settingsVoice.local.kokoro.alerts.missingManifest.body'),
      );
      return;
    }
    const packId = params.packId;
    await runInstall(async (signal, onProgress) => {
      if (isStt) {
        await ensureModelPackInstalled({
          packId,
          mode: 'download_if_missing',
          manifestUrl: params.manifestUrl,
          timeoutMs: 120_000,
          signal,
          onProgress,
          kind,
        });
        return;
      }
      const { prepareKokoroTts } = await import('@/voice/kokoro/runtime/synthesizeKokoroWav');
      await prepareKokoroTts({
        assetSetId: packId,
        timeoutMs: Math.max(60_000, networkTimeoutMs),
        signal,
        onProgress,
      });
    });
  }, [isCurrent, isStt, kind, modelStatus, params.manifestUrl, networkTimeoutMs, params.packId, runInstall]);

  const cancelPrepare = React.useCallback(() => {
    const controller = prepareAbortRef.current;
    if (!controller) return;
    try {
      controller.abort();
    } catch {
      // ignore
    }
  }, []);

  const clearAssets = React.useCallback(() => {
    fireAndForget((async () => {
      if (!isCurrent() || !params.packId || modelStatus === 'downloading' || prepareAbortRef.current) return;
      const abortController = new AbortController();
      prepareAbortRef.current = abortController;
      try {
        const partialBytes = readPartialDownloadBytes(installSummary);
        const confirmed = partialBytes > 0
          ? await confirmDiscardPartialDownload(partialBytes)
          : await Modal.confirm(
            t(copy.removeTitle),
            t(copy.removeBody),
            { confirmText: t(copy.removeButton), ...(isStt ? { destructive: true } : {}) },
          );
        if (!confirmed || !isCurrent()) return;
        try {
          await removeModelPack({ packId: params.packId });
        } finally {
          // Removing the live pack can succeed before staged-file cleanup fails.
          if (isCurrent()) {
            setModelStatus('idle');
            setDownloadProgress(null);
            await refreshInstallState();
          }
        }
      } catch (error) {
        if (isCurrent()) await Modal.alert(t('common.error'), error instanceof Error ? error.message : String(error));
      } finally {
        if (isCurrent() && prepareAbortRef.current === abortController) prepareAbortRef.current = null;
      }
    })(), { tag: 'useNativeModelPackState.confirm.clearAssets' });
  }, [copy, installSummary, isCurrent, isStt, modelStatus, params.packId, refreshInstallState]);

  const checkForUpdates = React.useCallback(() => {
    fireAndForget((async () => {
      if (!isCurrent() || !params.packId || modelStatus === 'downloading' || prepareAbortRef.current) return;
      if (!params.manifestUrl) {
        await Modal.alert(
          t('settingsVoice.local.kokoro.alerts.missingManifest.title'),
          t('settingsVoice.local.kokoro.alerts.missingManifest.body'),
        );
        return;
      }

      const abortController = new AbortController();
      prepareAbortRef.current = abortController;
      try {
        const status = await checkModelPackUpdateAvailable({
          packId: params.packId,
          manifestUrl: params.manifestUrl,
          timeoutMs: Math.max(30_000, networkTimeoutMs),
          signal: abortController.signal,
          kind,
        });
        if (!isCurrent()) return;

        if (!status.installed) {
          await Modal.alert(
            t(copy.notInstalledTitle),
            t(copy.notInstalledBody),
          );
          return;
        }
        const remoteBuild = formatModelPackBuildLabel(status.remoteManifest);
        setUpdateCheckedRemote({ build: remoteBuild, updateAvailable: status.updateAvailable });
        if (!status.updateAvailable) {
          await Modal.alert(
            t(copy.upToDateTitle),
            t(copy.upToDateBody),
          );
          return;
        }

        const ok = await Modal.confirm(
          t(copy.updateAvailableTitle),
          t(copy.updateAvailableBody, { remoteBuild }),
          {
            confirmText: t('common.update'),
          },
        );
        if (!ok || !isCurrent()) return;

        setModelStatus('downloading');
        setDownloadProgress(null);
        await ensureModelPackInstalled({
          packId: params.packId,
          mode: 'download_if_missing',
          updatePolicy: 'manual_update_if_available',
          manifestUrl: params.manifestUrl,
          timeoutMs: Math.max(120_000, networkTimeoutMs),
          signal: abortController.signal,
          onProgress: progress => { if (isCurrent()) setDownloadProgress(progress); },
          kind,
        });

        if (!isCurrent()) return;
        setModelStatus('ready');
        await refreshInstallState();
        if (!isCurrent()) return;
        await Modal.alert(
          t(copy.updatedTitle),
          t(copy.updatedBody),
        );
      } catch (error) {
        if (!isCurrent()) return;
        if (!isModelPackCancellation(error, abortController.signal)) {
          await Modal.alert(
            t(copy.updateFailedTitle),
            t(copy.updateFailedBody, { message: describeModelPackInstallError(error) }),
          );
        }
        if (!isCurrent()) return;
        // A failed or cancelled update leaves the installed pack in place; report what is on disk.
        setModelStatus('idle');
        await refreshInstallState();
      } finally {
        if (isCurrent() && prepareAbortRef.current === abortController) {
          prepareAbortRef.current = null;
          setDownloadProgress(null);
        }
      }
    })(), { tag: 'useNativeModelPackState.checkForUpdates' });
  }, [copy, isCurrent, kind, modelStatus, params.manifestUrl, networkTimeoutMs, params.packId, refreshInstallState]);

  return {
    modelStatus,
    downloadProgress,
    installed,
    installSummary,
    updateCheckedRemote,
    refreshInstallState,
    prepareModel,
    cancelPrepare,
    clearAssets,
    checkForUpdates,
  };
}
