import type { SettingOperationResult } from '@/components/settings/catalog/settingDeclarations';
import { Modal } from '@/modal';
import { t } from '@/text';
import { throwIfAborted } from '@/utils/runtime/abortSignals';
import { checkModelPackUpdateAvailable, ensureModelPackInstalled, removeModelPack } from '@/voice/modelPacks/installer.native';
import { resolveModelPackManifestUrl } from '@/voice/modelPacks/manifests';
import { formatModelPackBuildLabel } from '@/voice/modelPacks/formatBuildLabel';
import { prepareKokoroTts } from '@/voice/kokoro/runtime/synthesizeKokoroWav';

/** Uses the incumbent installer, its runtime invalidation and its declared download budgets. */
export async function invokeVoiceDeviceModelPackOperation(input: Readonly<{
    operation: 'prepare' | 'remove' | 'update';
    packId: string;
    role: 'stt_sherpa' | 'tts_sherpa';
    networkTimeoutMs: number;
    signal?: AbortSignal;
    isCurrent(): boolean | Promise<boolean>;
}>): Promise<SettingOperationResult> {
    const signal = input.signal ?? new AbortController().signal;
    throwIfAborted(signal);
    if (!await input.isCurrent()) return { status: 'cancelled' };
    if (input.operation === 'remove') {
        const confirmed = input.role === 'stt_sherpa'
            ? await Modal.confirm(t('settingsVoice.local.localNeuralStt.removeModelFiles.confirmTitle'),
                t('settingsVoice.local.localNeuralStt.removeModelFiles.confirmBody'), { confirmText: t('common.remove'), destructive: true })
            : await Modal.confirm(t('settingsVoice.local.kokoro.removeAssets.confirmTitle'),
                t('settingsVoice.local.kokoro.removeAssets.confirmBody'),
                { confirmText: t('settingsVoice.local.kokoro.removeAssets.confirmButton'), destructive: true });
        throwIfAborted(signal);
        if (!confirmed || !await input.isCurrent()) return { status: 'cancelled' };
        await removeModelPack({ packId: input.packId });
        return await input.isCurrent() ? { status: 'completed' } : { status: 'cancelled' };
    }
    const manifestUrl = resolveModelPackManifestUrl({ packId: input.packId });
    if (!manifestUrl) return { status: 'unavailable', reason: 'model_manifest_unavailable' };
    if (input.operation === 'prepare' && input.role === 'tts_sherpa') {
        // The settings UI prepares the installed runtime as well as its files.
        await prepareKokoroTts({ assetSetId: input.packId, timeoutMs: Math.max(60_000, input.networkTimeoutMs), signal });
        return await input.isCurrent() ? { status: 'completed', value: { packId: input.packId } } : { status: 'cancelled' };
    }
    if (input.operation === 'update') {
        const status = await checkModelPackUpdateAvailable({ packId: input.packId, manifestUrl,
            timeoutMs: input.role === 'stt_sherpa' ? 30_000 : Math.max(30_000, input.networkTimeoutMs), signal });
        if (!await input.isCurrent()) return { status: 'cancelled' };
        if (!status.installed) return { status: 'unavailable', reason: 'model_not_installed' };
        if (!status.updateAvailable) return { status: 'completed', value: { updateAvailable: false } };
        const confirmed = await Modal.confirm(t('settingsVoice.local.kokoro.alerts.updateAvailableTitle'),
            t('settingsVoice.local.kokoro.alerts.updateAvailableBody', { remoteBuild: formatModelPackBuildLabel(status.remoteManifest) }),
            { confirmText: t('common.update') });
        throwIfAborted(signal);
        if (!confirmed || !await input.isCurrent()) return { status: 'cancelled' };
    }
    if (!await input.isCurrent()) return { status: 'cancelled' };
    const result = await ensureModelPackInstalled({ packId: input.packId, manifestUrl, mode: 'download_if_missing',
        ...(input.operation === 'update' ? { updatePolicy: 'manual_update_if_available' as const } : {}),
        timeoutMs: input.role === 'stt_sherpa' ? 120_000 : Math.max(120_000, input.networkTimeoutMs), signal });
    return await input.isCurrent() ? { status: 'completed', value: { packId: result.manifest.packId } } : { status: 'cancelled' };
}
