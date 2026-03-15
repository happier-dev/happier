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
import { clearKokoroBrowserCaches, getKokoroBrowserCacheSummary } from '@/voice/kokoro/assets/kokoroBrowserCache';
import { formatDownloadProgressDetail } from '@/voice/downloads/downloadProgress';
import { resolveKokoroOperationTimeoutMs } from '@/voice/kokoro/config/kokoroConfig';
import { loadKokoroWebRuntime } from '@/voice/kokoro/runtime/loadKokoroWebRuntime.web';
import { prepareKokoroTts, synthesizeKokoroWav } from '@/voice/kokoro/runtime/synthesizeKokoroWav';
import { isKokoroRuntimeSupported } from '@/voice/kokoro/runtime/kokoroSupport';
import { speakKokoroText } from '@/voice/output/KokoroTtsController';
import { primeWebAudioPlayback } from '@/voice/output/webAudioContext';
import { createVoicePlaybackController } from '@/voice/runtime/VoicePlaybackController';
import { fireAndForget } from '@/utils/system/fireAndForget';

type KokoroVoiceSummary = {
  id: string;
  title: string;
  subtitle?: string;
};

async function loadKokoroVoiceCatalog(): Promise<KokoroVoiceSummary[]> {
  const mod = await loadKokoroWebRuntime();
  const KokoroTTS: any = mod.KokoroTTS;
  const getter = KokoroTTS ? Object.getOwnPropertyDescriptor(KokoroTTS.prototype, 'voices')?.get : null;
  const voicesObj = (getter ? getter.call({}) : null) as Record<string, any> | null;
  if (!voicesObj) return [];

  return Object.entries(voicesObj).map(([id, meta]) => ({
    id,
    title: typeof meta?.name === 'string' && meta.name.trim().length > 0 ? meta.name : id,
    subtitle:
      typeof meta?.language === 'string' && meta.language.trim().length > 0
        ? meta.language
        : undefined,
  }));
}

export function LocalNeuralTtsSettings(props: {
  cfgKokoro: VoiceLocalTtsSettings['localNeural'];
  setKokoro: (next: VoiceLocalTtsSettings['localNeural']) => void;
  networkTimeoutMs: number;
  popoverBoundaryRef?: React.RefObject<any> | null;
}) {
  const { theme } = useUnistyles();
  const [openMenu, setOpenMenu] = React.useState<null | 'assetSet' | 'voiceId' | 'speed'>(null);

  const [modelStatus, setModelStatus] = React.useState<'idle' | 'downloading' | 'ready' | 'error'>('idle');
  const [downloadProgress, setDownloadProgress] = React.useState<unknown | null>(null);
  const prepareAbortRef = React.useRef<AbortController | null>(null);
  const [cacheSummary, setCacheSummary] = React.useState<null | { transformersCacheCount: number; kokoroVoicesCacheCount: number }>(null);

  const [voices, setVoices] = React.useState<KokoroVoiceSummary[]>([]);
  React.useEffect(() => {
    let canceled = false;
    void loadKokoroVoiceCatalog()
      .then((rows) => {
        if (canceled) return;
        setVoices(rows);
      })
      .catch(() => {});
    return () => {
      canceled = true;
    };
  }, []);

  React.useEffect(() => {
    let canceled = false;
    void getKokoroBrowserCacheSummary()
      .then((summary) => {
        if (canceled) return;
        setCacheSummary(summary);
        if (summary.transformersCacheCount > 0 || summary.kokoroVoicesCacheCount > 0) {
          setModelStatus((cur) => (cur === 'downloading' ? cur : 'ready'));
        }
      })
      .catch(() => {});
    return () => {
      canceled = true;
    };
  }, []);

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

  const effectiveVoiceId = props.cfgKokoro.voiceId ?? 'af_heart';
  const effectiveSpeed = props.cfgKokoro.speed ?? 1;
  const effectiveAssetSetId = props.cfgKokoro.assetId ?? null;
  const assetSets = React.useMemo(() => getKokoroAssetSetOptions(), []);
  const runtimeSupported = React.useMemo(() => isKokoroRuntimeSupported(), []);

  const prepareModel = React.useCallback(async () => {
    if (modelStatus === 'downloading') return;

    try {
      setModelStatus('downloading');
      setDownloadProgress(null);
      const abortController = new AbortController();
      prepareAbortRef.current = abortController;

      await prepareKokoroTts({
        assetSetId: effectiveAssetSetId,
        timeoutMs: resolveKokoroOperationTimeoutMs(props.networkTimeoutMs),
        signal: abortController.signal,
        onProgress: (progress) => {
          setDownloadProgress(progress);
        },
      });

      // Warm up the runtime so "Ready" means "inference works", not just "runtime import succeeded".
      // This also ensures the first user-visible preview isn't the first time we compile WASM and load model assets.
      setDownloadProgress({ name: t('settingsVoice.local.kokoro.web.warmingUp') });
      await synthesizeKokoroWav({
        text: 'Hi',
        assetSetId: effectiveAssetSetId,
        voiceId: effectiveVoiceId,
        speed: effectiveSpeed,
        timeoutMs: resolveKokoroOperationTimeoutMs(props.networkTimeoutMs),
        signal: abortController.signal,
      });

      setModelStatus('ready');
      setCacheSummary(await getKokoroBrowserCacheSummary());
    } catch (error) {
      if (prepareAbortRef.current?.signal?.aborted) return;
      setModelStatus('error');
      fireAndForget((async () => {
        await Modal.alert(t('common.error'), error instanceof Error ? error.message : String(error));
      })(), {
        tag: 'LocalNeuralTtsSettings.alert.prepareModelFailed',
      });
    } finally {
      prepareAbortRef.current = null;
    }
  }, [effectiveAssetSetId, modelStatus, props.networkTimeoutMs]);

  const cancelPrepare = React.useCallback(() => {
    const controller = prepareAbortRef.current;
    if (!controller) return;
    try {
      controller.abort();
    } catch {
      // ignore
    }
  }, []);

  const clearCache = React.useCallback(() => {
    fireAndForget((async () => {
      if (modelStatus === 'downloading') return;
      const confirmed = await Modal.confirm(
        t('settingsVoice.local.kokoro.web.clearCache.confirmTitle'),
        t('settingsVoice.local.kokoro.web.clearCache.confirmBody'),
        { confirmText: t('settingsVoice.local.kokoro.web.clearCache.confirmButton') },
      );
      if (!confirmed) return;
      await clearKokoroBrowserCaches();
      setCacheSummary(await getKokoroBrowserCacheSummary());
      setModelStatus('idle');
    })(), { tag: 'LocalNeuralTtsSettings.confirm.clearCache' });
  }, [modelStatus]);

  const playPreview = React.useCallback(async (voiceId: string) => {
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
        timeoutMs: resolveKokoroOperationTimeoutMs(props.networkTimeoutMs),
        registerPlaybackStopper: previewController.registerStopper,
      });
      setPreviewingVoiceId(null);
    } catch {
      setPreviewingVoiceId(null);
    }
  }, [effectiveAssetSetId, effectiveSpeed, previewController.registerStopper, previewingVoiceId, props.networkTimeoutMs, stopPreview]);

  const modelDetail =
    modelStatus === 'downloading'
      ? (downloadProgress
          ? formatDownloadProgressDetail(downloadProgress, { prefix: t('settingsVoice.local.kokoro.modelStatus.downloadingPrefix') })
          : t('settingsVoice.local.kokoro.modelStatus.downloading'))
      : modelStatus === 'ready'
        ? t('settingsVoice.local.kokoro.modelStatus.ready')
        : modelStatus === 'error'
          ? t('settingsVoice.local.kokoro.modelStatus.error')
          : t('settingsVoice.local.kokoro.modelStatus.notDownloaded');

  const cacheDetail =
    cacheSummary
      ? `${t('settingsVoice.local.kokoro.web.cacheDetail.modelFiles')}: ${cacheSummary.transformersCacheCount} • ${t('settingsVoice.local.kokoro.web.cacheDetail.voices')}: ${cacheSummary.kokoroVoicesCacheCount}`
      : t('settingsVoice.local.kokoro.common.none');

  return (
    <>
      {!runtimeSupported ? (
        <Item
          title={t('settingsVoice.local.kokoro.runtime.title')}
          subtitle={t('settingsVoice.local.kokoro.runtime.unsupportedSubtitle')}
          detail={t('settingsVoice.local.kokoro.runtime.unavailableDetail')}
          selected={false}
          showChevron={false}
        />
      ) : null}

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
        itemTrigger={{
          title: t('settingsVoice.local.kokoro.assetPack.title'),
          subtitle: t('settingsVoice.local.kokoro.assetPack.subtitleWeb'),
          showSelectedSubtitle: false,
          detailFormatter: () => (effectiveAssetSetId ?? t('settingsVoice.local.kokoro.common.default')),
        }}
        items={assetSets.map((s) => ({
          id: s.id,
          title: s.title,
          subtitle: s.subtitle,
        }))}
        onSelect={(id) => {
          props.setKokoro({ ...props.cfgKokoro, assetId: id ? id : null });
          setModelStatus('idle');
          setOpenMenu(null);
        }}
      />

      <Item
        title={t('settingsVoice.local.kokoro.model.title')}
        subtitle={t('settingsVoice.local.kokoro.model.subtitleWeb')}
        detail={modelDetail}
        rightElement={
          modelStatus === 'downloading'
            ? (
              <Pressable
                hitSlop={10}
                onPress={(e: any) => {
                  e?.stopPropagation?.();
                  cancelPrepare();
                }}
                style={{ paddingHorizontal: 4, paddingVertical: 2 }}
              >
                <Ionicons name="stop-circle-outline" size={22} color={theme.colors.textSecondary} />
              </Pressable>
            )
            : undefined
        }
        onPress={() => {
          if (!runtimeSupported) return;
          void prepareModel();
        }}
      />

      <Item
        title={t('settingsVoice.local.kokoro.web.cache.title')}
        subtitle={t('settingsVoice.local.kokoro.web.cache.subtitle')}
        detail={cacheDetail}
        onPress={clearCache}
        showChevron={false}
        selected={false}
        destructive={false}
      />

      <DropdownMenu
        open={openMenu === 'voiceId'}
        onOpenChange={(next) => setOpenMenu(next ? 'voiceId' : null)}
        variant="selectable"
        search={true}
        searchPlaceholder={t('settingsVoice.local.kokoro.voice.searchPlaceholder')}
        selectedId={effectiveVoiceId}
        showCategoryTitles={false}
        matchTriggerWidth={true}
        connectToTrigger={true}
        rowKind="item"
        popoverBoundaryRef={props.popoverBoundaryRef}
        itemTrigger={{
          title: t('settingsVoice.local.kokoro.voice.titleWeb'),
          subtitle: t('settingsVoice.local.kokoro.voice.subtitleWeb'),
          showSelectedSubtitle: false,
          detailFormatter: () => effectiveVoiceId,
        }}
        items={(voices.length > 0
          ? voices
          : [{ id: effectiveVoiceId, title: t('settingsVoice.local.kokoro.voice.loadingVoicesTitle'), subtitle: undefined, disabled: true }]).map((v) => ({
          id: v.id,
          title: v.title,
          subtitle: v.subtitle,
          rightElement: (
            <Pressable
              hitSlop={10}
              onPress={(e: any) => {
                e?.stopPropagation?.();
                primeWebAudioPlayback();
                void playPreview(v.id);
              }}
              style={{ paddingHorizontal: 4, paddingVertical: 2 }}
            >
              <Ionicons
                name={previewingVoiceId === v.id ? 'stop-circle-outline' : 'play-circle-outline'}
                size={22}
                color={theme.colors.textSecondary}
              />
            </Pressable>
          ),
        }))}
        onSelect={(id) => {
          props.setKokoro({ ...props.cfgKokoro, voiceId: id || null });
          setOpenMenu(null);
        }}
      />

      <DropdownMenu
        open={openMenu === 'speed'}
        onOpenChange={(next) => setOpenMenu(next ? 'speed' : null)}
        variant="selectable"
        search={false}
        selectedId={String(effectiveSpeed)}
        showCategoryTitles={false}
        matchTriggerWidth={true}
        connectToTrigger={true}
        rowKind="item"
        popoverBoundaryRef={props.popoverBoundaryRef}
        itemTrigger={{
          title: t('settingsVoice.local.kokoro.speed.title'),
          subtitle: t('settingsVoice.local.kokoro.speed.subtitle'),
          showSelectedSubtitle: false,
        }}
        items={[0.7, 0.8, 0.9, 1, 1.1, 1.2, 1.3, 1.4, 1.5, 1.7, 2].map((speed) => ({
          id: String(speed),
          title: String(speed),
          icon: (
            <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
              <Ionicons name="speedometer-outline" size={20} color={theme.colors.textSecondary} />
            </View>
          ),
        }))}
        onSelect={(id) => {
          const parsed = Number(id);
          props.setKokoro({ ...props.cfgKokoro, speed: Number.isFinite(parsed) ? parsed : null });
          setOpenMenu(null);
        }}
      />

    </>
  );
}
