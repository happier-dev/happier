import { isRpcMethodNotAvailableError } from '@/sync/runtime/rpcErrors';

export function shouldRecoverUnavailableGlobalVoiceAutoMachine(error: unknown): boolean {
    const err: any = error;
    if (err?.code === 'VOICE_CONVERSATION_TARGET_MISSING') return true;
    if (err?.code === 'VOICE_AGENT_TARGET_MACHINE_OFFLINE') return true;
    if (isRpcMethodNotAvailableError(err)) return true;
    if (typeof err?.rpcErrorCode === 'string' && err.rpcErrorCode === 'VOICE_AGENT_UNSUPPORTED') return true;
    if (err?.code === 'VOICE_AGENT_RUNTIME_UNAVAILABLE') return true;
    return false;
}
