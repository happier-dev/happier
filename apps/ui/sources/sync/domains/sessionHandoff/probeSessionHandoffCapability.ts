import { readSessionHandoffError, SessionHandoffCapabilityV2Schema, type SessionHandoffCapabilityV2 } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import { createRpcCallError, isRpcMethodNotFoundError, readRpcErrorCode } from '@/sync/runtime/rpcErrors';
import { t } from '@/text';

import { resolveSessionHandoffRuntimeConfig } from './sessionHandoffRuntimeConfig';

export type SessionHandoffCapabilityProbeResult =
    | Readonly<{ status: 'supported'; capability: SessionHandoffCapabilityV2 }>
    | Readonly<{ status: 'unsupported' }>
    | Readonly<{ status: 'error'; errorCode: string; errorMessage: string }>;

function probeFailure(error: unknown): SessionHandoffCapabilityProbeResult {
    if (isRpcMethodNotFoundError(error)) return { status: 'unsupported' };
    return {
        status: 'error',
        errorCode: readRpcErrorCode(error) ?? 'UNEXPECTED',
        errorMessage: error instanceof Error ? error.message : t('errors.machineRpcContextUnavailable'),
    };
}

/** One capability read and parser for picker availability and pre-mutation admission. */
export async function probeSessionHandoffCapability(input: Readonly<{
    machineId: string;
    serverId?: string | null;
    preferScoped?: boolean;
}>): Promise<SessionHandoffCapabilityProbeResult> {
    try {
        const raw = await machineRpcWithServerScope<unknown, Record<string, never>>({
            ...input,
            method: RPC_METHODS.DAEMON_SESSION_HANDOFF_CAPABILITY_V2_GET,
            payload: {},
            timeoutMs: resolveSessionHandoffRuntimeConfig().machineRpcPollTimeoutMs,
        });
        const failure = readSessionHandoffError(raw);
        if (failure) {
            const { errorCode, errorMessage } = failure;
            return probeFailure(createRpcCallError({
                error: errorCode === 'rpc_params_decryption_failed' || errorCode === 'machine_rpc_decryption_failed'
                    ? t('errors.machineRpcDecryptionFailed')
                    : errorMessage,
                errorCode,
            }));
        }
        const capability = SessionHandoffCapabilityV2Schema.safeParse(raw);
        return capability.success ? { status: 'supported', capability: capability.data } : { status: 'unsupported' };
    } catch (error) {
        return probeFailure(error);
    }
}
