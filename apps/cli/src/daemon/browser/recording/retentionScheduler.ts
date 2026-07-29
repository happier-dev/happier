type BrowserRecordingRetentionCleanupResult = Readonly<{
  discardedRecordingIds: readonly string[];
  failedRecordingIds: readonly string[];
}>;

export type BrowserRecordingRetentionCleanupRunner = Readonly<{
  cleanupExpiredRecordings(input: Readonly<{ nowMs: number }>): Promise<BrowserRecordingRetentionCleanupResult>;
}>;

export type BrowserRecordingRetentionCleanupRunResult =
  | Readonly<{
      status: 'cleaned';
      discardedRecordingIds: readonly string[];
      failedRecordingIds: readonly string[];
    }>
  | Readonly<{
      status: 'skipped';
      reason: 'cleanup_already_running';
    }>
  | Readonly<{
      status: 'failed';
      error: unknown;
    }>;

type TimerHandle = unknown;
type SetTimer = (callback: () => void, delayMs: number) => TimerHandle;
type ClearTimer = (handle: TimerHandle) => void;

export class BrowserRecordingRetentionCleanupScheduler {
  readonly #cleanupExpiredRecordings: BrowserRecordingRetentionCleanupRunner['cleanupExpiredRecordings'];
  readonly #nowMs: () => number;
  readonly #intervalMs: number;
  readonly #setTimeout: SetTimer;
  readonly #clearTimeout: ClearTimer;
  readonly #onCleanupError: ((error: unknown) => void) | undefined;

  #timer: TimerHandle | null = null;
  #started = false;
  #running = false;

  constructor(input: Readonly<{
    cleanupExpiredRecordings: BrowserRecordingRetentionCleanupRunner['cleanupExpiredRecordings'];
    nowMs?: () => number;
    intervalMs?: number;
    setTimeout?: SetTimer;
    clearTimeout?: ClearTimer;
    onCleanupError?: (error: unknown) => void;
  }>) {
    this.#cleanupExpiredRecordings = input.cleanupExpiredRecordings;
    this.#nowMs = input.nowMs ?? (() => Date.now());
    this.#intervalMs = Math.max(1, Math.trunc(input.intervalMs ?? 60_000));
    this.#setTimeout = input.setTimeout ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.#clearTimeout = input.clearTimeout ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.#onCleanupError = input.onCleanupError;
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.#scheduleNext();
  }

  stop(): void {
    this.#started = false;
    if (this.#timer === null) return;
    this.#clearTimeout(this.#timer);
    this.#timer = null;
  }

  async runOnce(): Promise<BrowserRecordingRetentionCleanupRunResult> {
    if (this.#running) {
      return {
        status: 'skipped',
        reason: 'cleanup_already_running',
      };
    }

    this.#running = true;
    try {
      const result = await this.#cleanupExpiredRecordings({ nowMs: this.#nowMs() });
      return {
        status: 'cleaned',
        discardedRecordingIds: result.discardedRecordingIds,
        failedRecordingIds: result.failedRecordingIds,
      };
    } catch (error) {
      this.#onCleanupError?.(error);
      return { status: 'failed', error };
    } finally {
      this.#running = false;
    }
  }

  #scheduleNext(): void {
    if (!this.#started || this.#timer !== null) return;
    this.#timer = this.#setTimeout(() => {
      this.#timer = null;
      void this.runOnce().finally(() => {
        this.#scheduleNext();
      });
    }, this.#intervalMs);
  }
}
