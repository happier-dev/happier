import type { SettingOperationResult } from '@/components/settings/catalog/settingDeclarations';

export type VoiceDeviceModelPackOperationInput = Readonly<{
    operation: 'prepare' | 'remove' | 'update';
    packId: string;
    role: 'stt_sherpa' | 'tts_sherpa';
    manifestUrl?: string | null;
    signal?: AbortSignal;
    isCurrent(): boolean | Promise<boolean>;
    onDownloadStarted?(): void;
    onProgress?(progress: unknown): void;
    onUpdateChecked?(status: Readonly<{ build: string | null; updateAvailable: boolean }>): void;
}>;

/** Web has no on-device model-pack installer. Never import native filesystem code into its graph. */
export async function invokeVoiceDeviceModelPackOperation(_input: VoiceDeviceModelPackOperationInput): Promise<SettingOperationResult> {
    return { status: 'unavailable', reason: 'device_model_packs_unsupported' };
}
