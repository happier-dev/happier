import * as React from 'react';

import { Ionicons } from '@expo/vector-icons';
import { Pressable } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Item } from '@/components/ui/lists/Item';
import { Modal } from '@/modal';
import type { VoiceLocalSttSettings } from '@/sync/domains/settings/voiceLocalSttSettings';
import { t } from '@/text';
import { checkModelPackUpdateAvailable, ensureModelPackInstalled, getModelPackInstallSummary, removeModelPack } from '@/voice/modelPacks/installer.native';
import { formatModelPackBuildLabel } from '@/voice/modelPacks/formatBuildLabel';
import { resolveModelPackManifestUrl } from '@/voice/modelPacks/manifests';
import { getSherpaStreamingSttPackOptions } from '@/voice/sherpa/stt/sherpaStreamingSttPacks';

type Progress = { loaded: number; total: number };

function formatPercent(p: Progress | null): string | null {
  if (!p || !Number.isFinite(p.loaded) || !Number.isFinite(p.total) || p.total <= 0) return null;
  return `${Math.max(0, Math.min(100, Math.floor((p.loaded / p.total) * 100)))}%`;
}

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
        'Manifest not configured',
        'Set EXPO_PUBLIC_HAPPIER_MODEL_PACK_MANIFESTS (or legacy Kokoro env vars) to enable model downloads.',
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
        onProgress: (p) => setProgress({ loaded: p.loaded, total: p.total }),
      });
      setModelStatus('ready');
      await refreshInstalled();
    } catch (error) {
      if (abortController.signal.aborted) {
        setModelStatus(installed ? 'ready' : 'idle');
      } else {
        setModelStatus('error');
        await Modal.alert('Download failed', `Unable to download this model pack.\n\n${String((error as any)?.message ?? error)}`);
      }
    } finally {
      if (prepareAbortRef.current === abortController) prepareAbortRef.current = null;
      setProgress(null);
    }
  }, [effectivePackId, installed, modelStatus, refreshInstalled]);

  const clearAssets = React.useCallback(async () => {
    if (!effectivePackId) return;
    const ok = await Modal.confirm(
      'Remove model files?',
      'This will remove the downloaded STT model pack from this device.',
      { confirmText: 'Remove', destructive: true },
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
        'Manifest not configured',
        'Set EXPO_PUBLIC_HAPPIER_MODEL_PACK_MANIFESTS (or legacy Kokoro env vars) to enable model downloads.',
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
        await Modal.alert('Not installed', 'Download the model pack first to enable update checks.');
        return;
      }
      const remoteBuild = formatModelPackBuildLabel(status.remoteManifest);
      setUpdateCheckedRemote({ build: remoteBuild, updateAvailable: status.updateAvailable });
      if (!status.updateAvailable) {
        await Modal.alert('Up to date', 'No updates are available for this model pack.');
        return;
      }

      const ok = await Modal.confirm(
        'Update available',
        `Download the latest version of this model pack now?${remoteBuild ? `\n\nRemote build: ${remoteBuild}` : ''}`,
        {
        confirmText: 'Update',
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
        onProgress: (p) => setProgress({ loaded: p.loaded, total: p.total }),
      });

      setModelStatus('ready');
      await refreshInstalled();
      await Modal.alert('Updated', 'Model pack updated successfully.');
    } catch (error) {
      if (abortController.signal.aborted) return;
      setModelStatus('error');
      await Modal.alert('Update failed', `Unable to update this model pack.\n\n${String((error as any)?.message ?? error)}`);
    } finally {
      prepareAbortRef.current = null;
      setProgress(null);
    }
  }, [effectivePackId, modelStatus, refreshInstalled]);

  const languageOptions = React.useMemo(
    () => [
      { id: '', title: t('settingsVoice.language.autoDetect'), subtitle: 'Let the recognizer decide (recommended).' },
      { id: 'en', title: 'English', subtitle: 'en' },
      { id: 'en-US', title: 'English (US)', subtitle: 'en-US' },
      { id: 'fr', title: 'French', subtitle: 'fr' },
      { id: 'es', title: 'Spanish', subtitle: 'es' },
      { id: '__custom__', title: 'Custom…', subtitle: 'Enter a BCP-47 language tag.' },
    ],
    [],
  );

  const effectiveLanguage = props.cfg.localNeural.language ?? '';
  const installedBuild = formatModelPackBuildLabel((installSummary as any)?.manifest);
  const downloadDetail =
    modelStatus === 'downloading'
      ? `Downloading${formatPercent(progress) ? ` (${formatPercent(progress)})` : ''}`
      : installed
        ? installedBuild
          ? `Installed • ${installedBuild}`
          : 'Installed'
        : 'Not installed';

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
        trigger={({ open, toggle }) => (
          <Item
            title="Model pack"
            subtitle="Streaming STT model pack id."
            detail={effectivePackId ?? t('settingsVoice.local.notSet')}
            rightElement={<Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={20} color={theme.colors.textSecondary} />}
            onPress={toggle}
            showChevron={false}
            selected={false}
          />
        )}
        items={packOptions.map((p) => ({ id: p.id, title: p.title, subtitle: p.subtitle }))}
        onSelect={(id) => {
          setLocalNeural({ assetId: id || null });
          setOpenMenu(null);
        }}
      />

      <Item
        title="Model files"
        subtitle="Download required files to enable on-device streaming STT."
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
        title="Remove model files"
        subtitle="Free storage by removing downloaded model files."
        detail={installed ? 'Remove' : '—'}
        onPress={installed ? () => void clearAssets() : undefined}
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
        trigger={({ open, toggle }) => (
          <Item
            title="Language"
            subtitle="Optional BCP-47 language tag."
            detail={effectiveLanguage || t('settingsVoice.language.autoDetect')}
            rightElement={<Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={20} color={theme.colors.textSecondary} />}
            onPress={toggle}
            showChevron={false}
            selected={false}
          />
        )}
        items={languageOptions}
        onSelect={(id) => {
          if (id === '__custom__') {
            void (async () => {
              const raw = await Modal.prompt('Language', 'Enter a BCP-47 language tag (e.g. en, en-US).', { placeholder: effectiveLanguage });
              if (raw === null) return;
              const next = String(raw).trim();
              setLocalNeural({ language: next ? next : null });
            })();
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
