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
import { loadKokoroWebRuntime } from '@/voice/kokoro/runtime/loadKokoroWebRuntime.web';
import { prepareKokoroTts } from '@/voice/kokoro/runtime/synthesizeKokoroWav';
import { isKokoroRuntimeSupported } from '@/voice/kokoro/runtime/kokoroSupport';
import { speakKokoroText } from '@/voice/output/KokoroTtsController';
import { createVoicePlaybackController } from '@/voice/runtime/VoicePlaybackController';

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

  const [modelStatus, setModelStatus] = React.useState<'idle' | 'downloading' | 'ready' | 'error'>('idle');
  const [progressPercent, setProgressPercent] = React.useState<number | null>(null);
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
      setCacheSummary(await getKokoroBrowserCacheSummary());
    } catch (error) {
      if (prepareAbortRef.current?.signal?.aborted) return;
      setModelStatus('error');
      void Modal.alert(t('common.error'), error instanceof Error ? error.message : String(error));
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
    void (async () => {
      if (modelStatus === 'downloading') return;
      const confirmed = await Modal.confirm(
        'Clear Kokoro cache?',
        'This removes downloaded Kokoro model and voice files from this device.',
        { confirmText: 'Clear' },
      );
      if (!confirmed) return;
      await clearKokoroBrowserCaches();
      setCacheSummary(await getKokoroBrowserCacheSummary());
      setModelStatus('idle');
    })();
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
        timeoutMs: Math.max(60000, props.networkTimeoutMs),
        registerPlaybackStopper: previewController.registerStopper,
      });
      setPreviewingVoiceId(null);
    } catch {
      setPreviewingVoiceId(null);
    }
  }, [effectiveAssetSetId, effectiveSpeed, previewController.registerStopper, previewingVoiceId, props.networkTimeoutMs, stopPreview]);

  const modelDetail =
    modelStatus === 'downloading'
      ? (progressPercent != null ? `${progressPercent}%` : 'Downloading…')
      : modelStatus === 'ready'
        ? 'Ready'
        : modelStatus === 'error'
          ? 'Error'
          : 'Not downloaded';

  const cacheDetail =
    cacheSummary
      ? `Model files: ${cacheSummary.transformersCacheCount} • Voices: ${cacheSummary.kokoroVoicesCacheCount}`
      : '—';

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
            subtitle="Select which runtime configuration to use for Kokoro."
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
          props.setKokoro({ ...props.cfgKokoro, assetId: id ? id : null });
          setModelStatus('idle');
          setOpenMenu(null);
        }}
      />

      <Item
        title="Kokoro model"
        subtitle="Downloads on demand. Uses WebAssembly (beta)."
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
        title="Kokoro cache"
        subtitle="Manage downloaded Kokoro files on this device."
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
        searchPlaceholder="Search voices"
        selectedId={effectiveVoiceId}
        showCategoryTitles={false}
        matchTriggerWidth={true}
        connectToTrigger={true}
        rowKind="item"
        popoverBoundaryRef={props.popoverBoundaryRef}
        trigger={({ open, toggle }) => (
          <Item
            title="Kokoro voice"
            subtitle="Choose the on-device voice used for replies."
            detail={effectiveVoiceId}
            rightElement={<Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={20} color={theme.colors.textSecondary} />}
            onPress={toggle}
            showChevron={false}
            selected={false}
          />
        )}
        items={(voices.length > 0 ? voices : [{ id: effectiveVoiceId, title: 'Loading voices…', subtitle: undefined, disabled: true }]).map((v) => ({
          id: v.id,
          title: v.title,
          subtitle: v.subtitle,
          rightElement: (
            <Pressable
              hitSlop={10}
              onPress={(e: any) => {
                e?.stopPropagation?.();
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
        trigger={({ open, toggle }) => (
          <Item
            title="Speed"
            subtitle="Adjust speaking speed (0.5–2.0)."
            detail={String(effectiveSpeed)}
            rightElement={<Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={20} color={theme.colors.textSecondary} />}
            onPress={toggle}
            showChevron={false}
            selected={false}
          />
        )}
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

      <Item
        title="Test Kokoro"
        subtitle={t('settingsVoice.local.testTtsSubtitle')}
        onPress={() => {
          void (async () => {
            try {
              if (!runtimeSupported) {
                Modal.alert(t('common.error'), 'Kokoro is not supported on this device/runtime.');
                return;
              }
              await speakKokoroText({
                text: t('settingsVoice.local.testTtsSample'),
                assetSetId: effectiveAssetSetId,
                voiceId: effectiveVoiceId,
                speed: effectiveSpeed,
                timeoutMs: Math.max(60000, props.networkTimeoutMs),
                registerPlaybackStopper: (_stopper) => () => {},
              });
            } catch (err) {
              Modal.alert(t('common.error'), String((err as any)?.message ?? err));
            }
          })();
        }}
      />
    </>
  );
}
