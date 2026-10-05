import type { FastifyReply, FastifyRequest } from 'fastify';

/** The caller's connection owns cancellation; operation owners retain their own deadlines. */
export function createDaemonControlRequestLifetime(request: FastifyRequest, reply: FastifyReply): Readonly<{
  signal: AbortSignal;
  run<T>(operation: () => Promise<T>): Promise<T>;
  dispose(): void;
}> {
  const controller = new AbortController();
  const signal = controller.signal;
  const abort = () => controller.abort(new Error('Daemon control request ended'));
  const abortIfResponseDidNotFinish = () => {
    if (!reply.raw.writableEnded) abort();
  };
  request.raw.once('aborted', abort);
  reply.raw.once('close', abortIfResponseDidNotFinish);
  if (request.raw.aborted || (reply.raw.destroyed && !reply.raw.writableEnded)) abort();
  return {
    signal,
    // Shared policy refreshes must continue for other callers. Stop this waiter
    // even if its operation cannot cooperatively consume the request signal.
    run<T>(operation: () => Promise<T>): Promise<T> {
      signal.throwIfAborted();
      return new Promise<T>((resolve, reject) => {
        const remove = () => signal.removeEventListener('abort', cancelled);
        const cancelled = () => { remove(); reject(signal.reason); };
        signal.addEventListener('abort', cancelled, { once: true });
        Promise.resolve().then(() => { signal.throwIfAborted(); return operation(); }).then(
          (value) => { remove(); resolve(value); },
          (error: unknown) => { remove(); reject(error); },
        );
      });
    },
    dispose: () => {
      request.raw.removeListener('aborted', abort);
      reply.raw.removeListener('close', abortIfResponseDidNotFinish);
    },
  };
}
