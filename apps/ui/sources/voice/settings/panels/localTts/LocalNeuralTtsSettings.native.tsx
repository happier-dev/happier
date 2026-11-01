import {
  readPartialDownloadBytes,
  resolveModelPackTransferRow,
  resolvePartialDownloadRemoveRow,
} from '@/voice/settings/panels/modelPack/modelPackTransferRows';
import * as React from 'react';
import { SettingAnchor } from '@/components/settings/shell/SettingRow';
import { VOICE_CONVERSATIONS_SETTINGS } from '@/voice/settings/voiceSettingsDeclarations';

import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { t } from '@/text';
import {
  getModelPackCatalogEntry,
  isPublishedModelPackCatalogEntry,
} from '@happier-dev/protocol/voice/modelPacks/catalog';
import type { VoiceLocalTtsSettings } from '@/sync/domains/settings/voiceLocalTtsSettings';
import { getKokoroAssetSetOptions } from '@/voice/kokoro/assets/kokoroAssetSets';
import { resolveKokoroDaemonTtsPackId } from '@/voice/kokoro/assets/resolveKokoroDaemonTtsPackId';
import { resolveModelPackManifestUrl } from '@/voice/modelPacks/manifests';
import { isKokoroRuntimeSupported } from '@/voice/kokoro/runtime/kokoroSupport';
import { BUILT_IN_LOCAL_NEURAL_VOICE_PROVIDER_ID } from '@happier-dev/protocol/sessions/instructions/sessionVoicePreferenceV1';
import { useRealtimeCatalogPreview } from '../realtime/realtimeVoiceCatalogMenu';
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
import { resolveLocalNeuralTtsOptions } from '@/voice/local/localVoiceSettings';
import { Icon } from '@/components/ui/icons/Icon';
import { useDaemonVoiceModelCatalogController } from '@/voice/settings/panels/modelCatalog/DaemonVoiceModelCatalogContext';


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

  const effectiveSpeed = resolveLocalNeuralTtsOptions(props.cfgKokoro).speed;
  const effectiveAssetSetId = resolveKokoroDaemonTtsPackId(props.cfgKokoro.assetId);
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

  const { modelStatus, downloadProgress, installed, installSummary, updateCheckedRemote, prepareModel, cancelPrepare, clearAssets, checkForUpdates } =
    useLocalNeuralModelPackState({
      packId: effectiveAssetSetId,
      enabled: !usesDaemonExecution,
      readEnabled: publicationAvailable,
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

  const { previewingId: previewingVoiceId, playPreview, retirePreview } = useRealtimeCatalogPreview(
    BUILT_IN_LOCAL_NEURAL_VOICE_PROVIDER_ID,
    { targetKey: JSON.stringify([effectiveAssetSetId, props.cfgKokoro.execution]) },
  );

  React.useEffect(() => {
    if (openMenu === 'voiceId') return;
    retirePreview();
  }, [openMenu, retirePreview]);

  const buildLabel = formatModelPackBuildLabel((installSummary as any)?.manifest);
  const readyDetail = buildLabel ? `${t('settingsVoice.local.kokoro.modelStatus.ready')} • ${buildLabel}` : t('settingsVoice.local.kokoro.modelStatus.ready');

  const partialBytes = readPartialDownloadBytes(installSummary);
  const transferRow = resolveModelPackTransferRow({ status: modelStatus, progress: downloadProgress, partialBytes });
  const partialRemoveRow = resolvePartialDownloadRemoveRow(partialBytes);
  const modelDetail = transferRow?.detail
    ?? (installed ? readyDetail : t('settingsVoice.local.kokoro.modelStatus.notDownloaded'));

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
          retirePreview();
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
            subtitle={transferRow?.subtitle ?? t('settingsVoice.local.kokoro.model.subtitleNative')}
            subtitleLines={transferRow ? 0 : undefined}
            detail={modelDetail}
            onPress={prepareModel}
            rightElement={
              modelStatus === 'downloading' ? (
                <IconButton
                  accessibilityLabel={t('common.cancel')}
                  variant="plain"
                  onPress={(event) => {
                    event?.stopPropagation?.();
                    cancelPrepare();
                  }}
                  icon={<Icon name="x" size={20} color={theme.colors.text.secondary} />}
                />
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
            subtitle={partialRemoveRow?.subtitle ?? t('settingsVoice.local.kokoro.removeAssets.subtitle')}
            detail={installed ? t('settingsVoice.local.kokoro.removeAssets.detailRemove') : (partialRemoveRow?.detail ?? t('settingsVoice.local.kokoro.common.none'))}
            onPress={installed || partialRemoveRow ? clearAssets : undefined}
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
      <SettingAnchor settings={[VOICE_CONVERSATIONS_SETTINGS.settings.ttsVoiceId,
        VOICE_CONVERSATIONS_SETTINGS.settings.ttsCatalog, VOICE_CONVERSATIONS_SETTINGS.settings.ttsCatalogRetry]}>
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
            <View style={{ paddingRight: theme.space.s4 }}>
              <IconButton
                accessibilityLabel={t('settingsVoice.realtimeProviders.catalog.preview', { voice: v.title })}
                variant="plain"
                onPress={(e) => {
                  e?.stopPropagation?.();
                  fireAndForget(playPreview({ id: v.id, name: v.title }), { tag: 'LocalNeuralTtsSettings.preview' });
                }}
                icon={<Icon
                  name={previewingVoiceId === v.id ? 'pause-circle' : 'play'}
                  size={16}
                  color={theme.colors.text.secondary}
                />}
              />
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
