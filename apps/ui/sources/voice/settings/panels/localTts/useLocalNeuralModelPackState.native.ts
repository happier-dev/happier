import * as React from 'react';

import { Modal } from '@/modal';
import { prepareKokoroTts } from '@/voice/kokoro/runtime/synthesizeKokoroWav';
import { checkModelPackUpdateAvailable, ensureModelPackInstalled, getModelPackInstallSummary, removeModelPack } from '@/voice/modelPacks/installer.native';
import { formatModelPackBuildLabel } from '@/voice/modelPacks/formatBuildLabel';

type ModelStatus = 'idle' | 'downloading' | 'ready' | 'error';

type Progress = { loaded: number; total: number };

function formatProgressPercent(progress: unknown): number | null {
  if (!progress || typeof progress !== 'object') return null;
  const loaded = (progress as any).loaded;
  const total = (progress as any).total;
  if (typeof loaded !== 'number' || !Number.isFinite(loaded)) return null;
  if (typeof total !== 'number' || !Number.isFinite(total) || total <= 0) return null;
  return Math.max(0, Math.min(100, Math.floor((loaded / total) * 100)));
}

export function useLocalNeuralModelPackState(params: {
  packId: string;
  manifestUrl: string | null;
  networkTimeoutMs: number;
}): Readonly<{
  modelStatus: ModelStatus;
  progressPercent: number | null;
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
  const [progressPercent, setProgressPercent] = React.useState<number | null>(null);
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
      setProgressPercent(null);
      const abortController = new AbortController();
      prepareAbortRef.current = abortController;

      await prepareKokoroTts({
        assetSetId: params.packId,
        timeoutMs: Math.max(60000, params.networkTimeoutMs),
        signal: abortController.signal,
        onProgress: (progress) => {
          const pct = formatProgressPercent(progress);
          if (pct != null) setProgressPercent(pct);
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
    void (async () => {
      if (modelStatus === 'downloading') return;
      const confirmed = await Modal.confirm(
        'Remove Kokoro assets?',
        'This removes downloaded Kokoro files from this device.',
        { confirmText: 'Remove' },
      );
      if (!confirmed) return;
      await removeModelPack({ packId: params.packId });
      setModelStatus('idle');
      setProgressPercent(null);
      await refreshInstallState();
    })();
  }, [modelStatus, params.packId, refreshInstallState]);

  const checkForUpdates = React.useCallback(() => {
    void (async () => {
      if (modelStatus === 'downloading') return;
      if (!params.manifestUrl) {
        await Modal.alert(
          'Manifest not configured',
          'Set EXPO_PUBLIC_HAPPIER_MODEL_PACK_MANIFESTS (or legacy Kokoro env vars) to enable downloads.',
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
        setProgressPercent(null);
        prepareAbortRef.current = abortController;

        await ensureModelPackInstalled({
          packId: params.packId,
          mode: 'download_if_missing',
          updatePolicy: 'manual_update_if_available',
          manifestUrl: params.manifestUrl,
          timeoutMs: Math.max(120_000, params.networkTimeoutMs),
          signal: abortController.signal,
          onProgress: (p) => {
            const loaded = (p as any)?.loaded;
            const total = (p as any)?.total;
            const pct = formatProgressPercent({ loaded, total } satisfies Progress);
            if (pct != null) setProgressPercent(pct);
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
        setProgressPercent(null);
      }
    })();
  }, [modelStatus, params.manifestUrl, params.networkTimeoutMs, params.packId, refreshInstallState]);

  return {
    modelStatus,
    progressPercent,
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
