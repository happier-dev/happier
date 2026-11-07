import { WorkspaceSyncAdmissionV1Schema, deriveWorkspaceSyncRelationshipId,
    type WorkspaceSyncAdmissionInputV1, type ExternalActionExecutionAuthorizationBindingV1,
    type WorkspaceSyncAdmissionV1 } from '@happier-dev/protocol/actions/externalActionApi';
import type { ActionRequiredAuthority } from '@happier-dev/protocol/actions/metadata';
import { isProjectWorkspaceSyncOpenActionV1, isProjectWorkspaceSyncPreparationActionV1 } from '@happier-dev/protocol/actions/projectActionIdsV1';
import { isApiTokenGrantTargetMemberV1 } from '@happier-dev/protocol/auth/apiTokenGrant';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { resolveMachineAdmissionInTx } from '@/app/machines/machineAccess';
import { readMachineDevcontainerChildInTx, readMachineDevcontainerWorkspaceSyncEndpointInTx } from '@/app/machines/managed/managedRows';
import type { Tx } from '@/storage/inTx';

/** One Home producer: source admission is carried by the existing signed Action root. */
export async function readWorkspaceSyncAdmissionInTx(tx: Tx, input: Readonly<{
    binding: ExternalActionExecutionAuthorizationBindingV1;
    request: WorkspaceSyncAdmissionInputV1;
    callerAuthority: ActionRequiredAuthority;
}>): Promise<WorkspaceSyncAdmissionV1 | null> {
    const { binding, request } = input;
    if (!isProjectWorkspaceSyncOpenActionV1(binding.actionId) && !isProjectWorkspaceSyncPreparationActionV1(binding.actionId)) return null;
    if ('grant' in binding && !isApiTokenGrantTargetMemberV1(binding.grant,
        { kind: 'machine', machineId: request.sourceMachineId })) return null;
    const operation = { actorAccountId: binding.accountId, callerAuthority: input.callerAuthority,
        sessionActionOrigin: binding.sessionActionOrigin,
        rpcMethod: RPC_METHODS.DAEMON_WORKSPACE_SYNC_HANDOFF_SOURCE_PHASE };
    const admitted = await resolveMachineAdmissionInTx(tx, { actorAccountId: binding.accountId,
        callerAuthority: input.callerAuthority, sessionActionOrigin: binding.sessionActionOrigin, machineId: request.sourceMachineId,
        operationRpcMethod: operation.rpcMethod, requiredRole: 'use' });
    if (admitted.kind !== 'admitted') return null;
    const { kind: _kind, ...source } = admitted;
    const projection = await readMachineDevcontainerChildInTx(tx, source.machineId);
    const endpoint = await readMachineDevcontainerWorkspaceSyncEndpointInTx(tx, {
        accountServerId: binding.serverIdentityId, machineId: source.machineId,
        rootPath: projection?.observation.workspaceFolder ?? '', operation });
    if (!endpoint) return null;
    let child: WorkspaceSyncAdmissionV1['child'];
    if (projection) {
        child = { projection, controller: { machineId: projection.relation.parentMachineId,
            installationId: endpoint.machineId === source.machineId
                ? (await tx.machine.findUnique({ where: { id: projection.relation.parentMachineId },
                    select: { installationId: true } }))?.installationId ?? '' : endpoint.installationId } };
        if (!child.controller.installationId) return null;
    }
    return WorkspaceSyncAdmissionV1Schema.parse({
        relationshipId: request.relationshipId ?? deriveWorkspaceSyncRelationshipId(binding.requestId),
        sourceWorkspaceRefId: request.sourceWorkspaceRefId, source, ...(child ? { child } : {}),
    });
}
