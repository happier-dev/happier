import { Buffer } from 'node:buffer';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ExternalActionAuthorizationHttpResult } from '@/api/externalActionAuthorizationHttp';
import type { MachineAvailabilityDiagnosticV1 } from '@happier-dev/protocol/machines/machineAccessV1';
import type { ActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { createDaemonControlRequestLifetime as createRequestLifetime } from '../controlRequestLifetime';

import { ACCOUNT_API_TOKEN_ENCRYPTION_ACCESS_HTTP_PATH_V1, AccountApiTokenEncryptionAccessRequestV1Schema, parseAccountApiTokenBearerV1 } from '@happier-dev/protocol/auth/accountApiTokens';
import { ExternalActionRequestEnvelopeSchema } from '@happier-dev/protocol/actions/externalActionApi';
import type { ExternalActionRequestEnvelope } from '@happier-dev/protocol';
import type { AccountServerPatEncryptionAccessReader } from '../auth/accountServerPatEncryptionAccess';
import { EXTERNAL_ACTION_HTTP_BODY_LIMIT_BYTES_V2, EXTERNAL_ACTION_HTTP_PATH_PREFIX_V1, projectExternalActionHttpError, readExternalActionProtectedRequestId } from '@happier-dev/protocol/actions/externalActionApi';
import type { ExternalActionHttpErrorCode, PreparedExternalActionResponseEnvelope } from '@happier-dev/protocol/actions';

import type { DaemonPatVerifier, VerifiedDaemonPat } from '../auth/daemonPatVerifier';
import {
  executeExternalAction,
  type ExternalActionExecutor,
  type ResolveExternalActionTarget,
  type ResolveExternalActionEncryption,
  type VerifyExternalActionExecutionAuthorization,
  type PrepareExternalActionRequesterAccountContext,
} from './executeExternalAction';

type ExternalActionRouteParams = Readonly<{
  actionId: string;
}>;

function readBearerAuthorization(value: string | string[] | undefined): string | null {
  if (typeof value !== 'string') return null;
  const match = /^Bearer ([^\s]+)$/.exec(value);
  const token = match?.[1];
  return token && parseAccountApiTokenBearerV1(token) !== null
    ? token
    : null;
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

function sendExternalActionResponse(
  reply: FastifyReply,
  prepared: PreparedExternalActionResponseEnvelope,
): FastifyReply {
  return sendExternalActionSerializedJson(reply, 200, prepared.body, prepared.byteLength);
}

function sendExternalActionHttpError(
  reply: FastifyReply,
  code: ExternalActionHttpErrorCode,
  requestId?: string,
  diagnostic?: MachineAvailabilityDiagnosticV1,
  failureCause?: ActionFailureCauseV1,
  origin?: Parameters<typeof projectExternalActionHttpError>[7],
): FastifyReply {
  const error = projectExternalActionHttpError(code, requestId, undefined, undefined, undefined, diagnostic, failureCause, origin);
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

const externalActionRequestAdmission = Symbol('externalActionRequestAdmission');

type ExternalActionRequestAdmission = Readonly<{
  token: string;
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
    currentServerHttpBaseUrl?: string;
    verifyPat: DaemonPatVerifier;
    executor: ExternalActionExecutor;
    invokeResource?: Parameters<typeof executeExternalAction>[0]['invokeResource'];
    acquirePluginRuntimeRegistryLease?: Parameters<typeof executeExternalAction>[0]['acquirePluginRuntimeRegistryLease'];
    resolvePluginExecutionOriginContext?: Parameters<typeof executeExternalAction>[0]['resolvePluginExecutionOriginContext'];
    resolveAccountPluginExecutionSelection?: Parameters<typeof executeExternalAction>[0]['resolveAccountPluginExecutionSelection'];
    /**
     * Retained as a source-compatible constructor seam for older embeddings.
     * PAT-bound executors are intentionally never selected: Home-bound work
     * requires the opaque execution authorization below.
     */
    resolvePatExecutor?: (input: Readonly<{
      token: string;
      principal: VerifiedDaemonPat;
    }>) => ExternalActionExecutor | Promise<ExternalActionExecutor>;
    mintExecutionAuthorization?: (input: Readonly<{
      actionId: string;
      envelope: ExternalActionRequestEnvelope;
      machineId: string;
      pat: string;
      signal?: AbortSignal;
    }>) => Promise<ExternalActionAuthorizationHttpResult>;
    externalActionMachineRequestPrivateKey?: string | Uint8Array;
    resolveInstallationId?: () => string | null;
    verifyExecutionAuthorization?: VerifyExternalActionExecutionAuthorization;
    resolveTarget: ResolveExternalActionTarget;
    resolveEncryption?: ResolveExternalActionEncryption;
    prepareRequesterAccountContext?: PrepareExternalActionRequesterAccountContext;
    readEncryptionAccess?: AccountServerPatEncryptionAccessReader;
  }>,
): void {
  if (!input.currentMachineId.trim()) {
    throw new Error('Daemon external Action route requires a current machine ID');
  }
  if (!input.currentServerId.trim()) {
    throw new Error('Daemon external Action route requires a current server ID');
  }

  app.post(ACCOUNT_API_TOKEN_ENCRYPTION_ACCESS_HTTP_PATH_V1, async (request, reply) => {
    if (!AccountApiTokenEncryptionAccessRequestV1Schema.safeParse(request.body).success) {
      return sendExternalActionJson(reply, 400, { error: 'invalid_request' });
    }
    const token = readBearerAuthorization(request.headers.authorization);
    if (!token) return sendExternalActionJson(reply, 401, { error: 'invalid_token' });
    const lifetime = createRequestLifetime(request, reply);
    try {
      const principal = await input.verifyPat(token, lifetime.signal);
      if (!principal.ok) return sendExternalActionJson(reply, principal.code === 'invalid_token' ? 401 : 503, { error: principal.code });
      if (!input.readEncryptionAccess) return sendExternalActionJson(reply, 409, { error: 'api_token_encryption_unavailable' });
      const result = await input.readEncryptionAccess(token, lifetime.signal);
      return sendExternalActionJson(reply, result.statusCode, result.body);
    } catch {
      return sendExternalActionJson(reply, 503, { error: 'auth_unavailable' });
    } finally { lifetime.dispose(); }
  });

  app.post<{
    Params: ExternalActionRouteParams;
    Body: unknown;
  }>(`${EXTERNAL_ACTION_HTTP_PATH_PREFIX_V1}:actionId`, {
    bodyLimit: EXTERNAL_ACTION_HTTP_BODY_LIMIT_BYTES_V2,
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
      sendExternalActionHttpError(reply, 'internal_error');
    },
    onRequest: async (request, reply) => {
      const lifetime = createRequestLifetime(request, reply);
      const token = readBearerAuthorization(request.headers.authorization);
      if (!token) {
        lifetime.dispose();
        return sendExternalActionHttpError(reply, 'invalid_token');
      }

      try {
        const principal = await input.verifyPat(token, lifetime.signal);
        if (!principal.ok) {
          lifetime.dispose();
          return sendExternalActionHttpError(reply, principal.code);
        }
        (request as ExternalActionAdmittedRequest)[externalActionRequestAdmission] = {
          token,
          principal,
          lifetime,
        };
      } catch {
        lifetime.dispose();
        return sendExternalActionHttpError(reply, 'auth_unavailable');
      }
    },
  }, async (request, reply) => {
    const admission = readExternalActionRequestAdmission(request);
    if (!admission) {
      return sendExternalActionHttpError(reply, 'invalid_token');
    }
    try {
      const envelope = ExternalActionRequestEnvelopeSchema.safeParse(request.body);
      const minted = envelope.success && input.mintExecutionAuthorization
        ? await input.mintExecutionAuthorization({
            actionId: request.params.actionId,
            envelope: envelope.data,
            machineId: input.currentMachineId,
            pat: admission.token,
            signal: admission.lifetime.signal,
          })
        : null;
      if (minted && !minted.ok && (minted.code === 'invalid_token' || minted.code === 'credential_scope_denied' || minted.code === 'present_user_required')) {
        const requestId = minted.requestId ?? (envelope.success ? envelope.data.requestId : undefined);
        if (minted.code === 'credential_scope_denied' && minted.details !== undefined) {
          const projected = projectExternalActionHttpError(minted.code, requestId,
            undefined, undefined, undefined, undefined, minted.failureCause);
          return sendExternalActionJson(reply, projected.statusCode, { ...projected.payload, details: minted.details });
        }
        return sendExternalActionHttpError(reply, minted.code, requestId, undefined, minted.failureCause);
      }
      if (minted && !minted.ok && minted.code === 'target_unavailable' && minted.diagnostic) {
        return sendExternalActionHttpError(reply, minted.code,
          minted.requestId ?? (envelope.success ? envelope.data.requestId : undefined), minted.diagnostic, minted.failureCause);
      }
      const installationId = input.resolveInstallationId?.();
      const verifyExecutionAuthorization = input.verifyExecutionAuthorization;
      const result = await executeExternalAction({
        actionId: request.params.actionId,
        envelope: request.body,
        principal: admission.principal,
        currentMachineId: input.currentMachineId,
        currentServerId: input.currentServerId,
        ...(input.currentServerHttpBaseUrl ? { currentServerHttpBaseUrl: input.currentServerHttpBaseUrl } : {}),
        ...(installationId ? {
          currentInstallationId: installationId,
          isInstallationCurrent: () => input.resolveInstallationId?.() === installationId,
        } : {}),
        ...(verifyExecutionAuthorization ? {
          verifyExecutionAuthorization: async (verification) => {
            const installationId = verification.authorization.binding.installationId;
            if (input.resolveInstallationId?.() !== installationId) return false;
            const current = await verifyExecutionAuthorization(verification);
            return current && input.resolveInstallationId?.() === installationId;
          },
        } : {}),
        resolveEncryption: input.resolveEncryption,
        prepareRequesterAccountContext: input.prepareRequesterAccountContext,
        resolveTarget: input.resolveTarget,
        executor: input.executor,
        invokeResource: input.invokeResource,
        acquirePluginRuntimeRegistryLease: input.acquirePluginRuntimeRegistryLease,
        resolvePluginExecutionOriginContext: input.resolvePluginExecutionOriginContext,
        resolveAccountPluginExecutionSelection: input.resolveAccountPluginExecutionSelection,
        ...(minted?.ok ? { executionAuthorization: minted.authorization } : {}),
        ...(input.externalActionMachineRequestPrivateKey
          ? { externalActionMachineRequestPrivateKey: input.externalActionMachineRequestPrivateKey }
          : {}),
        signal: admission.lifetime.signal,
      });
      if (result.kind === 'invalid_request') {
        return sendExternalActionHttpError(
          reply,
          result.errorCode,
          result.requestId ?? readExternalActionProtectedRequestId(request.body),
          undefined,
          result.failureCause,
          'daemon',
        );
      }
      return sendExternalActionResponse(reply, result.prepared);
    } finally {
      disposeExternalActionRequestAdmission(request);
    }
  });
}
