import * as React from 'react';

import { Modal } from '@/modal';
import { t } from '@/text';
import { prepareKokoroTts } from '@/voice/kokoro/runtime/synthesizeKokoroWav';
import { formatDownloadProgressDetail } from '@/voice/downloads/downloadProgress';
import { checkModelPackUpdateAvailable, ensureModelPackInstalled, getModelPackInstallSummary, removeModelPack } from '@/voice/modelPacks/installer.native';
import { formatModelPackBuildLabel } from '@/voice/modelPacks/formatBuildLabel';
import { fireAndForget } from '@/utils/system/fireAndForget';

type ModelStatus = 'idle' | 'downloading' | 'ready' | 'error';

export function useLocalNeuralModelPackState(params: {
  packId: string;
  manifestUrl: string | null;
  networkTimeoutMs: number;
}): Readonly<{
  modelStatus: ModelStatus;
  downloadProgress: unknown | null;
  downloadDetail: string | null;
  installed: boolean;
  installSummary: Awaited<ReturnType<typeof getModelPackInstallSummary>> | null;
  updateCheckedRemote: null | { build: string | null; updateAvailable: boolean };
  refreshInstallState: () => Promise<void>;
  prepareModel: () => Promise<void>;
  cancelPrepare: () => void;
  clearAssets: () => void;
  checkForUpdates: () => void;
}> {
  const [modelStatus, setModelStatus] = React.useState<ModelStatus>('idle');
  const [downloadProgress, setDownloadProgress] = React.useState<unknown | null>(null);
  const prepareAbortRef = React.useRef<AbortController | null>(null);
  const [installed, setInstalled] = React.useState<boolean>(false);
  const [installSummary, setInstallSummary] = React.useState<null | Awaited<ReturnType<typeof getModelPackInstallSummary>>>(null);
  const [updateCheckedRemote, setUpdateCheckedRemote] = React.useState<null | { build: string | null; updateAvailable: boolean }>(null);

  const refreshInstallState = React.useCallback(async () => {
    try {
      const summary = await getModelPackInstallSummary({ packId: params.packId });
      setInstallSummary(summary);
      setInstalled(summary.installed);
      setModelStatus((cur) => (cur === 'downloading' ? cur : summary.installed ? 'ready' : 'idle'));
      setUpdateCheckedRemote(null);
    } catch {
      setInstallSummary(null);
      setInstalled(false);
      setModelStatus((cur) => (cur === 'downloading' ? cur : 'idle'));
      setUpdateCheckedRemote(null);
    }
  }, [params.packId]);

  React.useEffect(() => {
    void refreshInstallState();
  }, [refreshInstallState]);

  const prepareModel = React.useCallback(async () => {
    if (modelStatus === 'downloading') return;

    try {
      setModelStatus('downloading');
      setDownloadProgress(null);
      const abortController = new AbortController();
      prepareAbortRef.current = abortController;

      await prepareKokoroTts({
        assetSetId: params.packId,
        timeoutMs: Math.max(60000, params.networkTimeoutMs),
        signal: abortController.signal,
        onProgress: (progress) => {
          setDownloadProgress(progress);
        },
      });

      setModelStatus('ready');
      await refreshInstallState();
    } catch (error) {
      if (prepareAbortRef.current?.signal?.aborted) return;
      setModelStatus('error');
      await Modal.alert(t('common.error'), error instanceof Error ? error.message : String(error));
    } finally {
      prepareAbortRef.current = null;
    }
  }, [modelStatus, params.networkTimeoutMs, params.packId, refreshInstallState]);

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
      if (modelStatus === 'downloading') return;
      const confirmed = await Modal.confirm(
        t('settingsVoice.local.kokoro.removeAssets.confirmTitle'),
        t('settingsVoice.local.kokoro.removeAssets.confirmBody'),
        { confirmText: t('settingsVoice.local.kokoro.removeAssets.confirmButton') },
      );
      if (!confirmed) return;
      await removeModelPack({ packId: params.packId });
      setModelStatus('idle');
      setDownloadProgress(null);
      await refreshInstallState();
    })(), { tag: 'useLocalNeuralModelPackState.confirm.clearAssets' });
  }, [modelStatus, params.packId, refreshInstallState]);

  const checkForUpdates = React.useCallback(() => {
    fireAndForget((async () => {
      if (modelStatus === 'downloading') return;
      if (!params.manifestUrl) {
        await Modal.alert(
          t('settingsVoice.local.kokoro.alerts.missingManifest.title'),
          t('settingsVoice.local.kokoro.alerts.missingManifest.body'),
        );
        return;
      }

      const abortController = new AbortController();
      try {
        const status = await checkModelPackUpdateAvailable({
          packId: params.packId,
          manifestUrl: params.manifestUrl,
          timeoutMs: Math.max(30_000, params.networkTimeoutMs),
          signal: abortController.signal,
        });

        if (!status.installed) {
          await Modal.alert(
            t('settingsVoice.local.kokoro.alerts.notInstalledTitle'),
            t('settingsVoice.local.kokoro.alerts.notInstalledBody'),
          );
          return;
        }
        const remoteBuild = formatModelPackBuildLabel(status.remoteManifest);
        setUpdateCheckedRemote({ build: remoteBuild, updateAvailable: status.updateAvailable });
        if (!status.updateAvailable) {
          await Modal.alert(
            t('settingsVoice.local.kokoro.alerts.upToDateTitle'),
            t('settingsVoice.local.kokoro.alerts.upToDateBody'),
          );
          return;
        }

        const ok = await Modal.confirm(
          t('settingsVoice.local.kokoro.alerts.updateAvailableTitle'),
          t('settingsVoice.local.kokoro.alerts.updateAvailableBody', { remoteBuild }),
          {
            confirmText: t('common.update'),
          },
        );
        if (!ok) return;

        setModelStatus('downloading');
        setDownloadProgress(null);
        prepareAbortRef.current = abortController;

        await ensureModelPackInstalled({
          packId: params.packId,
          mode: 'download_if_missing',
          updatePolicy: 'manual_update_if_available',
          manifestUrl: params.manifestUrl,
          timeoutMs: Math.max(120_000, params.networkTimeoutMs),
          signal: abortController.signal,
          onProgress: (p) => {
            setDownloadProgress(p);
          },
        });

        setModelStatus('ready');
        await refreshInstallState();
        await Modal.alert(
          t('settingsVoice.local.kokoro.alerts.updatedTitle'),
          t('settingsVoice.local.kokoro.alerts.updatedBody'),
        );
      } catch (error) {
        if (abortController.signal.aborted) return;
        await Modal.alert(
          t('settingsVoice.local.kokoro.alerts.updateFailedTitle'),
          t('settingsVoice.local.kokoro.alerts.updateFailedBody', { message: String((error as any)?.message ?? error) }),
        );
        setModelStatus('error');
      } finally {
        prepareAbortRef.current = null;
        setDownloadProgress(null);
      }
    })(), { tag: 'useLocalNeuralModelPackState.checkForUpdates' });
  }, [modelStatus, params.manifestUrl, params.networkTimeoutMs, params.packId, refreshInstallState]);

  const downloadDetail = React.useMemo(() => {
    if (modelStatus !== 'downloading') return null;
    return downloadProgress
      ? formatDownloadProgressDetail(downloadProgress, { prefix: t('settingsVoice.local.kokoro.modelStatus.downloadingPrefix') })
      : t('settingsVoice.local.kokoro.modelStatus.downloading');
  }, [downloadProgress, modelStatus]);

  return {
    modelStatus,
    downloadProgress,
    downloadDetail,
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
