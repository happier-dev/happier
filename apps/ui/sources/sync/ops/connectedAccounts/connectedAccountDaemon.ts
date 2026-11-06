import { randomUUID } from '@/platform/randomUUID';
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
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { UiConnectedAccountAuthenticationModes } from './connectedAccountAuthenticationHost';

type MountedActionExecute = (actionId: ActionId, input: unknown,
    operation?: Readonly<{ signal?: AbortSignal; actionRequestId?: string }>) => Promise<ActionExecuteResult>;

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

/** The captured Account owns description and the registered portable-mode subset together. */
export async function describeConnectedAccountAuthenticationService(input: Readonly<{
    serverId: string;
    expectedAccountId: string;
    service: Extract<ConnectedAccountDaemonControlCommand, { operation: 'describeService' }>['service'];
    machineId?: string;
    expectedActiveServer?: ExpectedActiveServer;
    assertCurrent?: () => void;
    signal?: AbortSignal;
}>): Promise<Readonly<{
    description: ConnectedAccountDaemonControlResponse;
    accountAuthenticationModes: UiConnectedAccountAuthenticationModes;
}>> {
    const assertExpected = createExpectedActiveServerAssertion(input.expectedActiveServer, input.serverId);
    const assertCallerCurrent = () => {
        input.signal?.throwIfAborted();
        assertExpected?.();
        input.assertCurrent?.();
    };
    assertCallerCurrent();
    const [{ captureLazyActionAccountContext }, { createUiConnectedAccountAuthenticationHost }] = await Promise.all([
        import('@/sync/ops/actions/actionAccountContext'), import('./connectedAccountAuthenticationHost'),
    ]);
    assertCallerCurrent();
    const account = await captureLazyActionAccountContext(input.serverId, input.signal);
    try {
        if (account.accountId !== input.expectedAccountId) throw Object.assign(
            new Error('action_account_scope_changed'), { code: 'action_account_scope_changed' });
        const assertCurrent = () => { assertCallerCurrent(); account.assertCurrent(); };
        assertCurrent();
        const requestId = randomUUID();
        const result = await createUiConnectedAccountAuthenticationHost({ ...account, assertCurrent }, input.signal, requestId)
            .describeService(input.service, input.machineId);
        assertCurrent();
        // Correlation belongs to this UI invocation, outside the daemon response schema.
        const description = { ...result.description, requestId };
        return { ...result, description };
    } finally { account.dispose(); }
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
        requestId?: string;
    }>,
): Promise<ConnectedAccountAttemptResponse> {
    const quotaServerBasis = input.expectedActiveServer ?? getActiveServerSnapshot();
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
        ...(input.requestId ? { requestId: input.requestId } : {}),
    });
    const parsed = ConnectedAccountAttemptResponseSchema.parse(response);
    if (parsed.status === 'connected') {
        const { revalidateQualifiedQuotaSnapshotAfterCredentialChange } = await import('@/sync/domains/connectedServices/qualifiedConnectedAccountQuotaSnapshotStore');
        await revalidateQualifiedQuotaSnapshotAfterCredentialChange({ ref: parsed.account,
            serverBasis: input.serverId && input.serverId !== quotaServerBasis.serverId
                ? { ...quotaServerBasis, serverId: input.serverId } : quotaServerBasis,
            ...(input.accountId ? { accountId: input.accountId } : {}) });
    }
    return parsed;
}

/** UI ingress shares the admitted Actions; the transport above remains daemon-owned delivery. */
export async function runConnectedAccountAuthenticationAction(
    input: Omit<Parameters<typeof runConnectedAccountAuthenticationCommand>[0], 'serverId' | 'accountId' | 'machineId'>
        & Readonly<{ serverId: string; expectedAccountId: string; machineId?: string; executeAction?: MountedActionExecute }>,
): Promise<ConnectedAccountAttemptResponse & Readonly<{ requestId: string }>> {
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
    const actionId = CONNECTED_ACCOUNT_AUTHENTICATION_ACTION_ID_BY_OPERATION[operation];
    const actionInput = { ...operands,
        ...((operation === 'beginConnect' || operation === 'beginReconnect') && input.machineId ? { machineId: input.machineId } : {}) };
    const requestId = input.requestId ?? randomUUID();
    try {
        const result = input.executeAction
            ? await input.executeAction(actionId, actionInput, { signal: input.signal, actionRequestId: requestId })
            : await createDefaultActionExecutor().execute(actionId, actionInput, { surface: 'ui', authority: 'present_user', serverId: input.serverId,
                expectedAccountId: input.expectedAccountId, actionRequestId: requestId,
                ...(input.signal ? { signal: input.signal } : {}) });
        if (!result.ok) throw Object.assign(new Error(result.error), { code: result.errorCode });
        assertExpected?.();
        input.assertCurrent?.();
        // UI-local correlation is added after parsing the daemon/Action wire response.
        return { ...ConnectedAccountAttemptResponseSchema.parse(result.result), requestId };
    } catch (error) {
        if (error && typeof error === 'object') Object.assign(error, { requestId });
        throw error;
    }
}

export async function listPendingConnectedAccountAuthenticationActions(
    input: Readonly<{ serverId: string; machineId?: string; expectedAccountId: string;
        expectedActiveServer?: ExpectedActiveServer; assertCurrent?: () => void;
        service: Extract<ConnectedAccountDaemonControlCommand, { operation: 'listPendingAttempts' }>['service']; signal?: AbortSignal;
        executeAction?: MountedActionExecute }>,
): Promise<ConnectedAccountDaemonControlResponse & Readonly<{ requestId: string }>> {
    const assertExpected = createExpectedActiveServerAssertion(input.expectedActiveServer, input.serverId);
    input.signal?.throwIfAborted();
    assertExpected?.();
    input.assertCurrent?.();
    const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
    input.signal?.throwIfAborted();
    assertExpected?.();
    input.assertCurrent?.();
    const actionInput = { service: input.service, ...(input.machineId ? { machineId: input.machineId } : {}) };
    const requestId = randomUUID();
    try {
        const result = input.executeAction
            ? await input.executeAction('connectedServices.authentication.pending.list', actionInput, { signal: input.signal, actionRequestId: requestId })
            : await createDefaultActionExecutor().execute('connectedServices.authentication.pending.list', actionInput, { surface: 'ui', authority: 'present_user', serverId: input.serverId,
                expectedAccountId: input.expectedAccountId, actionRequestId: requestId, ...(input.signal ? { signal: input.signal } : {}) });
        if (!result.ok) throw Object.assign(new Error(result.error), { code: result.errorCode });
        assertExpected?.();
        input.assertCurrent?.();
        // Keep UI invocation metadata outside the strict daemon/Action response.
        return { ...ConnectedAccountDaemonControlResponseSchema.parse(result.result), requestId };
    } catch (error) {
        if (error && typeof error === 'object') Object.assign(error, { requestId });
        throw error;
    }
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
        requestId?: string;
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
    const requestId = input.requestId ?? randomUUID();
    try {
        const response = await machineRpcWithServerScope<
            unknown,
            typeof payload
        >({
            serverId: input.serverId,
            machineId: input.machineId,
            method: CONNECTED_ACCOUNT_CONTROL_COMMAND_RPC_METHOD,
            requestId,
            payload,
            ...(assertCurrent
                ? { onIssued: assertCurrent }
                : {}),
            ...(input.signal ? { signal: input.signal } : {}),
        });
        return ConnectedAccountDaemonControlResponseSchema.parse(response);
    } catch (error) {
        if (error && typeof error === 'object') Object.assign(error, { requestId });
        throw error;
    }
}
