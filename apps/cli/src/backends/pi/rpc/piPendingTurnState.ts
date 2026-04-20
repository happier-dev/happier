import { createDeferred, type Deferred, type PendingTurn } from './rpcSupport';

export class PiPendingTurnState {
  private pendingTurn: PendingTurn | null = null;
  private pendingTurnBarrier: Deferred<void> | null = null;

  constructor(private readonly params: Readonly<{ resetOpenPromptRequestIds: () => void }>) {}

  beginPromptBarrier(): Readonly<{
    promise: Promise<void>;
    settle: (error?: Error) => void;
  }> {
    const barrier = createDeferred<void>();
    this.pendingTurnBarrier = barrier;
    return {
      promise: barrier.promise,
      settle: (error?: Error) => {
        if (this.pendingTurnBarrier !== barrier) return;
        this.pendingTurnBarrier = null;
        if (error) {
          barrier.reject(error);
          return;
        }
        barrier.resolve(undefined);
      },
    };
  }

  rejectBarrier(error: Error): void {
    if (!this.pendingTurnBarrier) return;
    const barrier = this.pendingTurnBarrier;
    this.pendingTurnBarrier = null;
    barrier.reject(error);
  }

  hasPendingTurn(): boolean {
    return this.pendingTurn !== null;
  }

  createPendingTurn(timeoutMs: number): Promise<void> {
    this.rejectPendingTurn(new Error('replaced by newer turn'));
    let resolveTurn: (() => void) | null = null;
    let rejectTurn: ((error: Error) => void) | null = null;

    const promise = new Promise<void>((resolve, reject) => {
      resolveTurn = resolve;
      rejectTurn = reject;
    });

    const timeout = setTimeout(() => {
      if (this.pendingTurn?.timeout === timeout) {
        this.pendingTurn = null;
      }
      this.params.resetOpenPromptRequestIds();
      rejectTurn?.(new Error('Timed out waiting for Pi turn completion'));
    }, timeoutMs);
    timeout.unref?.();

    if (!resolveTurn || !rejectTurn) {
      clearTimeout(timeout);
      throw new Error('Failed to initialize Pi pending turn');
    }

    this.pendingTurn = { promise, resolve: resolveTurn, reject: rejectTurn, timeout };
    return promise;
  }

  async waitForResponseComplete(timeoutMs?: number | null): Promise<void> {
    if (!this.pendingTurn && this.pendingTurnBarrier) {
      await this.pendingTurnBarrier.promise;
    }
    if (!this.pendingTurn) return;
    const turn = this.pendingTurn;

    const stallTimeoutMs =
      typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0
        ? Math.trunc(timeoutMs)
        : null;

    if (stallTimeoutMs === null) {
      await turn.promise;
      return;
    }

    let timeout: NodeJS.Timeout | null = null;
    try {
      await Promise.race([
        turn.promise,
        new Promise<void>((_, reject) => {
          timeout = setTimeout(() => {
            reject(new Error('Timed out waiting for Pi response completion'));
          }, stallTimeoutMs);
          timeout.unref?.();
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  resolvePendingTurn(): void {
    if (!this.pendingTurn) return;
    const pending = this.pendingTurn;
    this.pendingTurn = null;
    clearTimeout(pending.timeout);
    this.params.resetOpenPromptRequestIds();
    pending.resolve();
  }

  rejectPendingTurn(error: Error): void {
    if (!this.pendingTurn) return;
    const pending = this.pendingTurn;
    this.pendingTurn = null;
    clearTimeout(pending.timeout);
    this.params.resetOpenPromptRequestIds();
    pending.reject(error);
  }
}
