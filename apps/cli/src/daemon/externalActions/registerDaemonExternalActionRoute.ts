import { Buffer } from 'node:buffer';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import {
  EXTERNAL_ACTION_HTTP_BODY_LIMIT_BYTES,
  projectExternalActionHttpErrorV1,
  serializeExternalActionResponseEnvelopeV1,
  type ExternalActionHttpErrorCodeV1,
} from '@happier-dev/protocol/actions';

import type { DaemonPatVerifier, VerifiedDaemonPat } from '../auth/daemonPatVerifier';
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
  return sendExternalActionSerializedJson(reply, statusCode, body, bytes);
}

function sendExternalActionSerializedJson(
  reply: FastifyReply,
  statusCode: number,
  body: string,
  bytes: number,
): FastifyReply {
  return reply
    .code(statusCode)
    .header('cache-control', 'no-store')
    .header('content-type', 'application/json; charset=utf-8')
    .header('content-length', String(bytes))
    .send(body);
}

function sendExternalActionResponse(reply: FastifyReply, payload: unknown): FastifyReply {
  const serialized = serializeExternalActionResponseEnvelopeV1(payload);
  return sendExternalActionSerializedJson(reply, 200, serialized.body, serialized.byteLength);
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

function isFastifyExternalActionBodyParseError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (
      error.code === 'FST_ERR_CTP_INVALID_JSON_BODY'
      || error.code === 'FST_ERR_CTP_EMPTY_JSON_BODY'
      || error.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE'
    );
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

const externalActionRequestAdmission = Symbol('externalActionRequestAdmission');

type ExternalActionRequestAdmission = Readonly<{
  principal: VerifiedDaemonPat;
  lifetime: ReturnType<typeof createRequestLifetime>;
}>;

type ExternalActionAdmittedRequest = FastifyRequest & {
  [externalActionRequestAdmission]?: ExternalActionRequestAdmission;
};

function readExternalActionRequestAdmission(
  request: FastifyRequest,
): ExternalActionRequestAdmission | undefined {
  return (request as ExternalActionAdmittedRequest)[externalActionRequestAdmission];
}

function disposeExternalActionRequestAdmission(request: FastifyRequest): void {
  const admitted = request as ExternalActionAdmittedRequest;
  const admission = admitted[externalActionRequestAdmission];
  if (!admission) return;
  delete admitted[externalActionRequestAdmission];
  admission.lifetime.dispose();
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
  app.options('/v1/actions/:actionId', async (_request, reply) => reply.header('cache-control', 'no-store').code(404).send());

  app.post<{
    Params: ExternalActionRouteParams;
    Body: unknown;
  }>('/v1/actions/:actionId', {
    bodyLimit: EXTERNAL_ACTION_HTTP_BODY_LIMIT_BYTES,
    errorHandler: (error, request, reply) => {
      disposeExternalActionRequestAdmission(request);
      if (isFastifyBodyLimitError(error)) {
        sendExternalActionHttpError(reply, 'request_too_large');
        return;
      }
      if (isFastifyExternalActionBodyParseError(error)) {
        sendExternalActionHttpError(reply, 'invalid_envelope');
        return;
      }
      throw error;
    },
    onRequest: async (request, reply) => {
      const lifetime = createRequestLifetime(request, reply);
      const token = readBearerAuthorization(request.headers.authorization);
      if (!token) {
        lifetime.dispose();
        return sendExternalActionJson(reply, 401, { error: 'invalid_token' });
      }

      try {
        const principal = await input.verifyPat(token, lifetime.signal);
        if (!principal.ok) {
          lifetime.dispose();
          return sendExternalActionJson(
            reply,
            principal.code === 'invalid_token' ? 401 : 503,
            { error: principal.code },
          );
        }
        (request as ExternalActionAdmittedRequest)[externalActionRequestAdmission] = {
          principal,
          lifetime,
        };
      } catch (error) {
        lifetime.dispose();
        throw error;
      }
    },
  }, async (request, reply) => {
    const admission = readExternalActionRequestAdmission(request);
    if (!admission) {
      return sendExternalActionJson(reply, 401, { error: 'invalid_token' });
    }
    try {
      const result = await executeExternalAction({
        actionId: request.params.actionId,
        envelope: request.body,
        principal: admission.principal,
        currentMachineId: input.currentMachineId,
        currentServerId: input.currentServerId,
        resolveTarget: input.resolveTarget,
        executor: input.executor,
        signal: admission.lifetime.signal,
      });
      if (result.kind === 'invalid_request') {
        return sendExternalActionHttpError(reply, result.errorCode);
      }
      return sendExternalActionResponse(reply, result.response);
    } finally {
      disposeExternalActionRequestAdmission(request);
    }
  });
}
