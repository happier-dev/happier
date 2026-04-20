import { createVoiceExecutionTransport, type VoiceExecutionTransport } from '@/voice/runtime/execution/VoiceExecutionTransport';

export type VoiceAgentSessionController = VoiceExecutionTransport;

export function createVoiceAgentSessionController(): VoiceAgentSessionController {
    return createVoiceExecutionTransport();
}
