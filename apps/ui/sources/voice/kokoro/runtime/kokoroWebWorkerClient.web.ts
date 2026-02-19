type KokoroWorkerRuntimeConfig = {
  modelId: string;
  dtype: string;
  device: string;
  wasmPaths: string;
};

type WorkerRequest =
  | {
      id: string;
      type: 'prepare';
      cfg: KokoroWorkerRuntimeConfig;
    }
  | {
      id: string;
      type: 'generate';
      cfg: KokoroWorkerRuntimeConfig;
      text: string;
      voiceId: string;
      speed: number;
    }
  | {
      id: string;
      type: 'stream';
      cfg: KokoroWorkerRuntimeConfig;
      text: string;
      voiceId: string;
      speed: number;
    }
  | {
      id: string;
      type: 'cancel';
    };

type WorkerResponse =
  | {
      id: string;
      type: 'progress';
      progress: unknown;
    }
  | {
      id: string;
      type: 'result';
      wavBytes: ArrayBuffer;
    }
  | {
      id: string;
      type: 'stream_chunk';
      wavBytes: ArrayBuffer;
      sentenceText: string;
    }
  | {
      id: string;
      type: 'stream_end';
    }
  | {
      id: string;
      type: 'error';
      message: string;
    };

type PendingRequest = {
  resolve: (value: any) => void;
  reject: (error: unknown) => void;
  onProgress?: (progress: unknown) => void;
  touchTimeout?: () => void;
};

type PendingStream = {
  queue: Array<{ wavBytes: ArrayBuffer; sentenceText: string }>;
  ended: boolean;
  error: Error | null;
  wake?: () => void;
  touchTimeout?: () => void;
};

function randomId(): string {
  // Safe-enough ID to correlate responses in a single page session.
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

let cachedWorker: Worker | null = null;
let pendingById: Map<string, PendingRequest> | null = null;
let pendingStreamsById: Map<string, PendingStream> | null = null;

function getWorkerOriginHref(): string {
  return (
    (globalThis as any)?.location?.href ??
    (globalThis as any)?.window?.location?.href ??
    'http://localhost/'
  );
}

function getKokoroWorkerUrl(): string {
  const href = getWorkerOriginHref();
  let origin = 'http://localhost/';
  try {
    origin = new URL(href).origin;
  } catch {
    // ignore
  }
  return new URL('/vendor/kokoro/kokoroTtsWorker.js', origin).toString();
}

function rejectAllPending(err: Error) {
  const pending = pendingById;
  if (pending) {
    for (const [, p] of pending.entries()) {
      try {
        p.reject(err);
      } catch {
        // ignore
      }
    }
    pending.clear();
  }

  const streams = pendingStreamsById;
  if (streams) {
    for (const [, s] of streams.entries()) {
      s.error = err;
      s.wake?.();
    }
    streams.clear();
  }
}

function ensureWorker(): Worker {
  if (cachedWorker) return cachedWorker;
  if (typeof (globalThis as any).Worker !== 'function') {
    throw new Error('worker_not_supported');
  }

  const url = getKokoroWorkerUrl();
  let worker: Worker;
  try {
    worker = new (globalThis as any).Worker(url, { type: 'module' });
  } catch (err) {
    throw new Error(`worker_create_failed:${String((err as any)?.message ?? err)}`);
  }

  pendingById = new Map();
  pendingStreamsById = new Map();

  worker.onerror = (event: any) => {
    const msg = String(event?.message ?? event?.error?.message ?? 'worker_error');
    rejectAllPending(new Error(`worker_load_failed:${msg}`));
    try {
      worker.terminate?.();
    } catch {
      // ignore
    }
    cachedWorker = null;
  };

  worker.onmessage = (event: MessageEvent) => {
    const data = (event as any)?.data as WorkerResponse;
    if (!data || typeof data !== 'object' || typeof (data as any).id !== 'string') return;

    if (data.type === 'progress') {
      const pending = pendingById?.get(data.id);
      pending?.touchTimeout?.();
      pending?.onProgress?.(data.progress);
      return;
    }

    if (data.type === 'stream_chunk') {
      const stream = pendingStreamsById?.get(data.id);
      if (!stream) return;
      stream.touchTimeout?.();
      stream.queue.push({ wavBytes: data.wavBytes, sentenceText: data.sentenceText });
      stream.wake?.();
      return;
    }

    if (data.type === 'stream_end') {
      const stream = pendingStreamsById?.get(data.id);
      if (!stream) return;
      stream.touchTimeout?.();
      stream.ended = true;
      stream.wake?.();
      return;
    }

    const pending = pendingById?.get(data.id);
    if (!pending) return;

    if (data.type === 'error') {
      pending.reject(new Error(data.message || 'worker_error'));
      return;
    }
    if (data.type === 'result') {
      pending.resolve(data.wavBytes);
    }
  };

  cachedWorker = worker;
  return worker;
}

function postRequest<T>(message: WorkerRequest, opts: { timeoutMs: number; signal: AbortSignal; onProgress?: (p: unknown) => void }): Promise<T> {
  const worker = ensureWorker();

  if (opts.signal.aborted) {
    return Promise.reject(new Error('aborted'));
  }

  return new Promise<T>((resolve, reject) => {
    const id = (message as any).id;
    if (typeof id !== 'string' || id.length === 0) {
      reject(new Error('invalid_request'));
      return;
    }

    let settled = false;
    const settle = (fn: (value: any) => void, value: any) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    };

    const cancel = () => {
      try {
        worker.postMessage({ id, type: 'cancel' } satisfies WorkerRequest);
      } catch {
        // ignore
      }
    };

    const onAbort = () => {
      cancel();
      settle(reject, new Error('aborted'));
    };

    let timeout: any = null;
    const armTimeout = () => {
      try {
        if (timeout) clearTimeout(timeout);
      } catch {
        // ignore
      }
      timeout = setTimeout(() => {
        cancel();
        settle(reject, new Error('timeout'));
      }, opts.timeoutMs);
      (timeout as any)?.unref?.();
    };
    armTimeout();

    const cleanup = () => {
      try {
        if (timeout) clearTimeout(timeout);
      } catch {
        // ignore
      }
      try {
        opts.signal.removeEventListener('abort', onAbort);
      } catch {
        // ignore
      }
      pendingById?.delete(id);
    };

    opts.signal.addEventListener('abort', onAbort);
    pendingById?.set(id, {
      resolve: (value) => settle(resolve, value),
      reject: (error) => settle(reject, error),
      onProgress: opts.onProgress,
      touchTimeout: armTimeout,
    });

    try {
      worker.postMessage(message);
    } catch (err) {
      cancel();
      settle(reject, err);
    }
  });
}

export async function prepareKokoroTtsInWorker(opts: {
  cfg: KokoroWorkerRuntimeConfig;
  timeoutMs: number;
  signal: AbortSignal;
  onProgress?: (progress: unknown) => void;
}): Promise<void> {
  const id = randomId();
  await postRequest<void>(
    { id, type: 'prepare', cfg: opts.cfg },
    { timeoutMs: opts.timeoutMs, signal: opts.signal, onProgress: opts.onProgress },
  );
}

export async function synthesizeKokoroWavInWorker(opts: {
  cfg: KokoroWorkerRuntimeConfig;
  text: string;
  voiceId: string;
  speed: number;
  timeoutMs: number;
  signal: AbortSignal;
}): Promise<ArrayBuffer> {
  const id = randomId();
  return await postRequest<ArrayBuffer>(
    { id, type: 'generate', cfg: opts.cfg, text: opts.text, voiceId: opts.voiceId, speed: opts.speed },
    { timeoutMs: opts.timeoutMs, signal: opts.signal },
  );
}

export function streamKokoroWavSentencesInWorker(opts: {
  cfg: KokoroWorkerRuntimeConfig;
  text: string;
  voiceId: string;
  speed: number;
  timeoutMs: number;
  signal: AbortSignal;
}): AsyncIterable<{ wavBytes: ArrayBuffer; sentenceText: string }> {
  const id = randomId();
  const worker = ensureWorker();
  const stream: PendingStream = { queue: [], ended: false, error: null };
  pendingStreamsById?.set(id, stream);

  const cancel = () => {
    try {
      worker.postMessage({ id, type: 'cancel' } satisfies WorkerRequest);
    } catch {
      // ignore
    }
    pendingStreamsById?.delete(id);
  };

  if (opts.signal.aborted) {
    cancel();
    return {
      async *[Symbol.asyncIterator]() {},
    };
  }

  const onAbort = () => {
    cancel();
    stream.error = new Error('aborted');
    stream.wake?.();
  };
  opts.signal.addEventListener('abort', onAbort);

  let timeout: any = null;
  const armTimeout = () => {
    try {
      if (timeout) clearTimeout(timeout);
    } catch {
      // ignore
    }
    timeout = setTimeout(() => {
      cancel();
      stream.error = new Error('timeout');
      stream.wake?.();
    }, opts.timeoutMs);
    (timeout as any)?.unref?.();
  };
  stream.touchTimeout = armTimeout;
  armTimeout();

  try {
    worker.postMessage({ id, type: 'stream', cfg: opts.cfg, text: opts.text, voiceId: opts.voiceId, speed: opts.speed } satisfies WorkerRequest);
  } catch (err) {
    cancel();
    stream.error = err instanceof Error ? err : new Error(String(err));
    stream.wake?.();
  }

  const iterable: AsyncIterable<{ wavBytes: ArrayBuffer; sentenceText: string }> = {
    async *[Symbol.asyncIterator]() {
      try {
        while (true) {
          if (stream.error) throw stream.error;
          const next = stream.queue.shift();
          if (next) {
            yield next;
            continue;
          }
          if (stream.ended) break;
          await new Promise<void>((resolve) => {
            stream.wake = resolve;
          });
          stream.wake = undefined;
        }
      } finally {
        try {
          if (timeout) clearTimeout(timeout);
        } catch {
          // ignore
        }
        try {
          opts.signal.removeEventListener('abort', onAbort);
        } catch {
          // ignore
        }
        stream.touchTimeout = undefined;
        pendingStreamsById?.delete(id);
      }
    },
  };

  return iterable;
}
