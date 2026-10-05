import type { SettingOperationResult } from '@/components/settings/catalog/settingDeclarations';

/** Web has no on-device model-pack installer. Never import native filesystem code into its graph. */
export async function invokeVoiceDeviceModelPackOperation(_input: Readonly<{
    operation: 'prepare' | 'remove' | 'update';
    packId: string;
    role: 'stt_sherpa' | 'tts_sherpa';
    networkTimeoutMs: number;
    signal?: AbortSignal;
    isCurrent(): boolean | Promise<boolean>;
}>): Promise<SettingOperationResult> {
    return { status: 'unavailable', reason: 'device_model_packs_unsupported' };
}
