import { randomBytes as nodeRandomBytes } from 'node:crypto';
import { createWorkflowAccountRunActionOwner } from '@happier-dev/protocol/actions/executor/workflowRunActions';
import type { WorkflowAccountRunActionDeps } from '@happier-dev/protocol';

import { resolveCanonicalAbsolutePath } from '@/utils/path/expandHomeDirPath';
import { selectHostRequesterExecutionIdentity } from '@/daemon/agentIsolation/agentIsolationLaunchPolicy';
import type { WorkflowApprovedOperationNativeAccountV1 } from '@happier-dev/protocol/actions/executor/workflowRunActions';
import { readRepositoryWorkflow } from './repositoryWorkflow';

/** CLI path and randomness effects for the shared admission owner. */
export function createWorkflowRunActionOwner(deps: Omit<WorkflowAccountRunActionDeps,
  'normalizeAbsolutePath' | 'randomBytes'> & Readonly<{
    randomBytes?: (length: number) => Uint8Array;
    nativeAccount?: WorkflowApprovedOperationNativeAccountV1;
    serverIdentityId?: string;
    hostExecutionTarget?: Readonly<{ machineId: string; installationId: string }>;
  }>) {
  const { nativeAccount, serverIdentityId, hostExecutionTarget, ...ownerDeps } = deps;
  return createWorkflowAccountRunActionOwner({
    ...ownerDeps,
    resolveLocalAuthenticatedStarter: async context => {
      if (!nativeAccount || !serverIdentityId || !hostExecutionTarget
        || context.externalActionExecutionAuthorization
        || context.serverId !== nativeAccount.serverId || context.runtimeAccountId !== nativeAccount.accountId) return undefined;
      const identity = selectHostRequesterExecutionIdentity({ actionContext: context,
        hostHomeServerIdentityId: serverIdentityId, hostCustodianAccountId: nativeAccount.accountId,
        hostExecutionTarget });
      if (identity.kind !== 'owner_person' || !await nativeAccount.isCurrent()) return undefined;
      const requestRef = context.actionRequestId?.trim();
      return requestRef ? { requestRef, requester: {
        serverId: identity.requester.serverId, accountId: identity.requester.accountId,
      } } : undefined;
    },
    readRepositoryWorkflow: deps.readRepositoryWorkflow ?? readRepositoryWorkflow,
    randomBytes: deps.randomBytes ?? ((length) => nodeRandomBytes(length)),
    normalizeAbsolutePath: (directory) => resolveCanonicalAbsolutePath(directory)?.path ?? null,
  });
}
