import * as React from 'react';

import { awaitActionApprovalResult } from '@/components/approvals/actionApprovalContinuation';
import { useActionApprovalContinuation } from '@/components/approvals/useActionApprovalContinuation';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';

import { createManagedProvisionerClient } from './managedProvisionerClient';
import { readManagedLaunchName } from '@/components/approvals/approvalReferenceReading';
import { useManagedWorkspaceControlTarget } from './useManagedWorkspaceStart';

export type ManagedWorkspaceForgetOutcome = 'forgotten' | 'failed';

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
      if (inFlight.current || !binding.isCurrent()) return 'failed';
      inFlight.current = true;
      const request = new AbortController();
      const retirement = binding.onRetire(() => request.abort());
      type Settled = Readonly<{ outcome: ManagedWorkspaceForgetOutcome }>;
      const settle = (outcome: ManagedWorkspaceForgetOutcome) => (): Settled => ({ outcome });
      try {
        const client = createManagedProvisionerClient(binding.scope, attached.homeId);
        const settled = await awaitActionApprovalResult<unknown, Settled>({
          signal: request.signal,
          succeeded: settle('forgotten'),
          failed: settle('failed'),
          aborted: settle('failed'),
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
            return { outcome: result.kind === 'succeeded' ? 'forgotten' : 'failed' };
          },
        });
        return settled.outcome;
      } finally {
        retirement.dispose();
        inFlight.current = false;
      }
    },
  };
}
