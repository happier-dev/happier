import {
  getSharedBlockingApprovalCoordinator,
  type BlockingApprovalRequest,
  type BlockingApprovalWaitDecision,
} from '@happier-dev/protocol/actions/blockingApprovalCoordinator';

/** One creation lifetime for the waiter installed before Artifact publication. */
export function createLiveApprovalDecision<Request extends BlockingApprovalRequest>(deps: Readonly<{
  read: (artifactId: string) => Promise<Request | null>;
  signal?: AbortSignal;
  subscribeChanges?: (artifactId: string, onChange: () => void, onError: (error: unknown) => void) => Readonly<{ dispose(): void | Promise<void> }>;
}>) {
  const coordinator = getSharedBlockingApprovalCoordinator();
  const creationLifetime = new AbortController();
  const signal = deps.signal ? AbortSignal.any([deps.signal, creationLifetime.signal]) : creationLifetime.signal;
  let pending: Promise<BlockingApprovalWaitDecision> | undefined;
  return {
    waitForDecision(ready: Readonly<{ artifactId: string; request: Request }>) {
      if (pending) return pending;
      pending = coordinator.waitForDecision({ ...ready, signal, readRequest: () => deps.read(ready.artifactId),
        ...(deps.subscribeChanges ? { subscribeChanges: (onChange, onError) => deps.subscribeChanges!(ready.artifactId, onChange, onError) } : {}),
      });
      // Creation can reject before the caller can await the decision. Retain
      // the original creation failure while its owner cancels this waiter.
      void pending.catch(() => undefined);
      return pending;
    },
    async cancelCreation() {
      creationLifetime.abort();
      await pending?.catch(() => undefined);
    },
  };
}
