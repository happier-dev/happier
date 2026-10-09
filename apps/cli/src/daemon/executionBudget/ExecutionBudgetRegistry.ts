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
  private readonly maxConcurrentExecutionRuns: number | null;
  private readonly maxConcurrentOneShotTasks: number | null;
  private readonly maxConcurrentTotal: number | null;
  private readonly maxConcurrentByClass: Readonly<Record<string, number>>;
  private readonly inFlightByTokenId = new Map<string | Promise<unknown>, ExecutionBudgetToken>();
  private readonly inFlightTokenIdsByClass = new Map<string, Set<string>>();
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

  /** Accepted preparation retains the existing run token without advancing cap admission. */
  retainExecutionRunPreparation(runId: string, intent?: string, attribution?: RequesterWorkAttributionV1): () => void {
    return this.retainWorkToken(runId, {
      cls: intent?.trim() || 'execution_run', acquired: false, preparations: 0,
      ...(attribution ? { attribution: Object.freeze(RequesterWorkAttributionV1Schema.parse(attribution)) } : {}),
    });
  }

  /** The executing owner retains its actual process Promise; finite work adds no cap. */
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

  constructor(params: Readonly<{
    maxConcurrentExecutionRuns: number | null;
    maxConcurrentOneShotTasks: number | null;
    maxConcurrentTotal?: number;
    maxConcurrentByClass?: Readonly<Record<string, number>>;
  }>) {
    if (
      params.maxConcurrentExecutionRuns !== null
      && (!Number.isInteger(params.maxConcurrentExecutionRuns) || params.maxConcurrentExecutionRuns < 1)
    ) {
      throw new Error(`Invalid maxConcurrentExecutionRuns: ${params.maxConcurrentExecutionRuns}`);
    }
    if (
      params.maxConcurrentOneShotTasks !== null
      && (!Number.isInteger(params.maxConcurrentOneShotTasks) || params.maxConcurrentOneShotTasks < 1)
    ) {
      throw new Error(`Invalid maxConcurrentOneShotTasks: ${params.maxConcurrentOneShotTasks}`);
    }
    this.maxConcurrentExecutionRuns = params.maxConcurrentExecutionRuns;
    this.maxConcurrentOneShotTasks = params.maxConcurrentOneShotTasks;
    this.maxConcurrentTotal =
      typeof params.maxConcurrentTotal === 'number'
        && Number.isInteger(params.maxConcurrentTotal)
        && params.maxConcurrentTotal >= 1
        ? params.maxConcurrentTotal
        : null;
    this.maxConcurrentByClass = Object.freeze({ ...(params.maxConcurrentByClass ?? {}) });
  }

  private countInFlightTotal(): number {
    return Array.from(this.inFlightTokenIdsByClass.values()).reduce((count, tokens) => count + tokens.size, 0);
  }

  private countInFlightForClass(cls: string): number {
    return this.inFlightTokenIdsByClass.get(cls)?.size ?? 0;
  }

  private tryAcquireToken(tokenId: string, cls: string, clsBaseCap: number | null, attribution?: RequesterWorkAttributionV1): boolean {
    if (!tokenId || typeof tokenId !== 'string') return false;
    const existing = this.inFlightByTokenId.get(tokenId);
    if (existing?.acquired) return true;

    const totalCap = this.maxConcurrentTotal;
    if (typeof totalCap === 'number' && this.countInFlightTotal() >= totalCap) return false;

    const perClassCapRaw = this.maxConcurrentByClass[cls];
    const perClassCap =
      typeof perClassCapRaw === 'number' && Number.isInteger(perClassCapRaw) && perClassCapRaw >= 1
        ? perClassCapRaw
        : null;

    // Null means "no default cap". Explicit per-class or total caps may still constrain a run when
    // an operator opts into them, but product defaults stay uncapped.
    const effectiveCap =
      perClassCap === null
        ? clsBaseCap
        : typeof clsBaseCap === 'number'
          ? Math.min(clsBaseCap, perClassCap)
          : perClassCap;
    if (typeof effectiveCap === 'number' && this.countInFlightForClass(cls) >= effectiveCap) return false;

    const token = existing ?? { cls, acquired: false, preparations: 0,
      ...(attribution ? { attribution: Object.freeze(RequesterWorkAttributionV1Schema.parse(attribution)) } : {}) };
    token.cls = cls;
    token.acquired = true;
    this.inFlightByTokenId.set(tokenId, token);
    const set = this.inFlightTokenIdsByClass.get(cls) ?? new Set<string>();
    set.add(tokenId);
    this.inFlightTokenIdsByClass.set(cls, set);
    this.notifyLiveWorkChanged();
    return true;
  }

  private releaseToken(tokenId: string): void {
    if (!tokenId || typeof tokenId !== 'string') return;
    const token = this.inFlightByTokenId.get(tokenId);
    if (!token?.acquired) return;
    token.acquired = false;
    if (!token.preparations) this.inFlightByTokenId.delete(tokenId);
    const set = this.inFlightTokenIdsByClass.get(token.cls);
    set?.delete(tokenId);
    if (set?.size === 0) {
      this.inFlightTokenIdsByClass.delete(token.cls);
    }
    this.notifyLiveWorkChanged();
  }

  tryAcquireExecutionRun(runId: string, intent?: string, attribution?: RequesterWorkAttributionV1): boolean {
    const cls = (typeof intent === 'string' && intent.trim().length > 0) ? intent.trim() : 'execution_run';
    return this.tryAcquireToken(runId, cls, this.maxConcurrentExecutionRuns, attribution);
  }

  releaseExecutionRun(runId: string): void {
    this.releaseToken(runId);
  }

  tryAcquireOneShotTask(taskId: string, kind?: 'automation' | 'scm_commit_message', attribution?: RequesterWorkAttributionV1): boolean {
    const cls = kind === 'automation' ? 'automation' : 'scm_commit_message';
    if (!taskId || typeof taskId !== 'string') return false;
    if (this.inFlightByTokenId.get(taskId)?.acquired) return true;

    // Null means "no default cap". Explicit per-class or total caps may still constrain a one-shot task
    // when an operator opts into them.
    if (this.maxConcurrentOneShotTasks === null) {
      return this.tryAcquireToken(taskId, cls, null, attribution);
    }

    const inFlightOneShot =
      this.countInFlightForClass('automation')
      + this.countInFlightForClass('scm_commit_message');
    if (inFlightOneShot >= this.maxConcurrentOneShotTasks) return false;

    return this.tryAcquireToken(taskId, cls, this.maxConcurrentOneShotTasks, attribution);
  }

  releaseOneShotTask(taskId: string): void {
    this.releaseToken(taskId);
  }

  getInFlightSnapshot(): Readonly<{
    executionRuns: number;
    oneShotTasks: number;
  }> {
    const executionRunCount = Array.from(this.inFlightByTokenId.values())
      .filter((token) => token.acquired && token.cls !== 'automation' && token.cls !== 'scm_commit_message')
      .length;
    const oneShotTaskCount = this.countInFlightForClass('automation') + this.countInFlightForClass('scm_commit_message');
    return {
      executionRuns: executionRunCount,
      oneShotTasks: oneShotTaskCount,
    };
  }
}
