import type { FastifyInstance, FastifyRequest } from 'fastify';
import { readUnexpectedActionErrorDiagnosticV1 } from '@happier-dev/protocol/actions/actionExecutionResult';

type RequestTiming = Readonly<{
  receivedAtMs: number;
  route: string;
  failure?: ReturnType<typeof readUnexpectedActionErrorDiagnosticV1>;
}>;

function readSafeRoute(request: FastifyRequest): string {
  return request.routeOptions.url || '<unmatched>';
}

export function registerDaemonControlRequestTiming(
  app: FastifyInstance,
  input: Readonly<{
    debug: (message: string, data: Readonly<Record<string, unknown>>) => void;
    warn?: (message: string, data: Readonly<Record<string, unknown>>) => void;
    nowMs?: () => number;
  }>,
): void {
  const nowMs = input.nowMs ?? (() => performance.now());
  const timings = new WeakMap<FastifyRequest, RequestTiming>();

  app.addHook('onRequest', async (request) => {
    const route = readSafeRoute(request);
    timings.set(request, { receivedAtMs: nowMs(), route });
  });

  app.addHook('onError', async (request, _reply, error) => {
    const timing = timings.get(request);
    if (timing) timings.set(request, { ...timing, failure: readUnexpectedActionErrorDiagnosticV1(error) });
  });

  app.addHook('onResponse', async (request, reply) => {
    const timing = timings.get(request);
    if (!timing) return;
    timings.delete(request);
    if (timing.route === '/ping' && reply.statusCode < 400) return;
    // Discovery probes are debug noise; actual route refusals and server
    // failures remain visible through the existing file-log level owner.
    const log = reply.statusCode >= 500 || reply.statusCode >= 400 && timing.route !== '<unmatched>'
      ? input.warn ?? input.debug : input.debug;
    log('[CONTROL SERVER] Request completed', {
      requestId: request.id,
      method: request.method,
      route: timing.route,
      statusCode: reply.statusCode,
      durationMs: Math.max(0, Math.round(nowMs() - timing.receivedAtMs)),
      ...(reply.statusCode >= 500 ? timing.failure : {}),
    });
  });
}
