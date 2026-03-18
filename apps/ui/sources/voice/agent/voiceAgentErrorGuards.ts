import { isRpcMethodNotAvailableError, type RpcErrorCarrier } from '@/sync/runtime/rpcErrors';

export function isVoiceAgentBusyError(error: unknown): boolean {
    const err: any = error;
    if (typeof err?.rpcErrorCode === 'string' && (err.rpcErrorCode === 'VOICE_AGENT_BUSY' || err.rpcErrorCode === 'execution_run_busy')) {
        return true;
    }
    if (typeof err?.message === 'string') {
        return (
            err.message.includes('VOICE_AGENT_BUSY')
            || err.message.includes('execution_run_busy')
            || err.message.includes('Voice agent busy')
        );
    }
    return false;
}

export function isVoiceAgentNotFoundError(error: unknown): boolean {
    const err: any = error;
    if (
        typeof err?.rpcErrorCode === 'string'
        && (
            err.rpcErrorCode === 'VOICE_AGENT_NOT_FOUND'
            || err.rpcErrorCode === 'execution_run_not_found'
            || err.rpcErrorCode === 'execution_run_stream_not_found'
        )
    ) {
        return true;
    }
    if (typeof err?.message === 'string') {
        return (
            err.message.includes('VOICE_AGENT_NOT_FOUND')
            || err.message.includes('Voice agent not found')
            || err.message.includes('execution_run_not_found')
            || err.message.includes('execution_run_stream_not_found')
        );
    }
    return false;
}

export function isVoiceAgentRpcMethodUnavailable(error: unknown): error is RpcErrorCarrier {
    return typeof error === 'object' && error !== null && isRpcMethodNotAvailableError(error as RpcErrorCarrier);
}
