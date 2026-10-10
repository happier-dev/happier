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
} from '@happier-dev/protocol/connect/connectedAccountDaemonRpcV1';

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
        accountId?: string;
        expectedActiveServer?: ExpectedActiveServer;
        assertCurrent?: () => void;
        command: ConnectedAccountDaemonCommand;
        signal?: AbortSignal;
    }>,
): Promise<ConnectedAccountAttemptResponse> {
    const assertExpectedActiveServer =
        createExpectedActiveServerAssertion(
            input.expectedActiveServer,
            input.serverId,
        );
    const assertCurrent = input.assertCurrent || assertExpectedActiveServer
        ? () => { input.assertCurrent?.(); assertExpectedActiveServer?.(); }
        : undefined;
    assertCurrent?.();
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
        ...(input.accountId ? { accountId: input.accountId } : {}),
        method: CONNECTED_ACCOUNT_AUTHENTICATION_COMMAND_RPC_METHOD,
        payload,
        ...(assertCurrent
            ? { onIssued: assertCurrent }
            : {}),
        ...(input.signal ? { signal: input.signal } : {}),
    });
    return ConnectedAccountAttemptResponseSchema.parse(response);
}

/** UI ingress shares the admitted Actions; the transport above remains daemon-owned delivery. */
export async function runConnectedAccountAuthenticationAction(
    input: Omit<Parameters<typeof runConnectedAccountAuthenticationCommand>[0], 'serverId' | 'accountId'>
        & Readonly<{ serverId: string; expectedAccountId: string }>,
): Promise<ConnectedAccountAttemptResponse> {
    const assertExpected = createExpectedActiveServerAssertion(input.expectedActiveServer, input.serverId);
    input.signal?.throwIfAborted();
    assertExpected?.();
    input.assertCurrent?.();
    const [{ createDefaultActionExecutor }, { CONNECTED_ACCOUNT_AUTHENTICATION_ACTION_ID_BY_OPERATION }] = await Promise.all([
        import('@/sync/ops/actions/defaultActionExecutor'),
        import('@happier-dev/protocol/connect/configurationActionsV1'),
    ]);
    input.signal?.throwIfAborted();
    assertExpected?.();
    input.assertCurrent?.();
    const { operation, ...operands } = ConnectedAccountDaemonCommandSchema.parse(input.command);
    const result = await createDefaultActionExecutor().execute(CONNECTED_ACCOUNT_AUTHENTICATION_ACTION_ID_BY_OPERATION[operation],
        { machineId: input.machineId, ...operands }, { surface: 'ui', authority: 'present_user', serverId: input.serverId,
            expectedAccountId: input.expectedAccountId,
            ...(input.signal ? { signal: input.signal } : {}) });
    if (!result.ok) throw Object.assign(new Error(result.error), { code: result.errorCode });
    assertExpected?.();
    input.assertCurrent?.();
    return ConnectedAccountAttemptResponseSchema.parse(result.result);
}

export async function listPendingConnectedAccountAuthenticationActions(
    input: Readonly<{ serverId: string; machineId: string; expectedAccountId: string;
        expectedActiveServer?: ExpectedActiveServer; service: Extract<ConnectedAccountDaemonControlCommand, { operation: 'listPendingAttempts' }>['service']; signal?: AbortSignal }>,
): Promise<ConnectedAccountDaemonControlResponse> {
    const assertExpected = createExpectedActiveServerAssertion(input.expectedActiveServer, input.serverId);
    input.signal?.throwIfAborted();
    assertExpected?.();
    const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
    assertExpected?.();
    const result = await createDefaultActionExecutor().execute('connectedServices.authentication.pending.list',
        { machineId: input.machineId, service: input.service }, { surface: 'ui', authority: 'present_user', serverId: input.serverId,
            expectedAccountId: input.expectedAccountId, ...(input.signal ? { signal: input.signal } : {}) });
    if (!result.ok) throw Object.assign(new Error(result.error), { code: result.errorCode });
    assertExpected?.();
    return ConnectedAccountDaemonControlResponseSchema.parse(result.result);
}

export async function runConnectedAccountControlCommand(
    input: Readonly<{
        serverId: string | null;
        machineId: string;
        expectedActiveServer?: ExpectedActiveServer;
        /** Captured caller custody, checked at the incumbent transport's actual issuance point. */
        assertCurrent?: () => void;
        command: ConnectedAccountDaemonControlCommand;
        signal?: AbortSignal;
    }>,
): Promise<ConnectedAccountDaemonControlResponse> {
    const assertExpectedActiveServer =
        createExpectedActiveServerAssertion(
            input.expectedActiveServer,
            input.serverId,
        );
    const assertCurrent = input.assertCurrent || assertExpectedActiveServer
        ? () => { input.assertCurrent?.(); assertExpectedActiveServer?.(); }
        : undefined;
    assertCurrent?.();
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
        ...(assertCurrent
            ? { onIssued: assertCurrent }
            : {}),
        ...(input.signal ? { signal: input.signal } : {}),
    });
    return ConnectedAccountDaemonControlResponseSchema.parse(response);
}
