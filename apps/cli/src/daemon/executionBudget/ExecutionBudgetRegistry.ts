export class ExecutionBudgetRegistry {
  private readonly maxConcurrentExecutionRuns: number | null;
  private readonly maxConcurrentOneShotTasks: number | null;
  private readonly maxConcurrentTotal: number | null;
  private readonly maxConcurrentByClass: Readonly<Record<string, number>>;
  private readonly inFlightByTokenId = new Map<string, string>();
  private readonly inFlightTokenIdsByClass = new Map<string, Set<string>>();

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
    return this.inFlightByTokenId.size;
  }

  private countInFlightForClass(cls: string): number {
    return this.inFlightTokenIdsByClass.get(cls)?.size ?? 0;
  }

  private tryAcquireToken(tokenId: string, cls: string, clsBaseCap: number | null): boolean {
    if (!tokenId || typeof tokenId !== 'string') return false;
    if (this.inFlightByTokenId.has(tokenId)) return true;

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

    this.inFlightByTokenId.set(tokenId, cls);
    const set = this.inFlightTokenIdsByClass.get(cls) ?? new Set<string>();
    set.add(tokenId);
    this.inFlightTokenIdsByClass.set(cls, set);
    return true;
  }

  private releaseToken(tokenId: string): void {
    if (!tokenId || typeof tokenId !== 'string') return;
    const cls = this.inFlightByTokenId.get(tokenId);
    if (!cls) return;
    this.inFlightByTokenId.delete(tokenId);
    const set = this.inFlightTokenIdsByClass.get(cls);
    if (!set) return;
    set.delete(tokenId);
    if (set.size === 0) {
      this.inFlightTokenIdsByClass.delete(cls);
    }
  }

  tryAcquireExecutionRun(runId: string, intent?: string): boolean {
    const cls = (typeof intent === 'string' && intent.trim().length > 0) ? intent.trim() : 'execution_run';
    return this.tryAcquireToken(runId, cls, this.maxConcurrentExecutionRuns);
  }

  releaseExecutionRun(runId: string): void {
    this.releaseToken(runId);
  }

  tryAcquireOneShotTask(taskId: string, kind?: 'automation' | 'scm_commit_message'): boolean {
    const cls = kind === 'automation' ? 'automation' : 'scm_commit_message';
    if (!taskId || typeof taskId !== 'string') return false;
    if (this.inFlightByTokenId.has(taskId)) return true;

    // Null means "no default cap". Explicit per-class or total caps may still constrain a one-shot task
    // when an operator opts into them.
    if (this.maxConcurrentOneShotTasks === null) {
      return this.tryAcquireToken(taskId, cls, null);
    }

    const inFlightOneShot =
      this.countInFlightForClass('automation')
      + this.countInFlightForClass('scm_commit_message');
    if (inFlightOneShot >= this.maxConcurrentOneShotTasks) return false;

    return this.tryAcquireToken(taskId, cls, this.maxConcurrentOneShotTasks);
  }

  releaseOneShotTask(taskId: string): void {
    this.releaseToken(taskId);
  }

  getInFlightSnapshot(): Readonly<{
    executionRuns: number;
    oneShotTasks: number;
  }> {
    const executionRunCount = Array.from(this.inFlightByTokenId.values())
      .filter((cls) => cls !== 'automation' && cls !== 'scm_commit_message')
      .length;
    const oneShotTaskCount = this.countInFlightForClass('automation') + this.countInFlightForClass('scm_commit_message');
    return {
      executionRuns: executionRunCount,
      oneShotTasks: oneShotTaskCount,
    };
  }
}
