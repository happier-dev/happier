import * as React from 'react';
import { projectActionFailureCauseV1, readActionErrorCodeV1 } from '@happier-dev/protocol/actions/actionExecutionResult';

import { awaitActionApprovalResult } from '@/components/approvals/actionApprovalContinuation';
import { useActionApprovalContinuation } from '@/components/approvals/useActionApprovalContinuation';
import { readServerAccountScopeOwnerLifetime } from '@/sync/domains/scope/serverAccountScope';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';

import { createManagedProvisionerClient, projectManagedProvisionerFailure, type ManagedProvisionerFailure } from './managedProvisionerClient';
import { readManagedLaunchName } from '@/components/approvals/approvalReferenceReading';
import { useManagedWorkspaceControlTarget } from './useManagedWorkspaceStart';

export type ManagedWorkspaceForgetOutcome = { kind: 'forgotten' } | ManagedProvisionerFailure | { kind: 'ignored' };

/**
 * Forget an attached workspace from its Project page (remote workspaces F9, lab `project-forget`): the same
 * `machines.managed.retire` admission Settings uses, with manual responsibility, so the remote workspace and its files
 * are never touched. Offered only for an attached resource (Happier did not create it, so it is never Deleted here);
 * the page shows its own confirmation, which this request carries.
 */
export function useManagedWorkspaceForget(scope: WorkspaceScopeBase): Readonly<{
  workspaceName: string;
  forget(): Promise<ManagedWorkspaceForgetOutcome>;
}> | null {
  const { serverId } = scope;
  const { target, binding, profileId } =
    useManagedWorkspaceControlTarget(scope);
  const attached = target?.workspaceAttachment ? target : null;
  const scopeKey = JSON.stringify([
    profileId,
    binding?.accountId,
    attached?.homeId,
    attached?.id,
    attached?.intentRevision,
  ]);
  const approval = useActionApprovalContinuation({
    serverId,
    scopeKey,
    onExecuted() {},
  });
  const workspaceName = readManagedLaunchName(attached ?? undefined);
  const inFlight = React.useRef(false);
  if (!attached || !binding || !workspaceName) return null;
  return {
    workspaceName,
    async forget() {
      if (inFlight.current) return { kind: 'ignored' };
      if (!binding.isCurrent()) return { kind: 'failed', code: 'action_account_scope_changed' };
      inFlight.current = true;
      const request = new AbortController();
      // Removing the current Project can unmount this reader before the Account mutation acknowledges.
      const retirement = readServerAccountScopeOwnerLifetime(binding).onRetire(() => request.abort());
      try {
        const client = createManagedProvisionerClient(binding.scope, attached.homeId);
        return await awaitActionApprovalResult<unknown, ManagedWorkspaceForgetOutcome>({
          signal: request.signal,
          succeeded: () => ({ kind: 'forgotten' }),
          failed: (code, failure) => projectManagedProvisionerFailure(code, failure?.details, failure?.requestId, failure?.failureCause),
          aborted: () => ({ kind: 'failed', code: 'action_account_scope_changed' }),
          execute: async (callbacks) => {
            const result = await client.execute(
              'machines.managed.retire',
              {
                homeId: attached.homeId,
                managedId: attached.id,
                expectedIntentRevision: attached.intentRevision,
                manualResponsibility: true,
              },
              { ...callbacks, confirmed: true, onApprovalPending: approval.requestApproval },
            );
            if (result.kind === 'approval_pending') return { approvalPending: true as const };
            if (result.kind === 'admitted') return { kind: 'failed', code: 'invalid_action_output' };
            return result.kind === 'succeeded' ? { kind: 'forgotten' } : result;
          },
        });
      } catch (error) {
        return projectManagedProvisionerFailure(readActionErrorCodeV1(error) ?? 'managed_request_failed',
          undefined, undefined, projectActionFailureCauseV1(error));
      } finally {
        retirement.dispose();
        inFlight.current = false;
      }
    },
  };
}
