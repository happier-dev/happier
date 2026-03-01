import * as React from 'react';

import { Ionicons } from '@expo/vector-icons';
import { Pressable } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Item } from '@/components/ui/lists/Item';
import { Modal } from '@/modal';
import type { VoiceLocalSttSettings } from '@/sync/domains/settings/voiceLocalSttSettings';
import { t } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { formatDownloadProgressDetail } from '@/voice/downloads/downloadProgress';
import { checkModelPackUpdateAvailable, ensureModelPackInstalled, getModelPackInstallSummary, removeModelPack } from '@/voice/modelPacks/installer.native';
import { formatModelPackBuildLabel } from '@/voice/modelPacks/formatBuildLabel';
import { resolveModelPackManifestUrl } from '@/voice/modelPacks/manifests';
import { getSherpaStreamingSttPackOptions } from '@/voice/sherpa/stt/sherpaStreamingSttPacks';

type Progress = { loaded: number; total: number; file?: string };

export function LocalNeuralSttSettings(props: {
  cfg: VoiceLocalSttSettings;
  setCfg: (next: VoiceLocalSttSettings) => void;
  popoverBoundaryRef?: React.RefObject<any> | null;
}) {
  const { theme } = useUnistyles();
  const [openMenu, setOpenMenu] = React.useState<null | 'packId' | 'language'>(null);

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

  const [modelStatus, setModelStatus] = React.useState<'idle' | 'downloading' | 'ready' | 'error'>('idle');
  const [progress, setProgress] = React.useState<Progress | null>(null);
  const prepareAbortRef = React.useRef<AbortController | null>(null);
  const [installed, setInstalled] = React.useState(false);
  const [installSummary, setInstallSummary] = React.useState<null | Awaited<ReturnType<typeof getModelPackInstallSummary>>>(null);
  const [updateCheckedRemote, setUpdateCheckedRemote] = React.useState<null | { build: string | null; updateAvailable: boolean }>(null);

  const refreshInstalled = React.useCallback(async () => {
    if (!effectivePackId) return;
    try {
      const summary = await getModelPackInstallSummary({ packId: effectivePackId });
      setInstalled(summary.installed);
      setInstallSummary(summary);
      setModelStatus((cur) => {
        if (cur === 'downloading') return cur;
        return summary.installed ? 'ready' : 'idle';
      });
      setUpdateCheckedRemote(null);
    } catch {
      setInstalled(false);
      setInstallSummary(null);
      setUpdateCheckedRemote(null);
    }
  }, [effectivePackId]);

  React.useEffect(() => {
    void refreshInstalled();
  }, [refreshInstalled]);

  const cancelPrepare = React.useCallback(() => {
    try {
      prepareAbortRef.current?.abort();
    } catch {
      // ignore
    }
  }, []);

  const prepareModel = React.useCallback(async () => {
    if (!effectivePackId) return;
    if (modelStatus === 'downloading') return;

    const manifestUrl = resolveModelPackManifestUrl({ packId: effectivePackId });
    if (!manifestUrl) {
      await Modal.alert(
        t('settingsVoice.local.kokoro.alerts.missingManifest.title'),
        t('settingsVoice.local.kokoro.alerts.missingManifest.body'),
      );
      return;
    }

    const abortController = new AbortController();
    prepareAbortRef.current = abortController;
    setModelStatus('downloading');
    setProgress(null);

    try {
      await ensureModelPackInstalled({
        packId: effectivePackId,
        mode: 'download_if_missing',
        manifestUrl,
        timeoutMs: 120_000,
        signal: abortController.signal,
        onProgress: (p) => setProgress(p),
      });
      setModelStatus('ready');
      await refreshInstalled();
    } catch (error) {
      if (abortController.signal.aborted) {
        setModelStatus(installed ? 'ready' : 'idle');
      } else {
        setModelStatus('error');
        await Modal.alert(
          t('settingsVoice.local.localNeuralStt.alerts.downloadFailedTitle'),
          t('settingsVoice.local.localNeuralStt.alerts.downloadFailedBody', { message: String((error as any)?.message ?? error) }),
        );
      }
    } finally {
      if (prepareAbortRef.current === abortController) prepareAbortRef.current = null;
      setProgress(null);
    }
  }, [effectivePackId, installed, modelStatus, refreshInstalled]);

  const clearAssets = React.useCallback(async () => {
    if (!effectivePackId) return;
    const ok = await Modal.confirm(
      t('settingsVoice.local.localNeuralStt.removeModelFiles.confirmTitle'),
      t('settingsVoice.local.localNeuralStt.removeModelFiles.confirmBody'),
      { confirmText: t('common.remove'), destructive: true },
    );
    if (!ok) return;
    await removeModelPack({ packId: effectivePackId });
    setInstalled(false);
    setModelStatus('idle');
  }, [effectivePackId]);

  const checkForUpdates = React.useCallback(async () => {
    if (!effectivePackId) return;
    if (modelStatus === 'downloading') return;

    const manifestUrl = resolveModelPackManifestUrl({ packId: effectivePackId });
    if (!manifestUrl) {
      await Modal.alert(
        t('settingsVoice.local.kokoro.alerts.missingManifest.title'),
        t('settingsVoice.local.kokoro.alerts.missingManifest.body'),
      );
      return;
    }

    const abortController = new AbortController();
    try {
      const status = await checkModelPackUpdateAvailable({
        packId: effectivePackId,
        manifestUrl,
        timeoutMs: 30_000,
        signal: abortController.signal,
      });
      if (!status.installed) {
        await Modal.alert(
          t('settingsVoice.local.localNeuralStt.alerts.notInstalledTitle'),
          t('settingsVoice.local.localNeuralStt.alerts.notInstalledBody'),
        );
        return;
      }
      const remoteBuild = formatModelPackBuildLabel(status.remoteManifest);
      setUpdateCheckedRemote({ build: remoteBuild, updateAvailable: status.updateAvailable });
      if (!status.updateAvailable) {
        await Modal.alert(
          t('settingsVoice.local.kokoro.updates.upToDate'),
          t('settingsVoice.local.localNeuralStt.alerts.upToDateBody'),
        );
        return;
      }

      const ok = await Modal.confirm(
        t('settingsVoice.local.kokoro.updates.updateAvailable'),
        t('settingsVoice.local.localNeuralStt.alerts.updateAvailableBody', { remoteBuild }),
        {
        confirmText: t('common.update'),
        },
      );
      if (!ok) return;

      setModelStatus('downloading');
      setProgress(null);
      prepareAbortRef.current = abortController;

      await ensureModelPackInstalled({
        packId: effectivePackId,
        mode: 'download_if_missing',
        updatePolicy: 'manual_update_if_available',
        manifestUrl,
        timeoutMs: 120_000,
        signal: abortController.signal,
        onProgress: (p) => setProgress(p),
      });

      setModelStatus('ready');
      await refreshInstalled();
      await Modal.alert(
        t('settingsVoice.local.localNeuralStt.alerts.updatedTitle'),
        t('settingsVoice.local.localNeuralStt.alerts.updatedBody'),
      );
    } catch (error) {
      if (abortController.signal.aborted) return;
      setModelStatus('error');
      await Modal.alert(
        t('settingsVoice.local.localNeuralStt.alerts.updateFailedTitle'),
        t('settingsVoice.local.localNeuralStt.alerts.updateFailedBody', { message: String((error as any)?.message ?? error) }),
      );
    } finally {
      prepareAbortRef.current = null;
      setProgress(null);
    }
  }, [effectivePackId, modelStatus, refreshInstalled]);

  const languageOptions = React.useMemo(
    () => {
      const bcp47Options = [
        { id: 'en', titleKey: 'settingsVoice.language.options.english' as const },
        { id: 'en-US', titleKey: 'settingsVoice.language.options.englishUs' as const },
        { id: 'fr', titleKey: 'settingsVoice.language.options.french' as const },
        { id: 'es', titleKey: 'settingsVoice.language.options.spanish' as const },
      ];

      return [
        { id: '', title: t('settingsVoice.language.autoDetect'), subtitle: t('settingsVoice.language.autoDetectSubtitle') },
        ...bcp47Options.map((o) => ({ id: o.id, title: t(o.titleKey), subtitle: o.id })),
        { id: '__custom__', title: t('settingsVoice.language.customTitle'), subtitle: t('settingsVoice.language.customSubtitle') },
      ];
    },
    [],
  );

  const effectiveLanguage = props.cfg.localNeural.language ?? '';
  const installedBuild = formatModelPackBuildLabel((installSummary as any)?.manifest);
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
        subtitle={t('settingsVoice.local.localNeuralStt.modelFiles.subtitle')}
        detail={downloadDetail}
        onPress={() => void prepareModel()}
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
        title={t('settingsVoice.local.localNeuralStt.removeModelFiles.title')}
        subtitle={t('settingsVoice.local.localNeuralStt.removeModelFiles.subtitle')}
        detail={installed ? t('common.remove') : '—'}
        onPress={installed ? () => void clearAssets() : undefined}
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

      <DropdownMenu
        open={openMenu === 'language'}
        onOpenChange={(next) => setOpenMenu(next ? 'language' : null)}
        variant="selectable"
        search={true}
        selectedId={effectiveLanguage}
        showCategoryTitles={false}
        matchTriggerWidth={true}
        connectToTrigger={true}
        rowKind="item"
        popoverBoundaryRef={props.popoverBoundaryRef}
        itemTrigger={{
          title: t('settingsVoice.local.localNeuralStt.language.title'),
          subtitle: t('settingsVoice.local.localNeuralStt.language.subtitle'),
          showSelectedSubtitle: false,
          detailFormatter: () => (effectiveLanguage || t('settingsVoice.language.autoDetect')),
        }}
        items={languageOptions}
        onSelect={(id) => {
          if (id === '__custom__') {
            fireAndForget((async () => {
              const raw = await Modal.prompt(
                t('settingsVoice.local.localNeuralStt.language.promptTitle'),
                t('settingsVoice.local.localNeuralStt.language.promptBody'),
                { placeholder: effectiveLanguage },
              );
              if (raw === null) return;
              const next = String(raw).trim();
              setLocalNeural({ language: next ? next : null });
            })(), { tag: 'LocalNeuralSttSettings.prompt.language' });
            setOpenMenu(null);
            return;
          }
          setLocalNeural({ language: id ? id : null });
          setOpenMenu(null);
        }}
      />
    </>
  );
}
