import { describe, expect, it } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { computeWorkspaceSyncPolicyDigest } from '@happier-dev/protocol';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { readMachineActionRpcResult } from '@happier-dev/protocol/actions/executor/actionFailureEnvelope';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { registerMachineWorkspaceSyncRpcHandlers } from './rpcHandlers.workspaceSync';
import { authorizeMachineRpcRequest, type MachineRpcAdmissionBoundary } from './machineRpcAuthorization';

const contentPolicy = { v: 1 as const, selection: 'all_files' as const,
    extraIgnorePatterns: [], extraIncludePatterns: [] };
const actionInput = { v: 1 as const, sourceWorkspaceRefId: 'source', targetMachineId: 'worker',
    targetPath: '/worker-copy', mode: 'keep_synced' as const, destinationIntent: 'materialize_from_source_workspace' as const,
    purpose: 'worker_clean_copy' as const,
    contentPolicy: { ...contentPolicy, policyDigest: computeWorkspaceSyncPolicyDigest(contentPolicy) } };
const admission = { actorAccountId: 'owner', custodianAccountId: 'owner', machineId: 'controller',
    installationId: 'installation', role: 'manage' as const, encryptionMode: 'plain' as const };
const caller = { kind: 'session' as const, sessionId: 'requester', starterDepth: 0, turnDepth: 0 };
const request = { method: `controller:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_RELATIONSHIP_CREATE}`,
    params: { v: 1, operationId: 'link', actionInput }, machineAdmission: admission,
    callerAuthority: 'account_automation' as const, localActionContext: { actionCaller: caller } };

function boundary(current = true): MachineRpcAdmissionBoundary {
    return { machineId: 'controller', resolveInstallationId: () => 'installation',
        resolveCustodianAccountId: async () => 'owner',
        // Home verification is the external admission boundary; requester classification stays real.
        verifyMachineAdmission: async () => current };
}

describe('worker link requester admission', () => {
    it.each(['socket'] as const)('reports %s admission refusal as no effect at the Action boundary', async ingress => {
        const rpc = new RpcHandlerManager({ scopePrefix: 'controller', localMachineId: 'controller',
            encryptionMode: 'plain', logger: () => {},
            authorizeRequest: incoming => authorizeMachineRpcRequest(incoming, boundary(false)) });
        // Production registration stays real. No workspace runtime is installed:
        // denial must settle before its typed runtime-unavailable handler can run.
        registerMachineWorkspaceSyncRpcHandlers({ rpcHandlerManager: rpc });
        const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), isActionApprovalRequired: () => false,
            sessionHandoffTargetReplacementApprovalPreflight: async () => ({ type: 'not_required' }),
            workspaceSyncRelationshipCreate: async () => readMachineActionRpcResult(await (ingress === 'socket' ? rpc.handleRequest(request)
                : rpc.invokeLocal(RPC_METHODS.DAEMON_WORKSPACE_SYNC_RELATIONSHIP_CREATE, request.params,
                    { rpcContext: request, localActionContext: request.localActionContext }))) });
        expect(await executor.execute('workspace.sync.relationship.create', actionInput,
            { surface: 'mcp', authority: 'account_automation', actionCaller: caller, actionRequestId: 'link' }))
            .toMatchObject({ ok: false, errorCode: 'RPC_FORBIDDEN', effectAttempted: false });
    });
});
