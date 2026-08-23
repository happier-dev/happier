import { Buffer } from 'node:buffer';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import {
  EXTERNAL_ACTION_HTTP_BODY_LIMIT_BYTES,
  projectExternalActionHttpErrorV1,
  type ExternalActionHttpErrorCodeV1,
} from '@happier-dev/protocol/actions';

import type { DaemonPatVerifier } from '../auth/daemonPatVerifier';
import {
  executeExternalAction,
  type ExternalActionExecutor,
  type ResolveExternalActionTarget,
} from './executeExternalAction';

type ExternalActionRouteParams = Readonly<{
  actionId: string;
}>;

function readBearerAuthorization(value: string | string[] | undefined): string | null {
  if (typeof value !== 'string') return null;
  const match = /^Bearer ([^\s]+)$/.exec(value);
  return match ? match[1] : null;
}

function sendExternalActionJson(reply: FastifyReply, statusCode: number, payload: unknown): FastifyReply {
  const body = JSON.stringify(payload);
  const bytes = Buffer.byteLength(body, 'utf8');
  return reply
    .code(statusCode)
    .header('cache-control', 'no-store')
    .header('content-type', 'application/json; charset=utf-8')
    .header('content-length', String(bytes))
    .send(body);
}

function sendExternalActionHttpError(
  reply: FastifyReply,
  code: ExternalActionHttpErrorCodeV1,
): FastifyReply {
  const error = projectExternalActionHttpErrorV1(code);
  return sendExternalActionJson(reply, error.statusCode, error.payload);
}

function isFastifyBodyLimitError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === 'FST_ERR_CTP_BODY_TOO_LARGE';
}

function createRequestLifetime(
  request: FastifyRequest,
  reply: FastifyReply,
): Readonly<{ signal: AbortSignal; dispose: () => void }> {
  const controller = new AbortController();
  const abort = (): void => {
    if (!controller.signal.aborted) {
      controller.abort(new Error('External Action request ended'));
    }
  };
  const abortIfResponseDidNotFinish = (): void => {
    if (!reply.raw.writableEnded) abort();
  };
  request.raw.once('aborted', abort);
  reply.raw.once('close', abortIfResponseDidNotFinish);
  if (request.raw.aborted) abort();
  return {
    signal: controller.signal,
    dispose: () => {
      request.raw.removeListener('aborted', abort);
      reply.raw.removeListener('close', abortIfResponseDidNotFinish);
    },
  };
}

/**
 * Registers the daemon's public Action ingress. It is deliberately disjoint
 * from private control-token routes: only a verified Account PAT can enter.
 */
export function registerDaemonExternalActionRoute(
  app: FastifyInstance,
  input: Readonly<{
    currentMachineId: string;
    currentServerId: string;
    verifyPat: DaemonPatVerifier;
    executor: ExternalActionExecutor;
    resolveTarget: ResolveExternalActionTarget;
  }>,
): void {
  if (!input.currentMachineId.trim()) {
    throw new Error('Daemon external Action route requires a current machine ID');
  }
  if (!input.currentServerId.trim()) {
    throw new Error('Daemon external Action route requires a current server ID');
  }

  // The daemon control listener does not register a global CORS hook. This
  // explicit shadow keeps public Action preflight fail-closed without adding a
  // route-local config field that this Fastify context does not support.
  app.options('/v1/actions/:actionId', async (_request, reply) => reply.code(404).send());

  app.post<{
    Params: ExternalActionRouteParams;
    Body: unknown;
  }>('/v1/actions/:actionId', {
    bodyLimit: EXTERNAL_ACTION_HTTP_BODY_LIMIT_BYTES,
    errorHandler: (error, _request, reply) => {
      if (isFastifyBodyLimitError(error)) {
        sendExternalActionHttpError(reply, 'request_too_large');
        return;
      }
      throw error;
    },
  }, async (request, reply) => {
    const lifetime = createRequestLifetime(request, reply);
    try {
      const token = readBearerAuthorization(request.headers.authorization);
      if (!token) {
        return sendExternalActionJson(reply, 401, { error: 'invalid_token' });
      }

      const principal = await input.verifyPat(token, lifetime.signal);
      if (!principal.ok) {
        return sendExternalActionJson(
          reply,
          principal.code === 'invalid_token' ? 401 : 503,
          { error: principal.code },
        );
      }

      const result = await executeExternalAction({
        actionId: request.params.actionId,
        envelope: request.body,
        principal,
        currentMachineId: input.currentMachineId,
        currentServerId: input.currentServerId,
        resolveTarget: input.resolveTarget,
        executor: input.executor,
        signal: lifetime.signal,
      });
      if (result.kind === 'invalid_request') {
        return sendExternalActionHttpError(reply, result.errorCode);
      }
      return sendExternalActionJson(reply, 200, result.response);
    } finally {
      lifetime.dispose();
    }
  });
}
