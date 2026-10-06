import type { SettingOperationResult } from '@/components/settings/catalog/settingDeclarations';
import { Modal } from '@/modal';
import { t } from '@/text';
import { throwIfAborted } from '@/utils/runtime/abortSignals';
import { checkModelPackUpdateAvailable, ensureModelPackInstalled, removeModelPack } from '@/voice/modelPacks/installer.native';
import { resolveModelPackManifestUrl } from '@/voice/modelPacks/manifests';
import { formatModelPackBuildLabel } from '@/voice/modelPacks/formatBuildLabel';
import { prepareKokoroTts } from '@/voice/kokoro/runtime/synthesizeKokoroWav';
import type { VoiceDeviceModelPackOperationInput } from './voiceDeviceModelPackOperation';

/** Uses the incumbent installer, its runtime invalidation and its declared download budgets. */
export async function invokeVoiceDeviceModelPackOperation(input: VoiceDeviceModelPackOperationInput): Promise<SettingOperationResult> {
    const signal = input.signal ?? new AbortController().signal;
    const isCurrent = async () => {
        throwIfAborted(signal);
        const current = await input.isCurrent();
        throwIfAborted(signal);
        return current;
    };
    if (!await isCurrent()) return { status: 'cancelled' };
    if (input.operation === 'remove') {
        const confirmed = input.role === 'stt_sherpa'
            ? await Modal.confirm(t('settingsVoice.local.localNeuralStt.removeModelFiles.confirmTitle'),
                t('settingsVoice.local.localNeuralStt.removeModelFiles.confirmBody'), { confirmText: t('common.remove'), destructive: true })
            : await Modal.confirm(t('settingsVoice.local.kokoro.removeAssets.confirmTitle'),
                t('settingsVoice.local.kokoro.removeAssets.confirmBody'),
                { confirmText: t('settingsVoice.local.kokoro.removeAssets.confirmButton'), destructive: true });
        throwIfAborted(signal);
        if (!confirmed || !await isCurrent()) return { status: 'cancelled' };
        await removeModelPack({ packId: input.packId, signal });
        return await isCurrent() ? { status: 'completed' } : { status: 'cancelled' };
    }
    if (input.operation === 'prepare' && input.role === 'tts_sherpa') {
        // The settings UI prepares the installed runtime as well as its files.
        input.onDownloadStarted?.();
        await prepareKokoroTts({ assetSetId: input.packId, timeoutMs: Math.max(60_000, input.networkTimeoutMs), signal,
            onProgress: input.onProgress });
        return await isCurrent() ? { status: 'completed', value: { packId: input.packId } } : { status: 'cancelled' };
    }
    const manifestUrl = input.manifestUrl === undefined ? resolveModelPackManifestUrl({ packId: input.packId }) : input.manifestUrl;
    if (!manifestUrl) return { status: 'unavailable', reason: 'model_manifest_unavailable' };
    if (input.operation === 'update') {
        const status = await checkModelPackUpdateAvailable({ packId: input.packId, manifestUrl,
            timeoutMs: input.role === 'stt_sherpa' ? 30_000 : Math.max(30_000, input.networkTimeoutMs), signal });
        if (!await isCurrent()) return { status: 'cancelled' };
        if (!status.installed) return { status: 'unavailable', reason: 'model_not_installed' };
        const remoteBuild = formatModelPackBuildLabel(status.remoteManifest);
        input.onUpdateChecked?.({ build: remoteBuild, updateAvailable: status.updateAvailable });
        if (!status.updateAvailable) return { status: 'completed', value: { updateAvailable: false } };
        const confirmed = await Modal.confirm(
            t(input.role === 'stt_sherpa' ? 'settingsVoice.local.kokoro.updates.updateAvailable' : 'settingsVoice.local.kokoro.alerts.updateAvailableTitle'),
            input.role === 'stt_sherpa'
                ? t('settingsVoice.local.localNeuralStt.alerts.updateAvailableBody', { remoteBuild })
                : t('settingsVoice.local.kokoro.alerts.updateAvailableBody', { remoteBuild }),
            { confirmText: t('common.update') });
        throwIfAborted(signal);
        if (!confirmed || !await isCurrent()) return { status: 'cancelled' };
    }
    if (!await isCurrent()) return { status: 'cancelled' };
    input.onDownloadStarted?.();
    const result = await ensureModelPackInstalled({ packId: input.packId, manifestUrl, mode: 'download_if_missing',
        ...(input.operation === 'update' ? { updatePolicy: 'manual_update_if_available' as const } : {}),
        timeoutMs: input.role === 'stt_sherpa' ? 120_000 : Math.max(120_000, input.networkTimeoutMs), signal,
        onProgress: input.onProgress });
    return await isCurrent() ? { status: 'completed', value: { packId: result.manifest.packId } } : { status: 'cancelled' };
}
