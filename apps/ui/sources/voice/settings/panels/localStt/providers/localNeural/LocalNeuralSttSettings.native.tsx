import * as React from 'react';
import { SettingAnchor } from '@/components/settings/shell/SettingRow';
import { useVoiceSttSettingRefs } from '@/voice/settings/useVoiceSttSettingRefs';

import { Platform } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Item } from '@/components/ui/lists/Item';
import { IconButton } from '@/components/ui/buttons/IconButton';
import type { VoiceLocalSttSettings } from '@/sync/domains/settings/voiceLocalSttSettings';
import type { VoiceDaemonRouteDiagnosticReason } from '@/voice/settings/voiceProviderLocalAvailability';
import { t } from '@/text';
import { formatDownloadProgressDetail } from '@/voice/downloads/downloadProgress';
import { useLocalNeuralModelPackState } from '@/voice/settings/panels/localTts/useLocalNeuralModelPackState.native';
import { formatModelPackBuildLabel } from '@/voice/modelPacks/formatBuildLabel';
import { resolveModelPackManifestUrl } from '@/voice/modelPacks/manifests';
import { resolveLocalNeuralExecutionPolicy } from '@/voice/runtime/daemonInference/daemonVoiceInferencePolicy';
import { getSherpaStreamingSttPackOptions } from '@/voice/sherpa/stt/sherpaStreamingSttPacks';
import { DaemonVoiceInferenceExecutionDropdown } from '@/voice/settings/panels/daemonInference/DaemonVoiceInferenceExecutionDropdown';
import { SelectedDaemonModelPackRow } from '@/voice/settings/panels/modelCatalog/DaemonModelPackRow';
import { Icon } from '@/components/ui/icons/Icon';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import { LocalNeuralSttLanguageItem } from './LocalNeuralSttLanguageItem';

const ACCESSORY_TARGET_SIZE = resolveMinimumInteractiveTargetSize(Platform.OS);

export function LocalNeuralSttSettings(props: {
  cfg: VoiceLocalSttSettings;
  setCfg: (next: VoiceLocalSttSettings) => void;
  popoverBoundaryRef?: React.RefObject<any> | null;
  daemonRouteDiagnosticReason?: VoiceDaemonRouteDiagnosticReason | null;
}) {
  const settings = useVoiceSttSettingRefs();
  const { theme } = useUnistyles();
  const [openMenu, setOpenMenu] = React.useState<null | 'packId' | 'language'>(null);
  const executionPolicy = React.useMemo(() => resolveLocalNeuralExecutionPolicy({
    requestedExecution: props.cfg.localNeural.execution,
  }), [props.cfg.localNeural.execution]);

  const packOptions = getSherpaStreamingSttPackOptions();
  const effectivePackId = props.cfg.localNeural.assetId ?? packOptions[0]?.id ?? null;
  const usesDaemonExecution = executionPolicy.preferredExecution === 'daemon';

  const setLocalNeural = (patch: Partial<VoiceLocalSttSettings['localNeural']>) => {
    props.setCfg({
      ...props.cfg,
      provider: 'local_neural',
      localNeural: { ...props.cfg.localNeural, ...patch },
    });
  };

  React.useEffect(() => {
    if (props.cfg.provider !== 'local_neural') return;
    if (props.cfg.localNeural.assetId) return;
    if (!effectivePackId) return;
    setLocalNeural({ assetId: effectivePackId });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectivePackId, props.cfg.localNeural.assetId, props.cfg.provider]);

  const { modelStatus, downloadProgress: progress, installed, installSummary, updateCheckedRemote,
    prepareModel, cancelPrepare, clearAssets, checkForUpdates } = useLocalNeuralModelPackState({
    packId: effectivePackId ?? '',
    manifestUrl: resolveModelPackManifestUrl({ packId: effectivePackId }),
    role: 'stt_sherpa',
    enabled: !usesDaemonExecution && props.cfg.provider === 'local_neural' && Boolean(effectivePackId),
  });

  const installedBuild = formatModelPackBuildLabel(installSummary?.manifest);
  const downloadDetail =
    modelStatus === 'downloading'
      ? (progress
        ? formatDownloadProgressDetail(progress, { prefix: t('settingsVoice.local.kokoro.modelStatus.downloadingPrefix') })
        : t('settingsVoice.local.kokoro.modelStatus.downloading'))
      : installed
        ? installedBuild
          ? t('settingsVoice.local.localNeuralStt.status.installedWithBuild', { build: installedBuild })
          : t('settingsVoice.local.localNeuralStt.status.installed')
        : t('settingsVoice.local.localNeuralStt.status.notInstalled');

  return (
    <>
      <SettingAnchor setting={settings.sttExecution}>
      <DaemonVoiceInferenceExecutionDropdown
        execution={executionPolicy.selectableExecution}
        setExecution={(execution) => setLocalNeural({ execution })}
        popoverBoundaryRef={props.popoverBoundaryRef}
        allowDeviceSelection={executionPolicy.allowDeviceSelection}
      />
      </SettingAnchor>

      <SettingAnchor setting={settings.sttAssetId}>
      <DropdownMenu
        open={openMenu === 'packId'}
        onOpenChange={(next) => setOpenMenu(next ? 'packId' : null)}
        variant="selectable"
        search={false}
        selectedId={effectivePackId ?? ''}
        showCategoryTitles={false}
        matchTriggerWidth={true}
        connectToTrigger={true}
        rowKind="item"
        popoverBoundaryRef={props.popoverBoundaryRef}
        itemTrigger={{
          title: t('settingsVoice.local.localNeuralStt.modelPack.title'),
          subtitle: t('settingsVoice.local.localNeuralStt.modelPack.subtitle'),
          showSelectedSubtitle: false,
          detailFormatter: () => (effectivePackId ?? t('settingsVoice.local.notSet')),
        }}
        items={packOptions.map((p) => ({ id: p.id, title: p.title, subtitle: p.subtitle }))}
        onSelect={(id) => {
          setLocalNeural({ assetId: id || null });
          setOpenMenu(null);
        }}
      />
      </SettingAnchor>

      {usesDaemonExecution ? (
        <SelectedDaemonModelPackRow
          packId={effectivePackId}
          kind="stt_sherpa"
          setting={settings.sttPrepareModel}
        />
      ) : (
        <>
          <SettingAnchor setting={settings.sttPrepareModel}>
          <Item
            title={t('settingsVoice.local.localNeuralStt.modelFiles.title')}
            subtitle={t('settingsVoice.local.localNeuralStt.modelFiles.subtitle')}
            detail={downloadDetail}
            onPress={() => void prepareModel()}
            rightElement={
              modelStatus === 'downloading' ? (
                <IconButton
                  accessibilityLabel={t('common.cancel')}
                  variant="plain"
                  size={ACCESSORY_TARGET_SIZE}
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

          <SettingAnchor setting={settings.sttRemoveModel}>
          <Item
            title={t('settingsVoice.local.localNeuralStt.removeModelFiles.title')}
            subtitle={t('settingsVoice.local.localNeuralStt.removeModelFiles.subtitle')}
            detail={installed ? t('common.remove') : '—'}
            onPress={installed ? () => void clearAssets() : undefined}
            showChevron={false}
            selected={false}
          />
          </SettingAnchor>

          <SettingAnchor setting={settings.sttUpdateModel}>
          <Item
            title={t('settingsVoice.local.kokoro.updates.title')}
            subtitle={t('settingsVoice.local.kokoro.updates.subtitle')}
            detail={
              updateCheckedRemote
                ? updateCheckedRemote.updateAvailable
                  ? `${t('settingsVoice.local.kokoro.updates.updateAvailable')}${updateCheckedRemote.build ? ` • ${updateCheckedRemote.build}` : ''}`
                  : updateCheckedRemote.build
                    ? `${t('settingsVoice.local.kokoro.updates.upToDate')} • ${updateCheckedRemote.build}`
                    : t('settingsVoice.local.kokoro.updates.upToDate')
                : t('settingsVoice.local.kokoro.updates.check')
            }
            onPress={() => void checkForUpdates()}
            showChevron={false}
            selected={false}
          />
          </SettingAnchor>
        </>
      )}

      <LocalNeuralSttLanguageItem
        language={props.cfg.localNeural.language}
        open={openMenu === 'language'}
        onOpenChange={(next) => setOpenMenu(next ? 'language' : null)}
        popoverBoundaryRef={props.popoverBoundaryRef}
        onSelect={(language) => setLocalNeural({ language })}
      />
    </>
  );
}
