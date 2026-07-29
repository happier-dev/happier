import type {
  ApprovalRequestV1,
  ExecutionRunHostActionApprovalRequestV1,
  TargetActionApprovalRequestV1,
} from '@happier-dev/protocol';

export type BlockingApprovalRequest =
  | ApprovalRequestV1
  | TargetActionApprovalRequestV1
  | ExecutionRunHostActionApprovalRequestV1;

export type BlockingApprovalWaitDecision =
  | Readonly<{ decision: 'approve'; request: BlockingApprovalRequest }>
  | Readonly<{ decision: 'reject'; request: BlockingApprovalRequest; reason?: string }>
  | Readonly<{ decision: 'canceled'; request: BlockingApprovalRequest; reason?: string }>;

export type BlockingApprovalCoordinator = Readonly<{
  waitForDecision: (args: Readonly<{
    artifactId: string;
    request: BlockingApprovalRequest;
    serverId?: string | null;
    signal?: AbortSignal;
    readRequest?: (() => Promise<BlockingApprovalRequest | null>) | null;
    pollIntervalMs?: number;
  }>) => Promise<BlockingApprovalWaitDecision>;
  notifyApprovalUpdated: (args: Readonly<{
    artifactId: string;
    request: BlockingApprovalRequest;
  }>) => void;
  resolveBlockingDecision: (args: Readonly<{
    artifactId: string;
    request: ApprovalRequestV1;
    decision: 'approve' | 'reject';
  }>) => Promise<Readonly<{ resolved: boolean }>>;
  cancelApproval: (artifactId: string, reason?: string) => void;
  dispose: (reason?: string) => void;
  getLiveWaiterCount: (artifactId: string) => number;
  getDetachedWaiterCount: (artifactId: string) => number;
}>;

type Waiter = {
  resolve: (value: BlockingApprovalWaitDecision) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
};

function normalizeId(raw: unknown): string {
  return String(raw ?? '').trim();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function normalizePollIntervalMs(raw: unknown): number {
  const parsed = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return 250;
  return Math.max(1, Math.min(60_000, Math.floor(parsed)));
}

export function createBlockingApprovalCoordinator(): BlockingApprovalCoordinator {
  const waitersByArtifactId = new Map<string, Set<Waiter>>();
  const detachedWaiterCountByArtifactId = new Map<string, number>();

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
      waiter.cleanup();
      waiter.reject(createCoordinatorError(reason, 'approval_wait_canceled'));
    }
  };

  return {
    waitForDecision: ({ artifactId: rawArtifactId, signal, readRequest, pollIntervalMs }) => {
      const artifactId = normalizeId(rawArtifactId);
      if (!artifactId) return Promise.reject(new Error('approval_artifact_id_required'));
      if (signal?.aborted) {
        detachedWaiterCountByArtifactId.set(artifactId, (detachedWaiterCountByArtifactId.get(artifactId) ?? 0) + 1);
        return Promise.reject(createCoordinatorError(signal.reason, 'approval_wait_aborted'));
      }

      return new Promise<BlockingApprovalWaitDecision>((resolve, reject) => {
        let settled = false;
        const waiter: Waiter = {
          resolve: (value) => {
            if (settled) return;
            settled = true;
            removeWaiter(artifactId, waiter);
            waiter.cleanup();
            resolve(value);
          },
          reject: (error) => {
            if (settled) return;
            settled = true;
            removeWaiter(artifactId, waiter);
            waiter.cleanup();
            reject(error);
          },
          cleanup: () => {},
        };
        const abort = () => {
          detachedWaiterCountByArtifactId.set(artifactId, (detachedWaiterCountByArtifactId.get(artifactId) ?? 0) + 1);
          waiter.reject(createCoordinatorError(signal?.reason, 'approval_wait_aborted'));
        };
        if (signal) {
          signal.addEventListener('abort', abort, { once: true });
          waiter.cleanup = () => signal.removeEventListener('abort', abort);
        }

        const waiters = waitersByArtifactId.get(artifactId) ?? new Set<Waiter>();
        waiters.add(waiter);
        waitersByArtifactId.set(artifactId, waiters);

        if (readRequest) {
          const intervalMs = normalizePollIntervalMs(pollIntervalMs);
          void (async () => {
            while (!settled) {
              if (signal?.aborted) {
                abort();
                return;
              }
              try {
                const latest = await readRequest();
                if (latest) {
                  const decision = readDurableDecision(latest);
                  if (decision) {
                    waiter.resolve(decision);
                    return;
                  }
                }
              } catch {
                // Transient artifact reads should not abandon the live approval wait.
              }
              await delay(intervalMs);
            }
          })();
        }
      });
    },
    notifyApprovalUpdated: ({ artifactId: rawArtifactId, request }) => {
      const artifactId = normalizeId(rawArtifactId);
      if (!artifactId) return;
      const decision = readDurableDecision(request);
      if (!decision) return;

      const waiters = waitersByArtifactId.get(artifactId);
      if (!waiters) return;
      waitersByArtifactId.delete(artifactId);
      for (const waiter of waiters) {
        waiter.cleanup();
        waiter.resolve(decision);
      }
    },
    resolveBlockingDecision: async ({ artifactId: rawArtifactId, request, decision }) => {
      const artifactId = normalizeId(rawArtifactId);
      if (!artifactId) return { resolved: false };
      const waiters = waitersByArtifactId.get(artifactId);
      if (!waiters || waiters.size === 0) return { resolved: false };

      const resolvedDecision = readDecision(request) ?? { decision, request };
      waitersByArtifactId.delete(artifactId);
      for (const waiter of waiters) {
        waiter.cleanup();
        waiter.resolve(resolvedDecision);
      }
      return { resolved: true };
    },
    cancelApproval: (artifactId, reason = 'approval_wait_canceled') => {
      rejectWaiters(normalizeId(artifactId), reason);
    },
    dispose: (reason = 'approval_coordinator_disposed') => {
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
