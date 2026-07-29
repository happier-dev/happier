import * as React from 'react';

import { Ionicons } from '@expo/vector-icons';
import { Pressable, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Modal } from '@/modal';
import { t } from '@/text';
import {
  KOKORO_DEFAULT_TTS_PACK_ID,
  getModelPackCatalogEntry,
  isPublishedModelPackCatalogEntry,
} from '@happier-dev/protocol';
import type { VoiceLocalTtsSettings } from '@/sync/domains/settings/voiceLocalTtsSettings';
import { getKokoroAssetSetOptions } from '@/voice/kokoro/assets/kokoroAssetSets';
import { resolveKokoroDaemonTtsPackId } from '@/voice/kokoro/assets/resolveKokoroDaemonTtsPackId';
import { resolveModelPackManifestUrl } from '@/voice/modelPacks/manifests';
import { isKokoroRuntimeSupported } from '@/voice/kokoro/runtime/kokoroSupport';
import { speakKokoroText } from '@/voice/output/KokoroTtsController';
import { createVoicePlaybackController } from '@/voice/runtime/playback/VoicePlaybackController';
import { formatModelPackBuildLabel } from '@/voice/modelPacks/formatBuildLabel';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { resolveLocalNeuralExecutionPolicy } from '@/voice/runtime/daemonInference/daemonVoiceInferencePolicy';
import { DaemonVoiceInferenceExecutionDropdown } from '@/voice/settings/panels/daemonInference/DaemonVoiceInferenceExecutionDropdown';
import { SelectedDaemonModelPackRow } from '@/voice/settings/panels/modelCatalog/DaemonModelPackRow';
import type { VoiceDaemonRouteDiagnosticReason } from '@/voice/settings/voiceProviderLocalAvailability';

import { useLocalNeuralKokoroVoiceCatalog } from './useLocalNeuralKokoroVoiceCatalog.native';
import { useLocalNeuralModelPackState } from './useLocalNeuralModelPackState.native';

const ACCESSORY_BUTTON_STYLE = {
  width: 44,
  height: 44,
  alignItems: 'center',
  justifyContent: 'center',
} as const;

export function LocalNeuralTtsSettings(props: {
  cfgKokoro: VoiceLocalTtsSettings['localNeural'];
  setKokoro: (next: VoiceLocalTtsSettings['localNeural']) => void;
  networkTimeoutMs: number;
  popoverBoundaryRef?: React.RefObject<any> | null;
  daemonRouteDiagnosticReason?: VoiceDaemonRouteDiagnosticReason | null;
}) {
  const { theme } = useUnistyles();
  const [openMenu, setOpenMenu] = React.useState<null | 'assetSet' | 'voiceId' | 'speed'>(null);
  const executionPolicy = React.useMemo(() => resolveLocalNeuralExecutionPolicy({
    requestedExecution: props.cfgKokoro.execution,
  }), [props.cfgKokoro.execution]);

  const effectiveVoiceId = props.cfgKokoro.voiceId ?? 'af_heart';
  const effectiveSpeed = props.cfgKokoro.speed ?? 1;
  const effectiveAssetSetId = resolveKokoroDaemonTtsPackId(props.cfgKokoro.assetId ?? KOKORO_DEFAULT_TTS_PACK_ID);
  const usesDaemonExecution = executionPolicy.preferredExecution === 'daemon';
  const assetSets = React.useMemo(() => getKokoroAssetSetOptions().filter((s) => s.id), []);
  const catalogEntry = getModelPackCatalogEntry(effectiveAssetSetId);
  const publicationAvailable = catalogEntry === null || isPublishedModelPackCatalogEntry(catalogEntry);
  const runtimeSupported = React.useMemo(
    () => publicationAvailable && isKokoroRuntimeSupported(),
    [publicationAvailable],
  );

  const manifestUrl = React.useMemo(
    () => publicationAvailable ? resolveModelPackManifestUrl({ packId: effectiveAssetSetId }) : null,
    [effectiveAssetSetId, publicationAvailable],
  );

  const { modelStatus, downloadDetail, installed, installSummary, updateCheckedRemote, prepareModel, cancelPrepare, clearAssets, checkForUpdates } =
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

  const buildLabel = formatModelPackBuildLabel((installSummary as any)?.manifest);
  const readyDetail = buildLabel ? `${t('settingsVoice.local.kokoro.modelStatus.ready')} • ${buildLabel}` : t('settingsVoice.local.kokoro.modelStatus.ready');

  const modelDetail =
    modelStatus === 'downloading'
      ? (downloadDetail ?? t('settingsVoice.local.kokoro.modelStatus.downloading'))
      : modelStatus === 'ready'
        ? readyDetail
        : modelStatus === 'error'
          ? t('settingsVoice.local.kokoro.modelStatus.error')
        : installed
            ? readyDetail
            : t('settingsVoice.local.kokoro.modelStatus.notDownloaded');

  const updateDetail = updateCheckedRemote
    ? updateCheckedRemote.updateAvailable
      ? `${t('settingsVoice.local.kokoro.updates.updateAvailable')}${updateCheckedRemote.build ? ` • ${updateCheckedRemote.build}` : ''}`
      : updateCheckedRemote.build
        ? `${t('settingsVoice.local.kokoro.updates.upToDate')} • ${updateCheckedRemote.build}`
        : t('settingsVoice.local.kokoro.updates.upToDate')
    : t('settingsVoice.local.kokoro.updates.check');

  return (
    <>
      <DaemonVoiceInferenceExecutionDropdown
        execution={executionPolicy.selectableExecution}
        setExecution={(execution) => props.setKokoro({ ...props.cfgKokoro, execution })}
        popoverBoundaryRef={props.popoverBoundaryRef}
        allowDeviceSelection={executionPolicy.allowDeviceSelection}
      />

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

      {usesDaemonExecution ? (
        <SelectedDaemonModelPackRow
          packId={effectiveAssetSetId}
          kind="tts_sherpa"
        />
      ) : (
        <>
          <Item
            title={t('settingsVoice.local.kokoro.model.title')}
            subtitle={t('settingsVoice.local.kokoro.model.subtitleNative')}
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
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={t('common.cancel')}
                  style={ACCESSORY_BUTTON_STYLE}
                  onPress={(event) => {
                    event.stopPropagation?.();
                    cancelPrepare();
                  }}
                >
                  <Ionicons name="close" size={20} color={theme.colors.text.secondary} />
                </Pressable>
              ) : (
                <Ionicons name="download-outline" size={20} color={theme.colors.text.secondary} />
              )
            }
            rightElementOutsidePressable={modelStatus === 'downloading'}
            showChevron={false}
            selected={false}
          />

          <Item
            title={t('settingsVoice.local.kokoro.removeAssets.title')}
            subtitle={t('settingsVoice.local.kokoro.removeAssets.subtitle')}
            detail={installed ? t('settingsVoice.local.kokoro.removeAssets.detailRemove') : t('settingsVoice.local.kokoro.common.none')}
            onPress={installed ? clearAssets : undefined}
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
        </>
      )}

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
        itemRowProps={{ rightElementOutsidePressable: true }}
        popoverBoundaryRef={props.popoverBoundaryRef}
        itemTrigger={{
          title: t('settingsVoice.local.kokoro.voice.title'),
          subtitle: t('settingsVoice.local.kokoro.voice.subtitleNative'),
          showSelectedSubtitle: false,
          detailFormatter: () => effectiveVoiceId,
        }}
        items={voices.map((v) => ({
          id: v.id,
          title: v.title,
          subtitle: v.subtitle,
          rightElement: (
            <View style={{ paddingRight: 4 }}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t('settingsVoice.realtimeProviders.catalog.preview', { voice: v.title })}
                style={ACCESSORY_BUTTON_STYLE}
                onPress={(e) => {
                  e.stopPropagation?.();
                  void playPreview(v.id);
                }}
              >
                <Ionicons
                  name={previewingVoiceId === v.id ? 'pause' : 'play'}
                  size={18}
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
