/**
 * Provider-owned ingress ordering. Discord messages for one endpoint retain
 * arrival order, while unrelated endpoints can consume the bounded global
 * pool independently. This does not replace Channels admission/currentness.
 */

export type DiscordIngressSchedulerOptions = Readonly<{
  maxConcurrent: number;
  maxQueuedPerKey: number;
  maxQueuedTotal: number;
}>;

export type DiscordIngressTask<T> = Readonly<{
  connectionId: string;
  endpointId: string;
  signal?: AbortSignal;
  run(signal?: AbortSignal): Promise<T> | T;
}>;

export interface DiscordIngressScheduler {
  schedule<T>(task: DiscordIngressTask<T>): Promise<T>;
}

export class DiscordIngressBackpressureError extends Error {
  readonly scope: 'lane' | 'global';

  constructor(scope: 'lane' | 'global') {
    super(`Discord ingress ${scope} queue is full.`);
    this.name = 'DiscordIngressBackpressureError';
    this.scope = scope;
  }
}

export class DiscordIngressCancelledError extends Error {
  constructor() {
    super('Discord ingress work was cancelled before it started.');
    this.name = 'DiscordIngressCancelledError';
  }
}

type QueuedTask = Readonly<{
  start(onFinished: () => void): void;
  cancel(): void;
  attachAbortListener(listener: () => void): void;
  detachAbortListener(): void;
}>;

type Lane = {
  running: boolean;
  queued: QueuedTask[];
};

function requirePositiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer.`);
  }
  return value;
}

function requireIdentifier(value: string, name: string): string {
  if (!value.trim()) throw new Error(`${name} is required.`);
  return value;
}

function keyFor(connectionId: string, endpointId: string): string {
  return JSON.stringify([connectionId, endpointId]);
}

function makeQueuedTask<T>(input: DiscordIngressTask<T>): Readonly<{
  promise: Promise<T>;
  task: QueuedTask;
}> {
  let abortListener: (() => void) | undefined;
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  let rejectPromise!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });

  const detachAbortListener = (): void => {
    if (!abortListener || !input.signal) return;
    input.signal.removeEventListener('abort', abortListener);
    abortListener = undefined;
  };
  const task: QueuedTask = {
    start(onFinished) {
      detachAbortListener();
      if (input.signal?.aborted) {
        rejectPromise(new DiscordIngressCancelledError());
        onFinished();
        return;
      }
      try {
        void Promise.resolve(input.run(input.signal)).then(
          (value) => {
            resolvePromise(value);
            onFinished();
          },
          (error: unknown) => {
            rejectPromise(error);
            onFinished();
          },
        );
      } catch (error) {
        rejectPromise(error);
        onFinished();
      }
    },
    cancel() {
      detachAbortListener();
      rejectPromise(new DiscordIngressCancelledError());
    },
    attachAbortListener(listener) {
      abortListener = listener;
      input.signal?.addEventListener('abort', listener, { once: true });
    },
    detachAbortListener,
  };
  return { promise, task };
}

export function createDiscordIngressScheduler(options: DiscordIngressSchedulerOptions): DiscordIngressScheduler {
  const maxConcurrent = requirePositiveSafeInteger(options.maxConcurrent, 'maxConcurrent');
  const maxQueuedPerKey = requirePositiveSafeInteger(options.maxQueuedPerKey, 'maxQueuedPerKey');
  const maxQueuedTotal = requirePositiveSafeInteger(options.maxQueuedTotal, 'maxQueuedTotal');
  const lanes = new Map<string, Lane>();
  let activeCount = 0;
  let queuedCount = 0;
  let draining = false;

  const removeIdleLane = (key: string, lane: Lane): void => {
    if (!lane.running && lane.queued.length === 0) lanes.delete(key);
  };

  const cancelQueuedTask = (key: string, lane: Lane, task: QueuedTask): void => {
    const index = lane.queued.indexOf(task);
    if (index === -1) return;
    lane.queued.splice(index, 1);
    queuedCount -= 1;
    task.cancel();
    removeIdleLane(key, lane);
    drain();
  };

  const launch = (key: string, lane: Lane): void => {
    const task = lane.queued.shift();
    if (!task) return;
    queuedCount -= 1;
    activeCount += 1;
    lane.running = true;
    task.detachAbortListener();
    task.start(() => {
      activeCount -= 1;
      lane.running = false;
      removeIdleLane(key, lane);
      drain();
    });
  };

  const drain = (): void => {
    if (draining) return;
    draining = true;
    try {
      while (activeCount < maxConcurrent) {
        const next = [...lanes.entries()].find(([, lane]) => !lane.running && lane.queued.length > 0);
        if (!next) return;
        launch(next[0], next[1]);
      }
    } finally {
      draining = false;
    }
  };

  return {
    schedule<T>(input: DiscordIngressTask<T>): Promise<T> {
      const connectionId = requireIdentifier(input.connectionId, 'Discord connection ID');
      const endpointId = requireIdentifier(input.endpointId, 'Discord endpoint ID');
      if (input.signal?.aborted) return Promise.reject(new DiscordIngressCancelledError());

      const key = keyFor(connectionId, endpointId);
      const lane = lanes.get(key) ?? { running: false, queued: [] };
      if (lane.queued.length >= maxQueuedPerKey) {
        return Promise.reject(new DiscordIngressBackpressureError('lane'));
      }
      if (queuedCount >= maxQueuedTotal) {
        return Promise.reject(new DiscordIngressBackpressureError('global'));
      }

      const { promise, task } = makeQueuedTask(input);
      lane.queued.push(task);
      queuedCount += 1;
      lanes.set(key, lane);
      if (input.signal) {
        task.attachAbortListener(() => cancelQueuedTask(key, lane, task));
      }
      drain();
      return promise;
    },
  };
}
