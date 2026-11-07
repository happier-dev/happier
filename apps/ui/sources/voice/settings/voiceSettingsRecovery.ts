import { fireAndForget } from '@/utils/system/fireAndForget';
import type { VoiceRoleReadiness } from '@/voice/registry/readiness';
import { recoverVoiceExecutionMachine } from '@/voice/runtime/execution/recoverVoiceExecutionMachine';

/** Retry refreshes Home facts and reaches the selected Machine through scoped RPC. */
export function recoverVoiceSettingsReadiness(
    action: VoiceRoleReadiness['recoveryAction'],
    onRecoveryAction?: (action: VoiceRoleReadiness['recoveryAction']) => void,
): void {
    if (action === 'retry') {
        fireAndForget(recoverVoiceExecutionMachine(), { tag: 'Voice.settings.retryMachinePresence' });
        return;
    }
    onRecoveryAction?.(action);
}
