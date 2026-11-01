import * as React from 'react';

import { Pressable, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Modal } from '@/modal';
import { t } from '@/text';
import type { VoiceLocalTtsSettings } from '@/sync/domains/settings/voiceLocalTtsSettings';
import { getKokoroNativeModelPackOptions, resolveKokoroNativeModelPackId } from '@/voice/kokoro/assets/kokoroAssetSets';
import { resolveModelPackManifestUrl } from '@/voice/modelPacks/manifests';
import { isKokoroRuntimeSupported } from '@/voice/kokoro/runtime/kokoroSupport';
import { speakKokoroText } from '@/voice/output/KokoroTtsController';
import { createVoicePlaybackController } from '@/voice/runtime/VoicePlaybackController';
import { formatModelPackBuildLabel } from '@/voice/modelPacks/formatBuildLabel';
import { fireAndForget } from '@/utils/system/fireAndForget';
import {
  readPartialDownloadBytes,
  resolveModelPackTransferRow,
  resolvePartialDownloadRemoveRow,
} from '@/voice/settings/panels/modelPack/modelPackTransferRows';

import { resolveKokoroNativeVoice } from '@/voice/kokoro/voices/resolveKokoroVoice';

import { useLocalNeuralKokoroVoiceCatalog } from './useLocalNeuralKokoroVoiceCatalog.native';
import { useNativeModelPackState } from '@/voice/settings/panels/modelPack/useNativeModelPackState.native';
import { Icon } from '@/components/ui/icons/Icon';

export function LocalNeuralTtsSettings(props: {
  cfgKokoro: VoiceLocalTtsSettings['localNeural'];
  setKokoro: (next: VoiceLocalTtsSettings['localNeural']) => void;
  networkTimeoutMs: number;
  popoverBoundaryRef?: React.RefObject<any> | null;
}) {
  const { theme } = useUnistyles();
  const [openMenu, setOpenMenu] = React.useState<null | 'assetSet' | 'voiceId' | 'speed'>(null);

  const effectiveSpeed = props.cfgKokoro.speed ?? 1;
  const effectiveAssetSetId = resolveKokoroNativeModelPackId(props.cfgKokoro.assetId);
  const assetSets = React.useMemo(() => getKokoroNativeModelPackOptions(), []);
  const runtimeSupported = React.useMemo(() => isKokoroRuntimeSupported(), []);

  const manifestUrl = React.useMemo(() => resolveModelPackManifestUrl({ packId: effectiveAssetSetId }), [effectiveAssetSetId]);

  const { modelStatus, downloadProgress, installed, installSummary, updateCheckedRemote, prepareModel, cancelPrepare, clearAssets, checkForUpdates } =
    useNativeModelPackState({
      role: 'tts',
      packId: effectiveAssetSetId,
      manifestUrl,
      networkTimeoutMs: props.networkTimeoutMs,
    });

  const voices = useLocalNeuralKokoroVoiceCatalog({ installSummary });
  // Show the voice synthesis will actually use: the synced id may be unset or come from web.
  const effectiveVoiceId =
    resolveKokoroNativeVoice(installSummary?.manifest ?? null, props.cfgKokoro.voiceId)?.voiceId
    ?? props.cfgKokoro.voiceId
    ?? null;

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

  const buildLabel = formatModelPackBuildLabel((installSummary as any)?.manifest);
  const readyDetail = buildLabel ? `${t('settingsVoice.local.kokoro.modelStatus.ready')} • ${buildLabel}` : t('settingsVoice.local.kokoro.modelStatus.ready');

  const partialBytes = readPartialDownloadBytes(installSummary);
  const transferRow = resolveModelPackTransferRow({ status: modelStatus, progress: downloadProgress, partialBytes });
  const partialRemoveRow = installed ? null : resolvePartialDownloadRemoveRow(partialBytes);
  const modelDetail =
    transferRow?.detail
      ?? (modelStatus === 'ready' || installed ? readyDetail : t('settingsVoice.local.kokoro.modelStatus.notDownloaded'));

  const updateDetail = updateCheckedRemote
    ? updateCheckedRemote.updateAvailable
      ? `${t('settingsVoice.local.kokoro.updates.updateAvailable')}${updateCheckedRemote.build ? ` • ${updateCheckedRemote.build}` : ''}`
      : updateCheckedRemote.build
        ? `${t('settingsVoice.local.kokoro.updates.upToDate')} • ${updateCheckedRemote.build}`
        : t('settingsVoice.local.kokoro.updates.upToDate')
    : t('settingsVoice.local.kokoro.updates.check');

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

      <Item
        title={t('settingsVoice.local.kokoro.manifest.title')}
        subtitle={t('settingsVoice.local.kokoro.manifest.subtitle')}
        detail={
          manifestUrl ? t('settingsVoice.local.kokoro.manifest.detailResolved') : t('settingsVoice.local.kokoro.manifest.detailMissing')
        }
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
        itemTrigger={{
          title: t('settingsVoice.local.kokoro.assetPack.title'),
          subtitle: t('settingsVoice.local.kokoro.assetPack.subtitleNative'),
          showSelectedSubtitle: false,
          detailFormatter: () => (effectiveAssetSetId ?? t('settingsVoice.local.kokoro.common.default')),
        }}
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
        title={t('settingsVoice.local.kokoro.model.title')}
        subtitle={transferRow?.subtitle ?? t('settingsVoice.local.kokoro.model.subtitleNative')}
        subtitleLines={transferRow ? 0 : undefined}
        detail={modelDetail}
        onPress={() => {
          if (!runtimeSupported) {
            fireAndForget((async () => {
              await Modal.alert(t('common.error'), t('settingsVoice.local.kokoro.alerts.runtimeUnsupported.body'));
            })(), {
              tag: 'LocalNeuralTtsSettings.alert.runtimeUnsupported',
            });
            return;
          }
          if (!manifestUrl) {
            fireAndForget((async () => {
              await Modal.alert(
                t('settingsVoice.local.kokoro.alerts.missingManifest.title'),
                t('settingsVoice.local.kokoro.alerts.missingManifest.body'),
              );
            })(), { tag: 'LocalNeuralTtsSettings.alert.missingManifestUrl' });
            return;
          }
          fireAndForget(prepareModel(), { tag: 'LocalNeuralTtsSettings.prepareModel' });
        }}
        rightElement={
          modelStatus === 'downloading' ? (
            <Pressable onPress={cancelPrepare} hitSlop={10}>
              <Icon name="x" size={20} color={theme.colors.text.secondary} />
            </Pressable>
          ) : (
            <Icon name="download" size={20} color={theme.colors.text.secondary} />
          )
        }
        showChevron={false}
        selected={false}
      />

      <Item
        title={t('settingsVoice.local.kokoro.removeAssets.title')}
        subtitle={partialRemoveRow?.subtitle ?? t('settingsVoice.local.kokoro.removeAssets.subtitle')}
        detail={
          installed
            ? t('settingsVoice.local.kokoro.removeAssets.detailRemove')
            : (partialRemoveRow?.detail ?? t('settingsVoice.local.kokoro.common.none'))
        }
        onPress={installed || partialRemoveRow ? clearAssets : undefined}
        showChevron={false}
        selected={false}
      />

      <Item
        title={t('settingsVoice.local.kokoro.updates.title')}
        subtitle={t('settingsVoice.local.kokoro.updates.subtitle')}
        detail={updateDetail}
        onPress={checkForUpdates}
        showChevron={false}
        selected={false}
      />

      <DropdownMenu
        open={openMenu === 'voiceId'}
        onOpenChange={(next) => setOpenMenu(next ? 'voiceId' : null)}
        variant="selectable"
        search={true}
        selectedId={effectiveVoiceId ?? ''}
        showCategoryTitles={false}
        matchTriggerWidth={true}
        connectToTrigger={true}
        rowKind="item"
        popoverBoundaryRef={props.popoverBoundaryRef}
        itemTrigger={{
          title: t('settingsVoice.local.kokoro.voice.title'),
          subtitle: t('settingsVoice.local.kokoro.voice.subtitleNative'),
          showSelectedSubtitle: false,
          detailFormatter: () => effectiveVoiceId ?? t('settingsVoice.local.kokoro.common.default'),
        }}
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
                <Icon
                  name={previewingVoiceId === v.id ? 'pause-circle' : 'play'}
                  size={16}
                  color={theme.colors.text.secondary}
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
