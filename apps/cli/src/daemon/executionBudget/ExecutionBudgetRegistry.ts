export class ExecutionBudgetRegistry {
  private readonly maxConcurrentExecutionRuns: number;
  private readonly maxConcurrentEphemeralTasks: number;
  private readonly maxConcurrentTotal: number | null;
  private readonly maxConcurrentByClass: Readonly<Record<string, number>>;
  private readonly inFlightByTokenId = new Map<string, string>();
  private readonly inFlightTokenIdsByClass = new Map<string, Set<string>>();

  constructor(params: Readonly<{
    maxConcurrentExecutionRuns: number;
    maxConcurrentEphemeralTasks: number;
    maxConcurrentTotal?: number;
    maxConcurrentByClass?: Readonly<Record<string, number>>;
  }>) {
    if (!Number.isInteger(params.maxConcurrentExecutionRuns) || params.maxConcurrentExecutionRuns < 1) {
      throw new Error(`Invalid maxConcurrentExecutionRuns: ${params.maxConcurrentExecutionRuns}`);
    }
    if (!Number.isInteger(params.maxConcurrentEphemeralTasks) || params.maxConcurrentEphemeralTasks < 1) {
      throw new Error(`Invalid maxConcurrentEphemeralTasks: ${params.maxConcurrentEphemeralTasks}`);
    }
    this.maxConcurrentExecutionRuns = params.maxConcurrentExecutionRuns;
    this.maxConcurrentEphemeralTasks = params.maxConcurrentEphemeralTasks;
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

  private tryAcquireToken(tokenId: string, cls: string, clsBaseCap: number): boolean {
    if (!tokenId || typeof tokenId !== 'string') return false;
    if (this.inFlightByTokenId.has(tokenId)) return true;

    const totalCap = this.maxConcurrentTotal;
    if (typeof totalCap === 'number' && this.countInFlightTotal() >= totalCap) return false;

    const perClassCapRaw = this.maxConcurrentByClass[cls];
    const perClassCap =
      typeof perClassCapRaw === 'number' && Number.isInteger(perClassCapRaw) && perClassCapRaw >= 1
        ? perClassCapRaw
        : null;

    const effectiveCap = perClassCap === null ? clsBaseCap : Math.min(clsBaseCap, perClassCap);
    if (this.countInFlightForClass(cls) >= effectiveCap) return false;

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

  tryAcquireEphemeralTask(taskId: string, kind?: 'automation' | 'ephemeral_task'): boolean {
    const cls = kind === 'automation' ? 'automation' : 'ephemeral_task';
    return this.tryAcquireToken(taskId, cls, this.maxConcurrentEphemeralTasks);
  }

  releaseEphemeralTask(taskId: string): void {
    this.releaseToken(taskId);
  }

  getInFlightSnapshot(): Readonly<{
    executionRuns: number;
    ephemeralTasks: number;
  }> {
    const executionRunCount = Array.from(this.inFlightByTokenId.values())
      .filter((cls) => cls !== 'automation' && cls !== 'ephemeral_task')
      .length;
    const ephemeralTaskCount = this.countInFlightForClass('automation') + this.countInFlightForClass('ephemeral_task');
    return {
      executionRuns: executionRunCount,
      ephemeralTasks: ephemeralTaskCount,
    };
  }
}
