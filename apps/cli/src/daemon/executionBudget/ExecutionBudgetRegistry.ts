import type { LiveWorkProducerV1 } from '@/daemon/lifecycle/managedActivity';
import { RequesterWorkAttributionV1Schema, type RequesterWorkAttributionV1 } from '@/daemon/lifecycle/requesterWorkAttribution';

type ExecutionBudgetToken = {
  cls: string;
  acquired: boolean;
  preparations: number;
  category?: 'finite';
  attribution?: RequesterWorkAttributionV1;
};

export class ExecutionBudgetRegistry {
  private readonly inFlightByTokenId = new Map<string | Promise<unknown>, ExecutionBudgetToken>();
  private readonly liveWorkListeners = new Set<() => void>();

  private notifyLiveWorkChanged(): void {
    for (const listener of this.liveWorkListeners) {
      try { listener(); } catch { /* Observation cannot revoke accepted token custody. */ }
    }
  }

  /** Complete for this owner's tokens; uncapped/external runs need their real run producer. */
  getLiveWorkProducer(): LiveWorkProducerV1 {
    return {
      read: () => ({
        coverage: 'complete',
        items: Array.from(this.inFlightByTokenId, ([tokenId, token]) => ({
          category: token.category ?? (token.cls === 'automation' ? 'workflow_run' as const : 'execution_run' as const),
          ownerRef: tokenId,
          attribution: token.attribution ?? { kind: 'unknown' as const },
          state: 'active' as const,
        })),
      }),
      subscribe: (listener) => {
        this.liveWorkListeners.add(listener);
        return () => { this.liveWorkListeners.delete(listener); };
      },
    };
  }

  /** Accepted preparation retains the existing run token without changing active custody. */
  retainExecutionRunPreparation(runId: string, intent?: string, attribution?: RequesterWorkAttributionV1): () => void {
    return this.retainWorkToken(runId, {
      cls: intent?.trim() || 'execution_run', acquired: false, preparations: 0,
      ...(attribution ? { attribution: Object.freeze(RequesterWorkAttributionV1Schema.parse(attribution)) } : {}),
    });
  }

  /** The executing owner retains its actual process Promise; finite work shares the same custody owner. */
  retainFiniteTask(task: Promise<unknown>, attribution?: RequesterWorkAttributionV1): () => void {
    return this.retainWorkToken(task, {
      cls: 'finite', category: 'finite', acquired: false, preparations: 0,
      ...(attribution ? { attribution } : {}),
    });
  }

  private retainWorkToken(ownerRef: string | Promise<unknown>, initial: ExecutionBudgetToken): () => void {
    const token = this.inFlightByTokenId.get(ownerRef) ?? initial;
    const added = !this.inFlightByTokenId.has(ownerRef);
    token.preparations += 1;
    this.inFlightByTokenId.set(ownerRef, token);
    if (added) this.notifyLiveWorkChanged();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (this.inFlightByTokenId.get(ownerRef) !== token) return;
      token.preparations -= 1;
      if (!token.preparations && !token.acquired) {
        this.inFlightByTokenId.delete(ownerRef);
        this.notifyLiveWorkChanged();
      }
    };
  }

  private tryAcquireToken(tokenId: string, cls: string, attribution?: RequesterWorkAttributionV1): boolean {
    if (!tokenId || typeof tokenId !== 'string') return false;
    const existing = this.inFlightByTokenId.get(tokenId);
    if (existing?.acquired) return true;

    const token = existing ?? { cls, acquired: false, preparations: 0,
      ...(attribution ? { attribution: Object.freeze(RequesterWorkAttributionV1Schema.parse(attribution)) } : {}) };
    token.cls = cls;
    token.acquired = true;
    this.inFlightByTokenId.set(tokenId, token);
    this.notifyLiveWorkChanged();
    return true;
  }

  private releaseToken(tokenId: string): void {
    if (!tokenId || typeof tokenId !== 'string') return;
    const token = this.inFlightByTokenId.get(tokenId);
    if (!token?.acquired) return;
    token.acquired = false;
    if (!token.preparations) this.inFlightByTokenId.delete(tokenId);
    this.notifyLiveWorkChanged();
  }

  tryAcquireExecutionRun(runId: string, intent?: string, attribution?: RequesterWorkAttributionV1): boolean {
    const cls = (typeof intent === 'string' && intent.trim().length > 0) ? intent.trim() : 'execution_run';
    return this.tryAcquireToken(runId, cls, attribution);
  }

  releaseExecutionRun(runId: string): void {
    this.releaseToken(runId);
  }

  tryAcquireOneShotTask(taskId: string, kind?: 'automation' | 'scm_commit_message', attribution?: RequesterWorkAttributionV1): boolean {
    const cls = kind === 'automation' ? 'automation' : 'scm_commit_message';
    return this.tryAcquireToken(taskId, cls, attribution);
  }

  releaseOneShotTask(taskId: string): void {
    this.releaseToken(taskId);
  }

  getInFlightSnapshot(): Readonly<{
    executionRuns: number;
    oneShotTasks: number;
  }> {
    let executionRuns = 0;
    let oneShotTasks = 0;
    for (const token of this.inFlightByTokenId.values()) {
      if (!token.acquired) continue;
      if (token.cls === 'automation' || token.cls === 'scm_commit_message') oneShotTasks += 1;
      else executionRuns += 1;
    }
    return { executionRuns, oneShotTasks };
  }
}
