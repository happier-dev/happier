import type { SettingDeclaration } from '@/components/settings/catalog/settingDeclarations';
import { readBuiltInSettingsOperationPolicyV1 } from '@happier-dev/protocol/actions/settings/settingsDeclarations';

export type VoiceSettingsOperation =
    | 'stt_prepare' | 'stt_remove' | 'stt_update' | 'stt_cancel'
    | 'tts_prepare' | 'tts_remove' | 'tts_update' | 'tts_cancel' | 'tts_preview' | 'tts_preview_stop' | 'tts_test' | 'tts_catalog' | 'tts_catalog_retry'
    | 'model_install' | 'model_remove' | 'model_default' | 'model_cancel' | 'models_inspect' | 'readiness_inspect'
    | 'memory_forget' | 'privacy_policy_open' | 'history_inspect'
    | 'diagnostics_enabled' | 'diagnostics_inspect' | 'diagnostics_export' | 'diagnostics_cleanup'
    | 'diagnostics_delete' | 'diagnostics_session_opt_out' | 'diagnostics_retry_shutdown';

/** Declaration-backed dispatch, not another Action catalog or mutation owner. */
export function voiceSettingsOperation(operation: VoiceSettingsOperation, purpose: 'conversation' | 'dictation' = 'conversation'): NonNullable<SettingDeclaration['operation']> {
    const policy = readBuiltInSettingsOperationPolicyV1('voiceSettingsOperation', [operation, purpose]);
    if (policy?.kind !== 'invoke') throw new Error(`Undeclared Voice settings operation: ${operation}`);
    return {
        ...policy,
        kind: 'invoke',
        invoke: async (context) => {
            const { invokeVoiceSettingsOperation } = await import('./voiceSettingsOperationInvoker');
            return invokeVoiceSettingsOperation(operation, purpose, context);
        },
    };
}
