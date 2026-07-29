import {
    CONNECTED_ACCOUNT_AUTHENTICATION_COMMAND_RPC_METHOD,
    CONNECTED_ACCOUNT_CONTROL_COMMAND_RPC_METHOD,
    ConnectedAccountAttemptResponseSchema,
    ConnectedAccountAuthenticationCommandRequestSchema,
    ConnectedAccountControlCommandRequestSchema,
    ConnectedAccountDaemonCommandSchema,
    ConnectedAccountDaemonControlCommandSchema,
    ConnectedAccountDaemonControlResponseSchema,
    type ConnectedAccountDaemonCommand,
} from '@happier-dev/protocol';

import type {
    ConnectedAccountDaemonRuntime,
} from '@/daemon/connectedServices/ConnectedAccountDaemonRuntime';

import type { RpcHandlerRegistrar } from '../rpc/types';

export {
    CONNECTED_ACCOUNT_AUTHENTICATION_COMMAND_RPC_METHOD,
    CONNECTED_ACCOUNT_CONTROL_COMMAND_RPC_METHOD,
    ConnectedAccountAttemptResponseSchema as ConnectedAccountAuthenticationCommandResponseSchema,
    ConnectedAccountAuthenticationCommandRequestSchema,
    ConnectedAccountControlCommandRequestSchema,
    ConnectedAccountDaemonCommandSchema,
    ConnectedAccountDaemonControlCommandSchema,
    ConnectedAccountDaemonControlResponseSchema,
};

function unavailable(
    code:
        | 'connected_account_daemon_owner_unavailable'
        | 'connected_account_daemon_runtime_unavailable',
    command?: ConnectedAccountDaemonCommand,
) {
    return Object.freeze({
        status: 'unavailable' as const,
        ...(
            command && 'attemptId' in command
                ? { attemptId: command.attemptId }
                : {}
        ),
        code,
    });
}

export function registerMachineConnectedAccountRpcHandlers(params: Readonly<{
    rpcHandlerManager: RpcHandlerRegistrar;
    machineId: string;
    getRuntime(): ConnectedAccountDaemonRuntime | null;
}>): void {
    params.rpcHandlerManager.registerHandler(
        CONNECTED_ACCOUNT_AUTHENTICATION_COMMAND_RPC_METHOD,
        async (raw, context) => {
            const request =
                ConnectedAccountAuthenticationCommandRequestSchema.parse(raw);
            if (request.machineId !== params.machineId) {
                return unavailable(
                    'connected_account_daemon_owner_unavailable',
                    request.command,
                );
            }
            const runtime = params.getRuntime();
            if (!runtime) {
                return unavailable(
                    'connected_account_daemon_runtime_unavailable',
                    request.command,
                );
            }
            try {
                const result = await runtime.execute(request.command, {
                    signal: context?.signal,
                });
                const parsed =
                    ConnectedAccountAttemptResponseSchema.safeParse(result);
                return parsed.success
                    ? parsed.data
                    : unavailable(
                        'connected_account_daemon_runtime_unavailable',
                        request.command,
                    );
            } catch (error) {
                if (
                    error
                    && typeof error === 'object'
                    && 'code' in error
                    && error.code ===
                        'connected_account_attempt_cleanup_pending'
                    && 'attemptId' in error
                    && typeof error.attemptId === 'string'
                ) {
                    return {
                        status: 'cleanupPending' as const,
                        attemptId: error.attemptId,
                        code:
                            'connected_account_attempt_cleanup_pending' as const,
                    };
                }
                return unavailable(
                    'connected_account_daemon_runtime_unavailable',
                    request.command,
                );
            }
        },
    );
    params.rpcHandlerManager.registerHandler(
        CONNECTED_ACCOUNT_CONTROL_COMMAND_RPC_METHOD,
        async (raw, context) => {
            const request =
                ConnectedAccountControlCommandRequestSchema.parse(raw);
            if (request.machineId !== params.machineId) {
                return {
                    status: 'unavailable' as const,
                    code: 'connected_account_daemon_owner_unavailable',
                };
            }
            const runtime = params.getRuntime();
            if (!runtime) {
                return {
                    status: 'unavailable' as const,
                    code: 'connected_account_daemon_runtime_unavailable',
                };
            }
            try {
                const result = await runtime.control(request.command, {
                    signal: context?.signal,
                });
                const parsed =
                    ConnectedAccountDaemonControlResponseSchema.safeParse(
                        result,
                    );
                return parsed.success
                    ? parsed.data
                    : {
                        status: 'unavailable' as const,
                        code: 'connected_account_daemon_response_invalid',
                    };
            } catch {
                return {
                    status: 'unavailable' as const,
                    code: 'connected_account_daemon_runtime_unavailable',
                };
            }
        },
    );
}
