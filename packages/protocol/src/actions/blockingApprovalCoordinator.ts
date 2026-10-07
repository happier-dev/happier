import type { ApprovalRequest } from '../approvals/approvalRequestV1.js';
import type { ExecutionRunHostActionApprovalRequestV1 } from '../approvals/executionRunHostActionApprovalRequestV1.js';
import type { TargetActionApprovalRequestV1 } from '../approvals/targetActionApprovalRequestV1.js';
import type { ActionRequiredAuthority } from './metadata.js';

export type BlockingApprovalRequest =
  | ApprovalRequest
  | TargetActionApprovalRequestV1
  | ExecutionRunHostActionApprovalRequestV1;

export type BlockingApprovalWaitDecision =
  | Readonly<{ decision: 'approve'; request: BlockingApprovalRequest; decisionAuthority?: ActionRequiredAuthority }>
  | Readonly<{ decision: 'reject'; request: BlockingApprovalRequest; reason?: string }>
  | Readonly<{ decision: 'canceled'; request: BlockingApprovalRequest; reason?: string }>;

export type BlockingApprovalChangeSubscription = (
  onChange: () => void,
  onError: (error: unknown) => void,
) => Readonly<{ dispose(): void | Promise<void> }>;

export type BlockingApprovalCoordinator = Readonly<{
  waitForDecision: (args: Readonly<{
    artifactId: string;
    request: BlockingApprovalRequest;
    serverId?: string | null;
    signal?: AbortSignal;
    readRequest?: (() => Promise<BlockingApprovalRequest | null>) | null;
    subscribeChanges?: BlockingApprovalChangeSubscription;
  }>) => Promise<BlockingApprovalWaitDecision>;
  notifyApprovalUpdated: (args: Readonly<{
    artifactId: string;
    request: BlockingApprovalRequest;
  }>) => void;
  subscribeApprovalChanges: (listener: (change: Readonly<{
    artifactId: string;
    request: BlockingApprovalRequest;
  }>) => void) => Readonly<{ dispose(): void }>;
  resolveBlockingDecision: (args: Readonly<{
    artifactId: string;
    request: ApprovalRequest;
    decision: 'approve' | 'reject';
    /** Authenticated live decision ingress only; never read from the Artifact. */
    decisionAuthority?: ActionRequiredAuthority;
  }>) => Promise<Readonly<{ resolved: boolean }>>;
  cancelApproval: (artifactId: string, reason?: string) => void;
  dispose: (reason?: string) => void;
  getLiveWaiterCount: (artifactId: string) => number;
  getDetachedWaiterCount: (artifactId: string) => number;
}>;

type Waiter = {
  resolve: (value: BlockingApprovalWaitDecision) => void;
  reject: (error: Error) => void;
  cleanup: () => void | Promise<void>;
};

function normalizeId(raw: unknown): string {
  return String(raw ?? '').trim();
}

function createCoordinatorError(reason: unknown, fallback: string): Error {
  return new Error(typeof reason === 'string' && reason.trim().length > 0 ? reason.trim() : fallback);
}

function readDecision(request: BlockingApprovalRequest): BlockingApprovalWaitDecision | null {
  if (
    (request.status === 'approved'
      || request.status === 'executed'
      || (request.status === 'failed' && 'execution' in request && request.execution))
    && request.decision?.kind === 'approve'
  ) {
    return { decision: 'approve', request };
  }
  if (request.status === 'rejected' && request.decision?.kind === 'reject') {
    return { decision: 'reject', request };
  }
  if (request.status === 'canceled') {
    return { decision: 'canceled', request };
  }
  return null;
}

function readDurableDecision(request: BlockingApprovalRequest): BlockingApprovalWaitDecision | null {
  if ('kind' in request
    && (request.kind === 'plugin_target_action' || request.kind === 'execution_run_host_action')
    && request.status === 'approved'
    && request.decision?.kind === 'approve') {
    return { decision: 'approve', request };
  }
  if ((request.status === 'executed' || request.status === 'failed')
    && request.decision?.kind === 'approve'
    && 'execution' in request
    && request.execution) {
    return { decision: 'approve', request };
  }
  if (request.status === 'rejected' && request.decision?.kind === 'reject') {
    return { decision: 'reject', request };
  }
  if (request.status === 'canceled') {
    return { decision: 'canceled', request };
  }
  return null;
}

export function createBlockingApprovalCoordinator(): BlockingApprovalCoordinator {
  const waitersByArtifactId = new Map<string, Set<Waiter>>();
  const detachedWaiterCountByArtifactId = new Map<string, number>();
  const approvalChangeListeners = new Set<(change: Readonly<{
    artifactId: string;
    request: BlockingApprovalRequest;
  }>) => void>();

  const removeWaiter = (artifactId: string, waiter: Waiter): void => {
    const waiters = waitersByArtifactId.get(artifactId);
    if (!waiters) return;
    waiters.delete(waiter);
    if (waiters.size === 0) {
      waitersByArtifactId.delete(artifactId);
    }
  };

  const rejectWaiters = (artifactId: string, reason: string): void => {
    const waiters = waitersByArtifactId.get(artifactId);
    if (!waiters) return;
    waitersByArtifactId.delete(artifactId);
    for (const waiter of waiters) {
      waiter.reject(createCoordinatorError(reason, 'approval_wait_canceled'));
    }
  };

  return {
    waitForDecision: ({ artifactId: rawArtifactId, signal, readRequest, subscribeChanges }) => {
      const artifactId = normalizeId(rawArtifactId);
      if (!artifactId) return Promise.reject(new Error('approval_artifact_id_required'));
      if (signal?.aborted) {
        detachedWaiterCountByArtifactId.set(artifactId, (detachedWaiterCountByArtifactId.get(artifactId) ?? 0) + 1);
        return Promise.reject(createCoordinatorError(signal.reason, 'approval_wait_aborted'));
      }

      return new Promise<BlockingApprovalWaitDecision>((resolve, reject) => {
        let settled = false;
        let subscription: ReturnType<BlockingApprovalChangeSubscription> | undefined;
        const waiter: Waiter = {
          resolve: (value) => {
            if (settled) return;
            settled = true;
            removeWaiter(artifactId, waiter);
            void Promise.resolve().then(() => waiter.cleanup()).then(() => resolve(value), reject);
          },
          reject: (error) => {
            if (settled) return;
            settled = true;
            removeWaiter(artifactId, waiter);
            void Promise.resolve().then(() => waiter.cleanup()).then(() => reject(error), reject);
          },
          cleanup: () => {
            signal?.removeEventListener('abort', abort);
            const current = subscription;
            subscription = undefined;
            return current?.dispose();
          },
        };
        const abort = () => {
          if (settled) return;
          detachedWaiterCountByArtifactId.set(artifactId, (detachedWaiterCountByArtifactId.get(artifactId) ?? 0) + 1);
          waiter.reject(createCoordinatorError(signal?.reason, 'approval_wait_aborted'));
        };
        if (signal) {
          signal.addEventListener('abort', abort, { once: true });
        }

        const waiters = waitersByArtifactId.get(artifactId) ?? new Set<Waiter>();
        waiters.add(waiter);
        waitersByArtifactId.set(artifactId, waiters);

        let reading = false;
        let readRequested = false;
        const invalidate = () => {
          if (settled || !readRequest) return;
          readRequested = true;
          if (reading) return;
          reading = true;
          void (async () => {
            try {
              while (!settled && readRequested) {
                readRequested = false;
                const latest = await readRequest();
                if (settled) return;
                if (latest) {
                  const decision = readDurableDecision(latest);
                  if (decision) {
                    waiter.resolve(decision);
                    return;
                  }
                }
              }
            } catch (error) {
              waiter.reject(error instanceof Error ? error : createCoordinatorError(error, 'approval_read_failed'));
            } finally {
              reading = false;
            }
          })();
        };
        try {
          subscription = subscribeChanges?.(invalidate, (error) => {
            waiter.reject(error instanceof Error ? error : createCoordinatorError(error, 'approval_feed_failed'));
          });
          // Subscribe first so changes racing the initial durable read remain pending.
          invalidate();
        } catch (error) {
          waiter.reject(error instanceof Error ? error : createCoordinatorError(error, 'approval_feed_failed'));
        }
      });
    },
    notifyApprovalUpdated: ({ artifactId: rawArtifactId, request }) => {
      const artifactId = normalizeId(rawArtifactId);
      if (!artifactId) return;
      const change = Object.freeze({ artifactId, request });
      for (const listener of [...approvalChangeListeners]) {
        try {
          listener(change);
        } catch {
          // Queue delivery listeners are isolated; their owner records diagnostics.
        }
      }
      const decision = readDurableDecision(request);
      if (!decision) return;

      const waiters = waitersByArtifactId.get(artifactId);
      if (!waiters) return;
      waitersByArtifactId.delete(artifactId);
      for (const waiter of waiters) {
        waiter.resolve(decision);
      }
    },
    subscribeApprovalChanges: (listener) => {
      approvalChangeListeners.add(listener);
      let disposed = false;
      return Object.freeze({
        dispose() {
          if (disposed) return;
          disposed = true;
          approvalChangeListeners.delete(listener);
        },
      });
    },
    resolveBlockingDecision: async ({ artifactId: rawArtifactId, request, decision, decisionAuthority }) => {
      const artifactId = normalizeId(rawArtifactId);
      if (!artifactId) return { resolved: false };
      const waiters = waitersByArtifactId.get(artifactId);
      if (!waiters || waiters.size === 0) return { resolved: false };

      const resolvedDecision = readDecision(request) ?? { decision, request };
      const liveDecision = resolvedDecision.decision === 'approve' && decisionAuthority !== undefined
        ? { ...resolvedDecision, decisionAuthority }
        : resolvedDecision;
      waitersByArtifactId.delete(artifactId);
      for (const waiter of waiters) {
        waiter.resolve(liveDecision);
      }
      return { resolved: true };
    },
    cancelApproval: (artifactId, reason = 'approval_wait_canceled') => {
      rejectWaiters(normalizeId(artifactId), reason);
    },
    dispose: (reason = 'approval_coordinator_disposed') => {
      approvalChangeListeners.clear();
      for (const artifactId of [...waitersByArtifactId.keys()]) {
        rejectWaiters(artifactId, reason);
      }
    },
    getLiveWaiterCount: (artifactId) => waitersByArtifactId.get(normalizeId(artifactId))?.size ?? 0,
    getDetachedWaiterCount: (artifactId) => detachedWaiterCountByArtifactId.get(normalizeId(artifactId)) ?? 0,
  };
}

let sharedBlockingApprovalCoordinator: BlockingApprovalCoordinator | null = null;

export function getSharedBlockingApprovalCoordinator(): BlockingApprovalCoordinator {
  if (!sharedBlockingApprovalCoordinator) {
    sharedBlockingApprovalCoordinator = createBlockingApprovalCoordinator();
  }
  return sharedBlockingApprovalCoordinator;
}
