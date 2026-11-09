import type { ActionExecuteResult, ActionExecutorContext } from '@happier-dev/protocol';
import { getActionSpec, type SignedRootActionId } from '@happier-dev/protocol/actions/actionSpecs';
import { logger } from '@/ui/logger';

/** Private operands remain with the daemon; the terminal receives their approval id. */
export function createSignedRootActionApprovalAcknowledgement() {
  const shutdown = new AbortController();
  const retained = new Set<Promise<ActionExecuteResult>>();
  return {
    async execute(args: Readonly<{
      actionId: SignedRootActionId;
      surface: 'cli' | 'mcp';
      signal: AbortSignal;
      run(signal: AbortSignal, progress?: ActionExecutorContext['operationOwnerUpdate']): Promise<ActionExecuteResult>;
    }>): Promise<ActionExecuteResult> {
      const spec = getActionSpec(args.actionId);
      if (args.surface !== 'cli' || spec.approvalInputCustody !== 'live_only') return await args.run(args.signal);
      const invocation = new AbortController();
      const cancel = () => invocation.abort(args.signal.reason);
      const stop = () => invocation.abort(shutdown.signal.reason);
      args.signal.addEventListener('abort', cancel, { once: true });
      shutdown.signal.addEventListener('abort', stop, { once: true });
      if (args.signal.aborted) cancel();
      if (shutdown.signal.aborted) stop();
      let acknowledged = false;
      let acknowledge!: (result: ActionExecuteResult) => void;
      const pendingApproval = new Promise<ActionExecuteResult>(resolve => { acknowledge = resolve; });
      const completion = Promise.resolve().then(() => args.run(invocation.signal, {
        update: ({ progress }) => {
          const approval = progress?.approval;
          if (acknowledged || invocation.signal.aborted || progress?.phase !== 'waiting_for_approval'
            || !approval || approval.actionId !== args.actionId) return;
          // Only the executor's persisted-approval receipt transfers lifetime.
          // A disconnect before this producer fact still cancels the request.
          acknowledged = true;
          args.signal.removeEventListener('abort', cancel);
          acknowledge({ ok: true, result: approval });
        },
      }));
      retained.add(completion);
      const cleanup = () => {
        args.signal.removeEventListener('abort', cancel);
        shutdown.signal.removeEventListener('abort', stop);
        retained.delete(completion);
      };
      void completion.then(cleanup, () => {
        cleanup();
        if (acknowledged) logger.warnLocalFile('[Signed root approval] Retained invocation ended unexpectedly', {
          actionId: args.actionId,
        });
      });
      return await Promise.race([completion, pendingApproval]);
    },
    async close(): Promise<void> {
      shutdown.abort();
      await Promise.allSettled([...retained]);
    },
  };
}
