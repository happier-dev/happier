import * as React from 'react';

import { Pressable } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Item } from '@/components/ui/lists/Item';
import type { VoiceLocalSttSettings } from '@/sync/domains/settings/voiceLocalSttSettings';
import { t } from '@/text';
import { useNativeModelPackState } from '@/voice/settings/panels/modelPack/useNativeModelPackState.native';
import { formatModelPackBuildLabel } from '@/voice/modelPacks/formatBuildLabel';
import { resolveModelPackManifestUrl } from '@/voice/modelPacks/manifests';
import { getSherpaStreamingSttPackOptions } from '@/voice/sherpa/stt/sherpaStreamingSttPacks';
import { Icon } from '@/components/ui/icons/Icon';
import {
  readPartialDownloadBytes,
  resolveModelPackTransferRow,
  resolvePartialDownloadRemoveRow,
} from '@/voice/settings/panels/modelPack/modelPackTransferRows';

export function LocalNeuralSttSettings(props: {
  cfg: VoiceLocalSttSettings;
  setCfg: (next: VoiceLocalSttSettings) => void;
  popoverBoundaryRef?: React.RefObject<any> | null;
}) {
  const { theme } = useUnistyles();
  const [openMenu, setOpenMenu] = React.useState<null | 'packId'>(null);

  const packOptions = React.useMemo(() => getSherpaStreamingSttPackOptions(), []);
  const effectivePackId = props.cfg.localNeural.assetId ?? packOptions[0]?.id ?? null;

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
    prepareModel, cancelPrepare, clearAssets, checkForUpdates } = useNativeModelPackState({
    role: 'stt',
    packId: effectivePackId,
    manifestUrl: resolveModelPackManifestUrl({ packId: effectivePackId }),
  });

  const installedBuild = formatModelPackBuildLabel((installSummary as any)?.manifest);
  const partialBytes = readPartialDownloadBytes(installSummary);
  const transferRow = resolveModelPackTransferRow({ status: modelStatus, progress, partialBytes });
  const partialRemoveRow = installed ? null : resolvePartialDownloadRemoveRow(partialBytes);
  const downloadDetail =
    transferRow?.detail
      ?? (installed
        ? installedBuild
          ? t('settingsVoice.local.localNeuralStt.status.installedWithBuild', { build: installedBuild })
          : t('settingsVoice.local.localNeuralStt.status.installed')
        : t('settingsVoice.local.localNeuralStt.status.notInstalled'));

  return (
    <>
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

      <Item
        title={t('settingsVoice.local.localNeuralStt.modelFiles.title')}
        subtitle={transferRow?.subtitle ?? t('settingsVoice.local.localNeuralStt.modelFiles.subtitle')}
        subtitleLines={transferRow ? 0 : undefined}
        detail={downloadDetail}
        onPress={() => void prepareModel()}
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
        title={t('settingsVoice.local.localNeuralStt.removeModelFiles.title')}
        subtitle={partialRemoveRow?.subtitle ?? t('settingsVoice.local.localNeuralStt.removeModelFiles.subtitle')}
        detail={installed ? t('common.remove') : (partialRemoveRow?.detail ?? '—')}
        onPress={installed || partialRemoveRow ? () => void clearAssets() : undefined}
        showChevron={false}
        selected={false}
      />

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
    </>
  );
}
