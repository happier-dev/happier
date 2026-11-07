import { SessionPendingEditResultV1Schema, type SessionPendingEditInputV1, type SessionPendingEditResultV1 } from '@happier-dev/protocol/actions/actionSpecs';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { UiActionExecutorContext } from '@/sync/ops/actions/defaultActionExecutor';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import type { ActionApprovalContinuation } from '@/components/approvals/actionApprovalContinuation';

/** The mounted editor retains its document until canonical Action admission and any approval settle. */
export async function executePendingMessageEditWithActionApproval(params: Readonly<{
  input: SessionPendingEditInputV1;
  context: UiActionExecutorContext;
  scope: ServerAccountScope;
  isCurrent(): boolean;
  registerApproval(continuation: ActionApprovalContinuation): void;
  signal: AbortSignal;
}>): Promise<SessionPendingEditResultV1 | Readonly<{ status: 'rejected' }>> {
  const rejected = { status: 'rejected' } as const;
  if (!params.isCurrent() || params.signal.aborted) return rejected;
  const execute = createFrontDoorActionExecute(undefined, {
    pendingMessageEditIsCurrent: params.isCurrent,
    hostActionApprovalLifetime: { actionId: 'session.pending.edit', signal: params.signal, surface: 'ui' },
    onBlockingApprovalPending: pending => params.registerApproval({
      artifactId: pending.artifactId, scope: params.scope,
      signal: pending.signal ?? params.signal, refreshAfterExecution: false,
      // Canonical blocking admission retains the original editor and delivers its terminal receipt.
      onExecuted: async () => 'ignored',
    }),
  });
  const result = await execute('session.pending.edit', params.input, {
    ...params.context, signal: params.signal,
  });
  if (!result.ok) return rejected;
  const accepted = SessionPendingEditResultV1Schema.safeParse(result.result);
  return accepted.success ? accepted.data : rejected;
}
