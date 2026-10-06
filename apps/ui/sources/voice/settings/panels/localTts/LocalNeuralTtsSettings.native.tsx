import * as React from 'react';
import { SettingAnchor } from '@/components/settings/shell/SettingRow';
import { VOICE_CONVERSATIONS_SETTINGS } from '@/voice/settings/voiceSettingsDeclarations';

import { Platform, Pressable, View } from 'react-native';
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
import { previewLocalNeuralTts } from './providers/localNeural/previewLocalNeuralTts';
import { createVoicePlaybackController } from '@/voice/runtime/playback/VoicePlaybackController';
import { formatModelPackBuildLabel } from '@/voice/modelPacks/formatBuildLabel';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { resolveLocalNeuralExecutionPolicy } from '@/voice/runtime/daemonInference/daemonVoiceInferencePolicy';
import { DaemonVoiceInferenceExecutionDropdown } from '@/voice/settings/panels/daemonInference/DaemonVoiceInferenceExecutionDropdown';
import { SelectedDaemonModelPackRow } from '@/voice/settings/panels/modelCatalog/DaemonModelPackRow';
import type { VoiceDaemonRouteDiagnosticReason } from '@/voice/settings/voiceProviderLocalAvailability';

import { useLocalNeuralKokoroVoiceCatalog } from './useLocalNeuralKokoroVoiceCatalog.native';
import { useLocalNeuralModelPackState } from './useLocalNeuralModelPackState.native';
import { resolveDaemonTtsVoiceSelection } from './resolveDaemonTtsVoiceSelection';
import { LocalNeuralTtsSpeedItem } from './LocalNeuralTtsSpeedItem';
import { Icon } from '@/components/ui/icons/Icon';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import { useDaemonVoiceModelCatalogController } from '@/voice/settings/panels/modelCatalog/DaemonVoiceModelCatalogContext';

const ACCESSORY_TARGET_SIZE = resolveMinimumInteractiveTargetSize(Platform.OS);
const ACCESSORY_BUTTON_STYLE = {
  width: ACCESSORY_TARGET_SIZE,
  height: ACCESSORY_TARGET_SIZE,
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

  const effectiveSpeed = props.cfgKokoro.speed ?? 1;
  const effectiveAssetSetId = resolveKokoroDaemonTtsPackId(props.cfgKokoro.assetId ?? KOKORO_DEFAULT_TTS_PACK_ID);
  const usesDaemonExecution = executionPolicy.preferredExecution === 'daemon';
  const assetSets = getKokoroAssetSetOptions().filter((s) => s.id);
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
      enabled: !usesDaemonExecution && publicationAvailable,
    });

  const deviceVoices = useLocalNeuralKokoroVoiceCatalog({ installSummary });
  const daemonCatalog = useDaemonVoiceModelCatalogController();
  const daemonVoiceSelection = React.useMemo(() => resolveDaemonTtsVoiceSelection({
    packId: effectiveAssetSetId,
    configuredVoiceId: props.cfgKokoro.voiceId,
    statuses: daemonCatalog?.state.statuses ?? [],
  }), [daemonCatalog?.state.statuses, effectiveAssetSetId, props.cfgKokoro.voiceId]);
  const voices = usesDaemonExecution ? daemonVoiceSelection.voices : deviceVoices;
  const effectiveVoiceId = usesDaemonExecution
    ? daemonVoiceSelection.selectedVoiceId
    : props.cfgKokoro.voiceId ?? installSummary?.manifest?.defaultVoiceId ?? deviceVoices[0]?.id ?? null;

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
        await previewLocalNeuralTts({
          sample: t('settingsVoice.local.testTtsSample'),
          config: { ...props.cfgKokoro, assetId: effectiveAssetSetId, voiceId, speed: effectiveSpeed },
          timeoutMs: Math.max(60000, props.networkTimeoutMs),
          registerPlaybackStopper: previewController.registerStopper,
        });
        setPreviewingVoiceId(null);
      } catch {
        setPreviewingVoiceId(null);
      }
    },
    [effectiveAssetSetId, effectiveSpeed, previewController.registerStopper, previewingVoiceId, props.cfgKokoro, props.networkTimeoutMs, stopPreview],
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
      <SettingAnchor setting={VOICE_CONVERSATIONS_SETTINGS.settings.ttsExecution}>
      <DaemonVoiceInferenceExecutionDropdown
        execution={executionPolicy.selectableExecution}
        setExecution={(execution) => props.setKokoro({ ...props.cfgKokoro, execution })}
        popoverBoundaryRef={props.popoverBoundaryRef}
        allowDeviceSelection={executionPolicy.allowDeviceSelection}
      />
      </SettingAnchor>

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

      <SettingAnchor setting={VOICE_CONVERSATIONS_SETTINGS.settings.ttsAssetId}>
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
      </SettingAnchor>

      {usesDaemonExecution ? (
        <SelectedDaemonModelPackRow
          packId={effectiveAssetSetId}
          kind="tts_sherpa"
          setting={VOICE_CONVERSATIONS_SETTINGS.settings.ttsPrepareModel}
        />
      ) : (
        <>
          <SettingAnchor setting={VOICE_CONVERSATIONS_SETTINGS.settings.ttsPrepareModel}>
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
                  <Icon name="x" size={20} color={theme.colors.text.secondary} />
                </Pressable>
              ) : (
                <Icon name="download" size={20} color={theme.colors.text.secondary} />
              )
            }
            rightElementOutsidePressable={modelStatus === 'downloading'}
            showChevron={false}
            selected={false}
          />
          </SettingAnchor>

          <SettingAnchor setting={VOICE_CONVERSATIONS_SETTINGS.settings.ttsRemoveModel}>
          <Item
            title={t('settingsVoice.local.kokoro.removeAssets.title')}
            subtitle={t('settingsVoice.local.kokoro.removeAssets.subtitle')}
            detail={installed ? t('settingsVoice.local.kokoro.removeAssets.detailRemove') : t('settingsVoice.local.kokoro.common.none')}
            onPress={installed ? clearAssets : undefined}
            showChevron={false}
            selected={false}
          />
          </SettingAnchor>

          <SettingAnchor setting={VOICE_CONVERSATIONS_SETTINGS.settings.ttsUpdateModel}>
          <Item
            title={t('settingsVoice.local.kokoro.updates.title')}
            subtitle={t('settingsVoice.local.kokoro.updates.subtitle')}
            detail={updateDetail}
            onPress={checkForUpdates}
            showChevron={false}
            selected={false}
          />
          </SettingAnchor>
        </>
      )}

      <SettingAnchor {...(usesDaemonExecution
        ? { settings: [VOICE_CONVERSATIONS_SETTINGS.settings.ttsPreview] }
        : { setting: VOICE_CONVERSATIONS_SETTINGS.settings.ttsPreview })}>
      <SettingAnchor setting={VOICE_CONVERSATIONS_SETTINGS.settings.ttsVoiceId}>
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
        itemRowProps={{ rightElementOutsidePressable: true }}
        popoverBoundaryRef={props.popoverBoundaryRef}
        itemTrigger={{
          title: t('settingsVoice.local.kokoro.voice.title'),
          subtitle: t('settingsVoice.local.kokoro.voice.subtitleNative'),
          showSelectedSubtitle: false,
          detailFormatter: () => effectiveVoiceId ?? t('common.unavailable'),
        }}
        items={voices.map((v) => ({
          id: v.id,
          title: v.title,
          subtitle: v.subtitle,
          rightElement: usesDaemonExecution ? undefined : (
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
          props.setKokoro({ ...props.cfgKokoro, voiceId: id || null });
          setOpenMenu(null);
        }}
      />
      </SettingAnchor>
      </SettingAnchor>
      <LocalNeuralTtsSpeedItem
        speed={effectiveSpeed}
        open={openMenu === 'speed'}
        onOpenChange={(next) => setOpenMenu(next ? 'speed' : null)}
        onSelect={(speed) => props.setKokoro({ ...props.cfgKokoro, speed })}
        popoverBoundaryRef={props.popoverBoundaryRef}
      />
    </>
  );
}
