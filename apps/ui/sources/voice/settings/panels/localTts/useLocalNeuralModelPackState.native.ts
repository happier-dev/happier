import * as React from 'react';

import { Modal } from '@/modal';
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
      await Modal.alert('Error', error instanceof Error ? error.message : String(error));
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
        'Remove Kokoro assets?',
        'This removes downloaded Kokoro files from this device.',
        { confirmText: 'Remove' },
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
          'Manifest URL missing',
          'Unable to resolve the model pack manifest URL. Check EXPO_PUBLIC_HAPPIER_MODEL_PACK_MANIFESTS (or legacy Kokoro env vars).',
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
          await Modal.alert('Not installed', 'Download the model pack first to enable update checks.');
          return;
        }
        const remoteBuild = formatModelPackBuildLabel(status.remoteManifest);
        setUpdateCheckedRemote({ build: remoteBuild, updateAvailable: status.updateAvailable });
        if (!status.updateAvailable) {
          await Modal.alert('Up to date', 'No updates are available for this model pack.');
          return;
        }

        const ok = await Modal.confirm(
          'Update available',
          `Download the latest version of this model pack now?${remoteBuild ? `\n\nRemote build: ${remoteBuild}` : ''}`,
          {
            confirmText: 'Update',
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
        await Modal.alert('Updated', 'Model pack updated successfully.');
      } catch (error) {
        if (abortController.signal.aborted) return;
        await Modal.alert('Update failed', `Unable to update this model pack.\n\n${String((error as any)?.message ?? error)}`);
        setModelStatus('error');
      } finally {
        prepareAbortRef.current = null;
        setDownloadProgress(null);
      }
    })(), { tag: 'useLocalNeuralModelPackState.checkForUpdates' });
  }, [modelStatus, params.manifestUrl, params.networkTimeoutMs, params.packId, refreshInstallState]);

  const downloadDetail = React.useMemo(() => {
    if (modelStatus !== 'downloading') return null;
    return downloadProgress ? formatDownloadProgressDetail(downloadProgress, { prefix: 'Downloading' }) : 'Downloading…';
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
