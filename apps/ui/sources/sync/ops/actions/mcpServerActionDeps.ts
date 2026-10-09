import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { createMcpServerActionExecuteV1, projectMcpServerActionFailureV1,
    MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/mcp/servers/serverActionsV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { readRpcRequestDisposition } from '@happier-dev/sync-client';
import { readMcpServerCatalogInContext, mutateMcpServerCatalogInContext } from '@/sync/api/account/apiMcpServerCatalog';
import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import { mergeAbortSignals } from '@/utils/runtime/abortSignals';
import type { LazyActionAccountContext } from './actionAccountContext';

/** Reuse the catalog and RPC owners within the Action host's captured Account lifetime. */
export function createUiMcpServerActionExecuteV1(account: LazyActionAccountContext): NonNullable<ActionExecutorDeps['mcpServerAction']> {
    return async request => {
        const { context } = request;
        const retired = new AbortController();
        const subscription = account.accountLifetime.onRetire(() => retired.abort());
        const cancellation = mergeAbortSignals([retired.signal, context.signal]);
        const assertCurrent = () => { account.assertCurrent(); cancellation.signal.throwIfAborted(); };
        try {
            assertCurrent();
            return await createMcpServerActionExecuteV1({
                readCatalog: async () => {
                    const snapshot = await readMcpServerCatalogInContext(account, cancellation.signal);
                    assertCurrent();
                    return snapshot;
                },
                mutate: (change, expectedRevision) => mutateMcpServerCatalogInContext(account,
                    { change, expectedRevision }, cancellation.signal),
                machine: async ({ actionId, input, machineId }) => {
                    assertCurrent();
                    let response: unknown;
                    try {
                        response = await machineRpcWithServerScope({ machineId, serverId: account.serverId,
                            accountId: account.accountId, preferScoped: true, requestId: context.actionRequestId,
                            method: actionId === 'mcp.servers.test' ? RPC_METHODS.DAEMON_MCP_SERVERS_TEST : RPC_METHODS.DAEMON_MCP_SERVERS_DETECT,
                            payload: input, authorization: context.rpcSessionAuthorization, signal: cancellation.signal,
                            operationTimeoutMs: null, onDispatched: assertCurrent });
                    } catch (cause) {
                        const refusal = projectMcpServerActionFailureV1(cause);
                        const disposition = readRpcRequestDisposition(cause);
                        if (actionId === 'mcp.servers.test' && (disposition === 'outcomeUnknown'
                            || refusal.errorCode === 'mcp_catalog_operation_failed')) {
                            throw Object.assign(new Error('MCP test disposition'), {
                                code: disposition === 'notSent' ? 'machine_unreachable' : 'outcome_unknown' });
                        }
                        throw cause;
                    }
                    const parsed = MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1[actionId].safeParse(response);
                    if (!parsed.success) throw Object.assign(new Error('Invalid MCP Machine receipt'), {
                        code: actionId === 'mcp.servers.test' ? 'outcome_unknown' : 'invalid_action_output' });
                    // The RPC owner retains consumed ACKs; only read disclosure
                    // depends on the invocation remaining current afterwards.
                    if (actionId === 'mcp.servers.probe') assertCurrent();
                    return parsed.data;
                },
            })(request);
        } catch (cause) { return projectMcpServerActionFailureV1(cause); }
        finally { subscription.dispose(); cancellation.dispose(); }
    };
}
