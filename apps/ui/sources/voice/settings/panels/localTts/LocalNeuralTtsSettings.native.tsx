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
import { resolveModelPackManifestUrl } from '@/voice/modelPacks/manifests';
import { isKokoroRuntimeSupported } from '@/voice/kokoro/runtime/kokoroSupport';
import { speakKokoroText } from '@/voice/output/KokoroTtsController';
import { createVoicePlaybackController } from '@/voice/runtime/VoicePlaybackController';
import { formatModelPackBuildLabel } from '@/voice/modelPacks/formatBuildLabel';

import { useLocalNeuralKokoroVoiceCatalog } from './useLocalNeuralKokoroVoiceCatalog.native';
import { useLocalNeuralModelPackState } from './useLocalNeuralModelPackState.native';

export function LocalNeuralTtsSettings(props: {
  cfgKokoro: VoiceLocalTtsSettings['localNeural'];
  setKokoro: (next: VoiceLocalTtsSettings['localNeural']) => void;
  networkTimeoutMs: number;
  popoverBoundaryRef?: React.RefObject<any> | null;
}) {
  const { theme } = useUnistyles();
  const [openMenu, setOpenMenu] = React.useState<null | 'assetSet' | 'voiceId' | 'speed'>(null);
  const DEFAULT_KOKORO_ASSET_SET_ID = 'kokoro-82m-v1.0-onnx-q8-wasm';

  const effectiveVoiceId = props.cfgKokoro.voiceId ?? 'af_heart';
  const effectiveSpeed = props.cfgKokoro.speed ?? 1;
  const effectiveAssetSetId = props.cfgKokoro.assetId ?? DEFAULT_KOKORO_ASSET_SET_ID;
  const assetSets = React.useMemo(() => getKokoroAssetSetOptions().filter((s) => s.id), []);
  const runtimeSupported = React.useMemo(() => isKokoroRuntimeSupported(), []);

  const manifestUrl = React.useMemo(() => resolveModelPackManifestUrl({ packId: effectiveAssetSetId }), [effectiveAssetSetId]);

  const { modelStatus, progressPercent, installed, installSummary, updateCheckedRemote, prepareModel, cancelPrepare, clearAssets, checkForUpdates } =
    useLocalNeuralModelPackState({
      packId: effectiveAssetSetId,
      manifestUrl,
      networkTimeoutMs: props.networkTimeoutMs,
    });

  const voices = useLocalNeuralKokoroVoiceCatalog({ installSummary });

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
          if (!runtimeSupported) {
            void Modal.alert(t('common.error'), 'Kokoro is not supported on this device/runtime.');
            return;
          }
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
