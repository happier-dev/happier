import {
    CONNECTED_ACCOUNT_AUTHENTICATION_COMMAND_RPC_METHOD,
    CONNECTED_ACCOUNT_CONTROL_COMMAND_RPC_METHOD,
    ConnectedAccountAttemptResponseSchema,
    ConnectedAccountAuthenticationCommandRequestSchema,
    ConnectedAccountConfigurationTargetSchema,
    ConnectedAccountControlCommandRequestSchema,
    ConnectedAccountControlTargetSchema,
    ConnectedAccountDaemonCommandSchema,
    ConnectedAccountDaemonControlCommandSchema,
    ConnectedAccountDaemonControlResponseSchema,
    type ConnectedAccountAttemptResponse,
    type ConnectedAccountConfigurationTarget,
    type ConnectedAccountControlTarget,
    type ConnectedAccountDaemonCommand,
    type ConnectedAccountDaemonControlCommand,
    type ConnectedAccountDaemonControlResponse,
} from '@happier-dev/protocol';

import {
    machineRpcWithServerScope,
} from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import {
    getActiveServerSnapshot,
    type ActiveServerSnapshot,
} from '@/sync/domains/server/serverRuntime';

export {
    CONNECTED_ACCOUNT_AUTHENTICATION_COMMAND_RPC_METHOD,
    CONNECTED_ACCOUNT_CONTROL_COMMAND_RPC_METHOD,
    ConnectedAccountAttemptResponseSchema,
    ConnectedAccountConfigurationTargetSchema,
    ConnectedAccountControlTargetSchema,
    ConnectedAccountDaemonCommandSchema,
    ConnectedAccountDaemonControlCommandSchema,
    ConnectedAccountDaemonControlResponseSchema,
};
export type {
    ConnectedAccountAttemptResponse,
    ConnectedAccountConfigurationTarget,
    ConnectedAccountControlTarget,
    ConnectedAccountDaemonCommand,
    ConnectedAccountDaemonControlCommand,
    ConnectedAccountDaemonControlResponse,
};

type ExpectedActiveServer = Pick<
    ActiveServerSnapshot,
    'serverId' | 'generation'
>;

function createExpectedActiveServerAssertion(
    expected: ExpectedActiveServer | undefined,
    routedServerId: string | null,
): (() => void) | undefined {
    if (!expected) return undefined;
    return () => {
        const active = getActiveServerSnapshot();
        if (
            routedServerId !== expected.serverId
            || active.serverId !== expected.serverId
            || active.generation !== expected.generation
        ) {
            throw Object.assign(
                new Error('Connected-account server basis is stale'),
                { code: 'STALE_SERVER_GENERATION' },
            );
        }
    };
}

export async function runConnectedAccountAuthenticationCommand(
    input: Readonly<{
        serverId: string | null;
        machineId: string;
        expectedActiveServer?: ExpectedActiveServer;
        command: ConnectedAccountDaemonCommand;
        signal?: AbortSignal;
    }>,
): Promise<ConnectedAccountAttemptResponse> {
    const assertExpectedActiveServer =
        createExpectedActiveServerAssertion(
            input.expectedActiveServer,
            input.serverId,
        );
    assertExpectedActiveServer?.();
    const payload =
        ConnectedAccountAuthenticationCommandRequestSchema.parse({
            v: 1,
            machineId: input.machineId,
            command: input.command,
        });
    const response = await machineRpcWithServerScope<
        unknown,
        typeof payload
    >({
        serverId: input.serverId,
        machineId: input.machineId,
        method: CONNECTED_ACCOUNT_AUTHENTICATION_COMMAND_RPC_METHOD,
        payload,
        ...(assertExpectedActiveServer
            ? { onIssued: assertExpectedActiveServer }
            : {}),
        ...(input.signal ? { signal: input.signal } : {}),
    });
    return ConnectedAccountAttemptResponseSchema.parse(response);
}

export async function runConnectedAccountControlCommand(
    input: Readonly<{
        serverId: string | null;
        machineId: string;
        expectedActiveServer?: ExpectedActiveServer;
        command: ConnectedAccountDaemonControlCommand;
        signal?: AbortSignal;
    }>,
): Promise<ConnectedAccountDaemonControlResponse> {
    const assertExpectedActiveServer =
        createExpectedActiveServerAssertion(
            input.expectedActiveServer,
            input.serverId,
        );
    assertExpectedActiveServer?.();
    const payload = ConnectedAccountControlCommandRequestSchema.parse({
        v: 1,
        machineId: input.machineId,
        command: input.command,
    });
    const response = await machineRpcWithServerScope<
        unknown,
        typeof payload
    >({
        serverId: input.serverId,
        machineId: input.machineId,
        method: CONNECTED_ACCOUNT_CONTROL_COMMAND_RPC_METHOD,
        payload,
        ...(assertExpectedActiveServer
            ? { onIssued: assertExpectedActiveServer }
            : {}),
        ...(input.signal ? { signal: input.signal } : {}),
    });
    return ConnectedAccountDaemonControlResponseSchema.parse(response);
}
