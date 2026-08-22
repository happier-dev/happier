import type { FastifyInstance, FastifyRequest } from 'fastify';

type RequestTiming = Readonly<{
  receivedAtMs: number;
  route: string;
}>;

function readSafeRoute(request: FastifyRequest): string {
  return request.routeOptions.url || '<unmatched>';
}

export function registerDaemonControlRequestTiming(
  app: FastifyInstance,
  input: Readonly<{
    debug: (message: string, data: Readonly<Record<string, unknown>>) => void;
    nowMs?: () => number;
  }>,
): void {
  const nowMs = input.nowMs ?? (() => performance.now());
  const timings = new WeakMap<FastifyRequest, RequestTiming>();

  app.addHook('onRequest', async (request) => {
    const route = readSafeRoute(request);
    timings.set(request, { receivedAtMs: nowMs(), route });
    input.debug('[CONTROL SERVER] Request received', {
      requestId: request.id,
      method: request.method,
      route,
    });
  });

  app.addHook('onResponse', async (request, reply) => {
    const timing = timings.get(request);
    if (!timing) return;
    timings.delete(request);
    input.debug('[CONTROL SERVER] Request completed', {
      requestId: request.id,
      method: request.method,
      route: timing.route,
      statusCode: reply.statusCode,
      durationMs: Math.max(0, Math.round(nowMs() - timing.receivedAtMs)),
    });
  });
}
