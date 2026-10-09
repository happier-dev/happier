import { describe, expect, it, vi } from 'vitest';
import { buildApprovalRequestArtifactHeaderV1, type ApprovalRequestV2 } from '@happier-dev/protocol';
import type { ActionOperationSnapshotV1 } from '@happier-dev/protocol/actions/operations/v1';
import type { ProjectServiceRelocateInputV1 } from '@happier-dev/protocol/workspaces/projectServiceRelocationV1';
import type { ActionApprovalRegistration } from '@/components/approvals/actionApprovalContinuation';
import { executeServiceRelocationAction } from './serviceRelocationAction';

const request: ProjectServiceRelocateInputV1 = {
  workspace: { serverId: 'home-1', refId: 'checkout' }, serviceName: 'web', requestId: 'move-1',
  currentTarget: { kind: 'managed_service', machineId: 'source', managedServiceId: 'instance' },
  destination: { kind: 'workers', destination: { kind: 'machine', machineId: 'worker' } },
};
const operation: ActionOperationSnapshotV1 = { version: 1, operationId: 'operation-1', revision: 1,
  actionId: 'projects.service.relocate', state: 'accepted', scope: { accountId: 'account-1', machineId: 'source' },
  requestId: request.requestId, title: 'Move web', createdAt: 1, cancellation: 'supported' };

describe('Service Move Action result custody', () => {
  it('registers an exact Artifact continuation and retains the accepted operation from its durable result without replay', async () => {
    let registration: ActionApprovalRegistration | null = null;
    // The already-admitted Action/RPC is a process boundary; approval parsing and continuation stay real.
    const execute = vi.fn(async () => ({ kind: 'approval_request_created', actionId: 'projects.service.relocate', artifactId: 'approval-1' }));
    const pending = executeServiceRelocationAction({ execute, request,
      context: { surface: 'ui', serverId: 'home-1' },
      admission: { expectedAccountId: 'account-1', onApprovalPending: value => { registration = value; } } });
    await vi.waitFor(() => expect(registration).toMatchObject({ artifactId: 'approval-1', onExecuted: expect.any(Function) }));
    if (!registration || typeof registration === 'string') throw new Error('expected exact result continuation');
    const approval: ApprovalRequestV2 = { v: 2, status: 'executed', createdAtMs: 1, updatedAtMs: 2,
      createdBy: { surface: 'system' }, requestedSurface: 'ui', actionId: 'projects.service.relocate', actionArgs: request,
      executionOriginV1: { v: 1, authority: 'present_user', surface: 'ui', caller: { kind: 'host' },
        serverId: 'home-1', accountId: 'account-1', actionId: 'projects.service.relocate', requestId: 'move-1' },
      summary: 'Move web', decision: { kind: 'approve', decidedAtMs: 2 },
      execution: { ok: true, executedAtMs: 2, result: { status: 'accepted', operation } } };
    await registration.onExecuted({ id: 'approval-1', title: null, header: buildApprovalRequestArtifactHeaderV1(approval),
      body: JSON.stringify(approval), headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 2, isDecrypted: true });
    expect(await pending).toEqual({ status: 'accepted', operation });
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
