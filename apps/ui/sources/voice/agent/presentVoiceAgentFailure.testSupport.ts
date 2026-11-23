import { projectVoiceAttemptPresentation } from '@/components/voice/attempt/projectVoiceAttemptPresentation';
import { resolveVoiceAttemptControl } from '@/components/voice/attempt/resolveVoiceAttemptControl';
import { deriveLocalVoiceSessionSnapshot } from '@/voice/runtime/machine/deriveLocalVoiceSessionSnapshot';
import { voiceConversationRuntimeMachine } from '@/voice/runtime/machine/VoiceConversationRuntimeMachine';
import { classifyVoiceMachineError } from '@/voice/runtime/machine/voiceMachineError';

export function presentVoiceAgentFailure(error: unknown) {
    const machine = voiceConversationRuntimeMachine;
    machine.reset();
    machine.transitionToDisconnected({ controlSessionId: 's1', error: classifyVoiceMachineError(error) });
    const snapshot = deriveLocalVoiceSessionSnapshot('local_conversation', 'local', machine.getSnapshot());
    machine.reset();
    return projectVoiceAttemptPresentation({
        ...snapshot,
        control: resolveVoiceAttemptControl({ status: snapshot.status, sessionId: 's1', surfaceState: 'error',
            tone: 'error', canStop: false, muted: false, capturing: false, startAdmitted: false,
            hasRecovery: snapshot.errorRecoveryAction !== 'none' }),
        attemptId: 'attempt', ended: false, recoveryAction: snapshot.errorRecoveryAction ?? null,
        recoveryContext: { providerError: snapshot.errorProviderError, connectRecoveryTarget: { kind: 'default' },
            runtimeRecoveryTarget: null, attemptSessionId: 's1', startSessionId: 's1', globalStartAuthorized: false },
        serviceTitle: 'Voice', agentTitle: 'Codex', agentMachineLabel: 'Dev machine',
    });
}
