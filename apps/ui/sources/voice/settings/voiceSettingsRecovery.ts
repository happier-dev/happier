import { fireAndForget } from '@/utils/system/fireAndForget';
import type { VoiceRoleReadiness } from '@/voice/registry/readiness';
import { recoverVoiceExecutionMachine } from '@/voice/runtime/execution/recoverVoiceExecutionMachine';
import { executeVoiceAttemptRecovery } from '@/components/voice/attempt/voiceAttemptRecovery';

/** Retry refreshes Home facts and reaches the selected Machine through scoped RPC. */
export function recoverVoiceSettingsReadiness(
    action: VoiceRoleReadiness['recoveryAction'],
    onRecoveryAction?: (action: VoiceRoleReadiness['recoveryAction']) => void,
    agentRecovery?: Readonly<{ selectedAgent?: VoiceRoleReadiness['selectedAgent']; navigate: (href: unknown) => void | Promise<void> }>,
): void {
    if (action === 'open_provider_settings' && agentRecovery?.selectedAgent?.runtimeTarget) {
        fireAndForget(executeVoiceAttemptRecovery({ recoveryAction: 'connect_agent', setupIncomplete: false,
            context: { connectRecoveryTarget: { kind: 'default' }, runtimeRecoveryTarget: agentRecovery.selectedAgent.runtimeTarget,
                attemptSessionId: null, startSessionId: null, globalStartAuthorized: false }, navigate: agentRecovery.navigate,
        }), { tag: 'Voice.settings.agentRecovery' });
        return;
    }
    if (action === 'retry') {
        fireAndForget(recoverVoiceExecutionMachine(), { tag: 'Voice.settings.retryMachinePresence' });
        return;
    }
    onRecoveryAction?.(action);
}
