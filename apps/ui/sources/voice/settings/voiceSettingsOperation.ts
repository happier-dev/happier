import type { SettingDeclaration } from '@/components/settings/catalog/settingDeclarations';

export type VoiceSettingsOperation =
    | 'stt_prepare' | 'stt_remove' | 'stt_update'
    | 'tts_prepare' | 'tts_remove' | 'tts_update' | 'tts_preview' | 'tts_test'
    | 'model_install' | 'model_remove' | 'model_default' | 'models_inspect' | 'readiness_inspect'
    | 'memory_forget'
    | 'diagnostics_enabled' | 'diagnostics_inspect' | 'diagnostics_export' | 'diagnostics_cleanup'
    | 'diagnostics_delete' | 'diagnostics_session_opt_out' | 'diagnostics_retry_shutdown';

/** Declaration-backed dispatch, not another Action catalog or mutation owner. */
export function voiceSettingsOperation(operation: VoiceSettingsOperation, purpose: 'conversation' | 'dictation' = 'conversation'): NonNullable<SettingDeclaration['operation']> {
    return {
        kind: 'invoke',
        requiresHumanInteraction: !['models_inspect', 'readiness_inspect', 'diagnostics_inspect', 'diagnostics_cleanup', 'diagnostics_retry_shutdown'].includes(operation),
        requiresApproval: !['models_inspect', 'readiness_inspect', 'diagnostics_inspect', 'diagnostics_cleanup', 'diagnostics_session_opt_out', 'diagnostics_retry_shutdown'].includes(operation),
        invoke: async (context) => {
            const { invokeVoiceSettingsOperation } = await import('./voiceSettingsOperationInvoker');
            return invokeVoiceSettingsOperation(operation, purpose, context);
        },
    };
}
