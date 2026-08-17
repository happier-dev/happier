/**
 * Discord limits Identify starts per application in five-second windows. This
 * small provider-local gate covers only that external protocol operation;
 * Gateway Dispatch admission continues through independent per-conversation
 * lanes.
 */
export type DiscordIdentifyPermit = Readonly<{
  /** Starts the non-releasable Discord five-second window once IDENTIFY is attempted. */
  commit(): void;
  /** Cancels a reservation before any IDENTIFY send attempt. */
  release(): void;
}>;

export type DiscordIdentifyConcurrency = Readonly<{
  acquire(input: Readonly<{
    applicationId: string;
    maxConcurrency: number;
    signal: AbortSignal;
  }>): Promise<DiscordIdentifyPermit>;
}>;

export type DiscordIdentifyConcurrencyLifecycle = DiscordIdentifyConcurrency & Readonly<{
  /** Waits for every attempted Identify window owned by this supervisor. */
  waitForCommittedWindows(): Promise<void>;
}>;

type Waiter = {
  signal: AbortSignal;
  resolve(permit: DiscordIdentifyPermit): void;
  reject(error: unknown): void;
  removeAbortListener(): void;
};

type ApplicationQueue = {
  active: number;
  waiting: Waiter[];
};

const DISCORD_IDENTIFY_WINDOW_MS = 5_000;

function requireApplicationId(applicationId: string): string {
  const normalized = applicationId.trim();
  if (!normalized) throw new Error('Discord application ID is required for Identify concurrency.');
  return normalized;
}

function requireMaxConcurrency(maxConcurrency: number): void {
  if (!Number.isSafeInteger(maxConcurrency) || maxConcurrency <= 0) {
    throw new Error('Discord Identify max concurrency must be a positive safe integer.');
  }
}

export function createDiscordIdentifyConcurrency(): DiscordIdentifyConcurrencyLifecycle {
  const applications = new Map<string, ApplicationQueue>();
  const committedWindows = new Set<Promise<void>>();

  const removeIdleQueue = (applicationId: string, queue: ApplicationQueue): void => {
    if (queue.active === 0 && queue.waiting.length === 0) applications.delete(applicationId);
  };

  const drain = (applicationId: string, queue: ApplicationQueue): void => {
    while (queue.waiting.length > 0) {
      const next = queue.waiting[0]!;
      if (next.signal.aborted) {
        queue.waiting.shift();
        next.removeAbortListener();
        next.reject(next.signal.reason ?? new Error('Discord Identify was cancelled.'));
        continue;
      }
      // C7 opens only unsharded Gateway sessions, so every Identify has
      // `shard_id = 0` and therefore shares Discord's bucket zero regardless
      // of Gateway Bot's aggregate max_concurrency value.
      if (queue.active > 0) break;
      queue.waiting.shift();
      queue.active += 1;
      next.removeAbortListener();
      let held = true;
      let committed = false;
      const releaseSlot = (): void => {
        if (!held) return;
        held = false;
        queue.active -= 1;
        drain(applicationId, queue);
        removeIdleQueue(applicationId, queue);
      };
      next.resolve(Object.freeze({
        commit() {
          if (!held || committed) return;
          committed = true;
          let settleWindow!: () => void;
          const window = new Promise<void>((resolve) => { settleWindow = resolve; });
          committedWindows.add(window);
          const settle = (): void => {
            releaseSlot();
            committedWindows.delete(window);
            settleWindow();
          };
          const timer = globalThis.setTimeout(settle, DISCORD_IDENTIFY_WINDOW_MS);
          if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
            (timer as Readonly<{ unref?: () => void }>).unref?.();
          }
        },
        release() {
          if (committed) return;
          releaseSlot();
        },
      }));
    }
    removeIdleQueue(applicationId, queue);
  };

  return Object.freeze({
    async acquire(input) {
      const applicationId = requireApplicationId(input.applicationId);
      requireMaxConcurrency(input.maxConcurrency);
      if (input.signal.aborted) {
        throw input.signal.reason ?? new Error('Discord Identify was cancelled.');
      }
      const queue = applications.get(applicationId) ?? { active: 0, waiting: [] };
      applications.set(applicationId, queue);
      return await new Promise<DiscordIdentifyPermit>((resolve, reject) => {
        const waiter: Waiter = {
          signal: input.signal,
          resolve,
          reject,
          removeAbortListener: () => input.signal.removeEventListener('abort', onAbort),
        };
        const onAbort = (): void => {
          const index = queue.waiting.indexOf(waiter);
          if (index === -1) return;
          queue.waiting.splice(index, 1);
          waiter.removeAbortListener();
          reject(input.signal.reason ?? new Error('Discord Identify was cancelled.'));
          removeIdleQueue(applicationId, queue);
        };
        input.signal.addEventListener('abort', onAbort, { once: true });
        queue.waiting.push(waiter);
        drain(applicationId, queue);
      });
    },
    async waitForCommittedWindows() {
      while (committedWindows.size > 0) {
        await Promise.all([...committedWindows]);
      }
    },
  });
}
