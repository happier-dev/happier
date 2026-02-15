import * as React from 'react';

import { Ionicons } from '@expo/vector-icons';
import { Pressable, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Modal } from '@/modal';
import { t } from '@/text';
import type { VoiceLocalTtsSettings } from '@/sync/domains/settings/voiceLocalTtsSettings';
import { getKokoroAssetSetOptions } from '@/voice/kokoro/assets/kokoroAssetSets';
import { getKokoroSherpaVoiceCatalogForSpeakerCount } from '@/voice/kokoro/voices/kokoroSherpaVoiceMapping';
import { prepareKokoroTts } from '@/voice/kokoro/runtime/synthesizeKokoroWav';
import { checkModelPackUpdateAvailable, ensureModelPackInstalled, getModelPackInstallSummary, removeModelPack } from '@/voice/modelPacks/installer.native';
import { resolveModelPackManifestUrl } from '@/voice/modelPacks/manifests';
import { isKokoroRuntimeSupported } from '@/voice/kokoro/runtime/kokoroSupport';
import { speakKokoroText } from '@/voice/output/KokoroTtsController';
import { createVoicePlaybackController } from '@/voice/runtime/VoicePlaybackController';
import { formatModelPackBuildLabel } from '@/voice/modelPacks/formatBuildLabel';

type KokoroVoiceSummary = {
  id: string;
  title: string;
  subtitle?: string;
};

function uriToFilePath(uri: string): string {
  if (uri.startsWith('file://')) return uri.slice('file://'.length);
  return uri;
}

function formatKokoroProgress(progress: unknown): number | null {
  if (!progress || typeof progress !== 'object') return null;
  const loaded = (progress as any).loaded;
  const total = (progress as any).total;
  if (typeof loaded !== 'number' || !Number.isFinite(loaded)) return null;
  if (typeof total !== 'number' || !Number.isFinite(total) || total <= 0) return null;
  return Math.max(0, Math.min(100, Math.floor((loaded / total) * 100)));
}

export function LocalNeuralTtsSettings(props: {
  cfgKokoro: VoiceLocalTtsSettings['localNeural'];
  setKokoro: (next: VoiceLocalTtsSettings['localNeural']) => void;
  networkTimeoutMs: number;
  popoverBoundaryRef?: React.RefObject<any> | null;
}) {
  const { theme } = useUnistyles();
  const [openMenu, setOpenMenu] = React.useState<null | 'assetSet' | 'voiceId' | 'speed'>(null);
  const DEFAULT_KOKORO_ASSET_SET_ID = 'kokoro-82m-v1.0-onnx-q8-wasm';

  const [modelStatus, setModelStatus] = React.useState<'idle' | 'downloading' | 'ready' | 'error'>('idle');
  const [progressPercent, setProgressPercent] = React.useState<number | null>(null);
  const prepareAbortRef = React.useRef<AbortController | null>(null);
  const [installed, setInstalled] = React.useState<boolean>(false);
  const [installSummary, setInstallSummary] = React.useState<null | Awaited<ReturnType<typeof getModelPackInstallSummary>>>(null);
  const [updateCheckedRemote, setUpdateCheckedRemote] = React.useState<null | { build: string | null; updateAvailable: boolean }>(null);

  const [voices, setVoices] = React.useState<KokoroVoiceSummary[]>([]);

  const effectiveVoiceId = props.cfgKokoro.voiceId ?? 'af_heart';
  const effectiveSpeed = props.cfgKokoro.speed ?? 1;
  const effectiveAssetSetId = props.cfgKokoro.assetId ?? DEFAULT_KOKORO_ASSET_SET_ID;
  const assetSets = React.useMemo(() => getKokoroAssetSetOptions().filter((s) => s.id), []);
  const runtimeSupported = React.useMemo(() => isKokoroRuntimeSupported(), []);

  const manifestUrl = React.useMemo(() => resolveModelPackManifestUrl({ packId: effectiveAssetSetId }), [effectiveAssetSetId]);

  const refreshInstallState = React.useCallback(async () => {
    try {
      const summary = await getModelPackInstallSummary({ packId: effectiveAssetSetId });
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
  }, [effectiveAssetSetId]);

  React.useEffect(() => {
    void refreshInstallState();
  }, [refreshInstallState]);

  React.useEffect(() => {
    let canceled = false;

    void (async () => {
      const manifestVoices: any[] | null =
        Array.isArray((installSummary as any)?.manifest?.voices) ? (installSummary as any)?.manifest?.voices : null;

      if (manifestVoices && manifestVoices.length > 0) {
        const rows = manifestVoices
          .filter((v) => v && typeof v === 'object' && typeof (v as any).id === 'string')
          .map((v) => ({
            id: String((v as any).id),
            title: typeof (v as any).title === 'string' && (v as any).title.trim().length > 0 ? (v as any).title : String((v as any).id),
            subtitle: typeof (v as any).subtitle === 'string' && (v as any).subtitle.trim().length > 0 ? (v as any).subtitle : undefined,
          }));
        if (!canceled) setVoices(rows);
        return;
      }

      if ((installSummary as any)?.installed && typeof (installSummary as any)?.packDirUri === 'string') {
        const assetsDirUri = String((installSummary as any).packDirUri);
        const assetsDirPath = uriToFilePath(assetsDirUri);

        try {
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const pkg = require('@happier-dev/sherpa-native') as any;
          const native = typeof pkg?.getOptionalHappierSherpaNativeModule === 'function'
            ? pkg.getOptionalHappierSherpaNativeModule()
            : null;

          if (native && typeof native.listVoices === 'function') {
            const nativeVoices = await native.listVoices({ assetsDir: assetsDirPath });
            const speakerCount = Array.isArray(nativeVoices) ? nativeVoices.length : null;
            const catalog = getKokoroSherpaVoiceCatalogForSpeakerCount(speakerCount);
            if (catalog) {
              if (!canceled) setVoices(catalog.map((v) => ({ id: v.id, title: v.title, subtitle: v.subtitle })));
              return;
            }
            if (speakerCount && speakerCount > 0) {
              if (!canceled) setVoices(Array.from({ length: speakerCount }).map((_, i) => ({ id: `sid:${i}`, title: `Speaker ${i}` })));
              return;
            }
          }
        } catch {
          // ignore
        }
      }

      // Fallback: show a stable catalog so the dropdown is never empty.
      const fallback = getKokoroSherpaVoiceCatalogForSpeakerCount(53) ?? [];
      if (!canceled) setVoices(fallback.map((v) => ({ id: v.id, title: v.title, subtitle: v.subtitle })));
    })();

    return () => {
      canceled = true;
    };
  }, [installSummary]);

  const previewController = React.useMemo(() => createVoicePlaybackController(), []);
  const [previewingVoiceId, setPreviewingVoiceId] = React.useState<string | null>(null);

  const stopPreview = React.useCallback(() => {
    previewController.interrupt();
    setPreviewingVoiceId(null);
  }, [previewController]);

  React.useEffect(() => {
    if (openMenu === 'voiceId') return;
    if (!previewingVoiceId) return;
    stopPreview();
  }, [openMenu, previewingVoiceId, stopPreview]);

  const prepareModel = React.useCallback(async () => {
    if (modelStatus === 'downloading') return;

    try {
      setModelStatus('downloading');
      setProgressPercent(null);
      const abortController = new AbortController();
      prepareAbortRef.current = abortController;

      await prepareKokoroTts({
        assetSetId: effectiveAssetSetId,
        timeoutMs: Math.max(60000, props.networkTimeoutMs),
        signal: abortController.signal,
        onProgress: (progress) => {
          const pct = formatKokoroProgress(progress);
          if (pct != null) setProgressPercent(pct);
        },
      });

      setModelStatus('ready');
      await refreshInstallState();
    } catch {
      setModelStatus('error');
    } finally {
      prepareAbortRef.current = null;
    }
  }, [effectiveAssetSetId, modelStatus, props.networkTimeoutMs, refreshInstallState]);

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
      await removeModelPack({ packId: effectiveAssetSetId });
      setModelStatus('idle');
      setProgressPercent(null);
      await refreshInstallState();
    })();
  }, [effectiveAssetSetId, modelStatus, refreshInstallState]);

  const checkForUpdates = React.useCallback(() => {
    void (async () => {
      if (modelStatus === 'downloading') return;
      if (!manifestUrl) {
        await Modal.alert(
          'Manifest not configured',
          'Set EXPO_PUBLIC_HAPPIER_MODEL_PACK_MANIFESTS (or legacy Kokoro env vars) to enable downloads.',
        );
        return;
      }

      const abortController = new AbortController();
      try {
        const status = await checkModelPackUpdateAvailable({
          packId: effectiveAssetSetId,
          manifestUrl,
          timeoutMs: Math.max(30_000, props.networkTimeoutMs),
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
          packId: effectiveAssetSetId,
          mode: 'download_if_missing',
          updatePolicy: 'manual_update_if_available',
          manifestUrl,
          timeoutMs: Math.max(120_000, props.networkTimeoutMs),
          signal: abortController.signal,
          onProgress: (p) => {
            const loaded = (p as any)?.loaded;
            const total = (p as any)?.total;
            const pct = formatKokoroProgress({ loaded, total });
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
  }, [effectiveAssetSetId, manifestUrl, modelStatus, props.networkTimeoutMs, refreshInstallState]);

  const playPreview = React.useCallback(
    async (voiceId: string) => {
      if (previewingVoiceId === voiceId) {
        stopPreview();
        return;
      }

      stopPreview();
      setPreviewingVoiceId(voiceId);

      try {
        await speakKokoroText({
          text: t('settingsVoice.local.testTtsSample'),
          assetSetId: effectiveAssetSetId,
          voiceId,
          speed: effectiveSpeed,
          timeoutMs: Math.max(60000, props.networkTimeoutMs),
          registerPlaybackStopper: previewController.registerStopper,
        });
        setPreviewingVoiceId(null);
      } catch {
        setPreviewingVoiceId(null);
      }
    },
    [effectiveAssetSetId, effectiveSpeed, previewController.registerStopper, previewingVoiceId, props.networkTimeoutMs, stopPreview],
  );

  const modelDetail =
    modelStatus === 'downloading'
      ? progressPercent != null
        ? `${progressPercent}%`
        : 'Downloading…'
      : modelStatus === 'ready'
        ? formatModelPackBuildLabel((installSummary as any)?.manifest)
          ? `Ready • ${formatModelPackBuildLabel((installSummary as any)?.manifest)}`
          : 'Ready'
        : modelStatus === 'error'
          ? 'Error'
          : installed
            ? formatModelPackBuildLabel((installSummary as any)?.manifest)
              ? `Ready • ${formatModelPackBuildLabel((installSummary as any)?.manifest)}`
              : 'Ready'
            : 'Not downloaded';

  return (
    <>
      {!runtimeSupported ? (
        <Item
          title="Kokoro runtime"
          subtitle="Kokoro is not supported on this device/runtime."
          detail="Unavailable"
          selected={false}
          showChevron={false}
        />
      ) : null}

      <Item
        title="Model pack manifest"
        subtitle="Configured via EXPO_PUBLIC_HAPPIER_MODEL_PACK_MANIFESTS (packId -> manifestUrl)."
        detail={manifestUrl ? 'Set' : 'Not set'}
        selected={false}
        showChevron={false}
      />

      <DropdownMenu
        open={openMenu === 'assetSet'}
        onOpenChange={(next) => setOpenMenu(next ? 'assetSet' : null)}
        variant="selectable"
        search={false}
        selectedId={effectiveAssetSetId ?? ''}
        showCategoryTitles={false}
        matchTriggerWidth={true}
        connectToTrigger={true}
        rowKind="item"
        popoverBoundaryRef={props.popoverBoundaryRef}
        trigger={({ open, toggle }) => (
          <Item
            title="Kokoro model pack"
            subtitle="Select which asset pack to use for Kokoro."
            detail={effectiveAssetSetId ?? 'Default'}
            rightElement={<Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={20} color={theme.colors.textSecondary} />}
            onPress={toggle}
            showChevron={false}
            selected={false}
          />
        )}
        items={assetSets.map((s) => ({
          id: s.id,
          title: s.title,
          subtitle: s.subtitle,
        }))}
        onSelect={(id) => {
          props.setKokoro({ ...props.cfgKokoro, assetId: id || null });
          setOpenMenu(null);
          stopPreview();
        }}
      />

      <Item
        title="Kokoro model"
        subtitle="Download required files to enable on-device synthesis."
        detail={modelDetail}
        onPress={() => {
          if (!manifestUrl) {
            void Modal.alert(
              'Manifest not configured',
              'Set EXPO_PUBLIC_HAPPIER_MODEL_PACK_MANIFESTS (or legacy Kokoro env vars) to enable downloads.',
            );
            return;
          }
          void prepareModel();
        }}
        rightElement={
          modelStatus === 'downloading' ? (
            <Pressable onPress={cancelPrepare} hitSlop={10}>
              <Ionicons name="close" size={20} color={theme.colors.textSecondary} />
            </Pressable>
          ) : (
            <Ionicons name="download-outline" size={20} color={theme.colors.textSecondary} />
          )
        }
        showChevron={false}
        selected={false}
      />

      <Item
        title="Remove Kokoro assets"
        subtitle="Free storage by removing downloaded Kokoro files."
        detail={installed ? 'Remove' : '—'}
        onPress={installed ? clearAssets : undefined}
        showChevron={false}
        selected={false}
      />

      <Item
        title="Check for model updates"
        subtitle="Manually check if a newer model pack is available."
        detail={
          updateCheckedRemote
            ? updateCheckedRemote.updateAvailable
              ? `Update available${updateCheckedRemote.build ? ` • ${updateCheckedRemote.build}` : ''}`
              : updateCheckedRemote.build
                ? `Up to date • ${updateCheckedRemote.build}`
                : 'Up to date'
            : 'Check'
        }
        onPress={checkForUpdates}
        showChevron={false}
        selected={false}
      />

      <DropdownMenu
        open={openMenu === 'voiceId'}
        onOpenChange={(next) => setOpenMenu(next ? 'voiceId' : null)}
        variant="selectable"
        search={true}
        selectedId={effectiveVoiceId}
        showCategoryTitles={false}
        matchTriggerWidth={true}
        connectToTrigger={true}
        rowKind="item"
        popoverBoundaryRef={props.popoverBoundaryRef}
        trigger={({ open, toggle }) => (
          <Item
            title="Voice"
            subtitle="Select the Kokoro voice."
            detail={effectiveVoiceId}
            rightElement={<Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={20} color={theme.colors.textSecondary} />}
            onPress={toggle}
            showChevron={false}
            selected={false}
          />
        )}
        items={voices.map((v) => ({
          id: v.id,
          title: v.title,
          subtitle: v.subtitle,
          rightElement: (
            <View style={{ paddingRight: 4 }}>
              <Pressable
                onPress={(e) => {
                  e.stopPropagation?.();
                  void playPreview(v.id);
                }}
                hitSlop={10}
              >
                <Ionicons
                  name={previewingVoiceId === v.id ? 'pause' : 'play'}
                  size={18}
                  color={theme.colors.textSecondary}
                />
              </Pressable>
            </View>
          ),
        }))}
        onSelect={(id) => {
          props.setKokoro({ ...props.cfgKokoro, voiceId: id });
          setOpenMenu(null);
        }}
      />
    </>
  );
}
