import {
  SessionConnectedServiceAuthApplyGenerationResponseV1Schema,
  SessionConnectedServiceAuthInvalidateTransportsResponseV1Schema,
  SessionConnectedServiceAuthReadRuntimeIdentityResponseV1Schema,
} from '@happier-dev/protocol';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import type {
  SessionConnectedServiceAuthApplyGenerationRequestV1,
  SessionConnectedServiceAuthApplyGenerationResponseV1,
  SessionConnectedServiceAuthReadRuntimeIdentityRequestV1,
  SessionConnectedServiceAuthReadRuntimeIdentityResponseV1,
} from '@happier-dev/protocol';

import type { StoredCredentials } from '@/persistence';
import { resolveSessionTransportContext } from '@/session/services/resolveSessionTransportContext';
import type { SessionEncryptionContext } from '@/session/transport/encryption/sessionEncryptionContext';
import { callSessionRpc } from '@/session/transport/rpc/sessionRpc';

type ResolvedTransport = Awaited<ReturnType<typeof resolveSessionTransportContext>>;

export type SessionConnectedServiceAuthTransportResult<T> =
  | Readonly<{
      ok: true;
      value: T;
      diagnostics?: readonly Readonly<{ code: string }>[];
    }>
  | Readonly<{
      ok: false;
      code: string;
      error: string;
      retryable?: boolean;
      diagnostics?: readonly Readonly<{ code: string }>[];
    }>;

export type SessionConnectedServiceAuthTransportOptions = Readonly<{
  signal?: AbortSignal;
}>;

export type SessionConnectedServiceAuthTransport = Readonly<{
  checkConnectedServiceAuthTransportInvalidation: (
    options?: SessionConnectedServiceAuthTransportOptions,
  ) => Promise<SessionConnectedServiceAuthTransportResult<true>>;
  invalidateConnectedServiceAuthTransports: (
    options?: SessionConnectedServiceAuthTransportOptions,
  ) => Promise<SessionConnectedServiceAuthTransportResult<true>>;
  applyConnectedServiceAuthGeneration: (
    input: SessionConnectedServiceAuthApplyGenerationRequestV1,
    options?: SessionConnectedServiceAuthTransportOptions,
  ) => Promise<SessionConnectedServiceAuthTransportResult<SessionConnectedServiceAuthApplyGenerationResponseV1>>;
  readConnectedServiceRuntimeIdentity: (
    input: SessionConnectedServiceAuthReadRuntimeIdentityRequestV1,
    options?: SessionConnectedServiceAuthTransportOptions,
  ) => Promise<SessionConnectedServiceAuthTransportResult<SessionConnectedServiceAuthReadRuntimeIdentityResponseV1>>;
}>;

export type CreateSessionConnectedServiceAuthTransportParams = Readonly<{
  credentials?: StoredCredentials | null;
  sessionId: string;
}>;

export type CreateResolvedSessionConnectedServiceAuthTransportParams = Readonly<{
  token: string;
  sessionId: string;
}> & (
  | Readonly<{ ctx: null; mode: 'plain' }>
  | Readonly<{ ctx: SessionEncryptionContext; mode: 'e2ee' }>
);

type SessionRpcTransport = CreateResolvedSessionConnectedServiceAuthTransportParams;

type ResponseSchema<T> = Readonly<{
  safeParse(value: unknown): { success: true; data: T } | { success: false };
}>;

const CONNECTED_SERVICE_AUTH_APPLY_RPC_TIMEOUT_MS = 60_000;

function success<T>(value: T): SessionConnectedServiceAuthTransportResult<T> {
  return { ok: true, value };
}

function failure<T = never>(code: string): SessionConnectedServiceAuthTransportResult<T> {
  return {
    ok: false,
    code,
    error: code,
    diagnostics: [{ code }],
  };
}

function unresolvedTransportFailure<T = never>(
  transport: Extract<ResolvedTransport, { ok: false }>,
): SessionConnectedServiceAuthTransportResult<T> {
  return failure(
    transport.code === 'encryption_material_unavailable'
      ? transport.code
      : 'session_transport_unavailable',
  );
}

function aborted<T = never>(
  options?: SessionConnectedServiceAuthTransportOptions,
): SessionConnectedServiceAuthTransportResult<T> | null {
  return options?.signal?.aborted ? failure('runtime_control_aborted') : null;
}

function createSessionRpcTransport(
  token: string,
  transport: Extract<ResolvedTransport, { ok: true }>,
): SessionRpcTransport {
  return transport.mode === 'plain'
    ? {
        token,
        sessionId: transport.sessionId,
        mode: transport.mode,
        ctx: transport.ctx,
      }
    : {
        token,
        sessionId: transport.sessionId,
        mode: transport.mode,
        ctx: transport.ctx,
      };
}

async function callResolvedSessionRpc(params: Readonly<{
  transport: SessionRpcTransport;
  method: string;
  request: unknown;
  timeoutMs?: number;
}>): Promise<unknown> {
  return params.transport.mode === 'plain'
    ? await callSessionRpc({
        token: params.transport.token,
        sessionId: params.transport.sessionId,
        mode: params.transport.mode,
        ctx: params.transport.ctx,
        method: `${params.transport.sessionId}:${params.method}`,
        request: params.request,
        ...(params.timeoutMs === undefined ? {} : { timeoutMs: params.timeoutMs }),
      })
    : await callSessionRpc({
        token: params.transport.token,
        sessionId: params.transport.sessionId,
        mode: params.transport.mode,
        ctx: params.transport.ctx,
        method: `${params.transport.sessionId}:${params.method}`,
        request: params.request,
        ...(params.timeoutMs === undefined ? {} : { timeoutMs: params.timeoutMs }),
      });
}

async function callConnectedServiceAuthSessionRpc<T>(params: Readonly<{
  transport: SessionRpcTransport;
  method: string;
  request: unknown;
  responseSchema: ResponseSchema<T>;
  failureCode: string;
  timeoutMs?: number;
}>): Promise<SessionConnectedServiceAuthTransportResult<T>> {
  const rawResponse = await callResolvedSessionRpc({
    transport: params.transport,
    method: params.method,
    request: params.request,
    ...(params.timeoutMs === undefined ? {} : { timeoutMs: params.timeoutMs }),
  });
  const parsedResponse = params.responseSchema.safeParse(rawResponse);
  if (!parsedResponse.success) {
    return failure(params.failureCode);
  }
  return success(parsedResponse.data);
}

export function createSessionConnectedServiceAuthTransport(
  params: CreateSessionConnectedServiceAuthTransportParams,
): SessionConnectedServiceAuthTransport {
  let resolvedTransport: Promise<ResolvedTransport> | null = null;
  const resolveTransport = async (): Promise<ResolvedTransport> => {
    if (!params.credentials) {
      return {
        ok: false,
        code: 'session_not_found',
        sessionId: params.sessionId,
      };
    }
    resolvedTransport ??= resolveSessionTransportContext({
      credentials: params.credentials,
      idOrPrefix: params.sessionId,
    });
    return await resolvedTransport;
  };

  return {
    checkConnectedServiceAuthTransportInvalidation: async (options) => {
      const abortedResult = aborted(options);
      if (abortedResult) return abortedResult;
      const transport = await resolveTransport();
      if (options?.signal?.aborted) return failure('runtime_control_aborted');
      return transport.ok ? success(true) : unresolvedTransportFailure(transport);
    },
    invalidateConnectedServiceAuthTransports: async (options) => {
      const abortedResult = aborted(options);
      if (abortedResult) return abortedResult;
      const transport = await resolveTransport();
      if (!transport.ok) return unresolvedTransportFailure(transport);
      if (!params.credentials) return failure('session_transport_unavailable');
      if (options?.signal?.aborted) return failure('runtime_control_aborted');

      const rawResponse = await callResolvedSessionRpc({
        transport: createSessionRpcTransport(params.credentials.token, transport),
        method: SESSION_RPC_METHODS.SESSION_CONNECTED_SERVICE_AUTH_INVALIDATE_TRANSPORTS,
        request: {},
      });
      const parsedResponse = SessionConnectedServiceAuthInvalidateTransportsResponseV1Schema.safeParse(rawResponse);
      if (!parsedResponse.success || parsedResponse.data.ok !== true) {
        return failure('session_transport_invalidation_failed');
      }
      return success(true);
    },
    applyConnectedServiceAuthGeneration: async (
      request: SessionConnectedServiceAuthApplyGenerationRequestV1,
      options,
    ) => {
      const abortedResult = aborted<SessionConnectedServiceAuthApplyGenerationResponseV1>(options);
      if (abortedResult) return abortedResult;
      const transport = await resolveTransport();
      if (!transport.ok) return unresolvedTransportFailure(transport);
      if (!params.credentials) return failure('session_transport_unavailable');
      if (options?.signal?.aborted) return failure('runtime_control_aborted');
      return await callConnectedServiceAuthSessionRpc({
        transport: createSessionRpcTransport(params.credentials.token, transport),
        method: SESSION_RPC_METHODS.SESSION_CONNECTED_SERVICE_AUTH_APPLY_GENERATION,
        request,
        timeoutMs: CONNECTED_SERVICE_AUTH_APPLY_RPC_TIMEOUT_MS,
        responseSchema: SessionConnectedServiceAuthApplyGenerationResponseV1Schema,
        failureCode: 'connected_service_auth_apply_failed',
      });
    },
    readConnectedServiceRuntimeIdentity: async (
      request: SessionConnectedServiceAuthReadRuntimeIdentityRequestV1,
      options,
    ) => {
      const abortedResult = aborted<SessionConnectedServiceAuthReadRuntimeIdentityResponseV1>(options);
      if (abortedResult) return abortedResult;
      const transport = await resolveTransport();
      if (!transport.ok) return unresolvedTransportFailure(transport);
      if (!params.credentials) return failure('session_transport_unavailable');
      if (options?.signal?.aborted) return failure('runtime_control_aborted');
      return await callConnectedServiceAuthSessionRpc({
        transport: createSessionRpcTransport(params.credentials.token, transport),
        method: SESSION_RPC_METHODS.SESSION_CONNECTED_SERVICE_AUTH_READ_RUNTIME_IDENTITY,
        request,
        responseSchema: SessionConnectedServiceAuthReadRuntimeIdentityResponseV1Schema,
        failureCode: 'connected_service_runtime_identity_failed',
      });
    },
  };
}

export function createResolvedSessionConnectedServiceAuthTransport(
  params: CreateResolvedSessionConnectedServiceAuthTransportParams,
): SessionConnectedServiceAuthTransport {
  return {
    checkConnectedServiceAuthTransportInvalidation: async (options) =>
      aborted(options) ?? success(true),
    invalidateConnectedServiceAuthTransports: async (options) => {
      const abortedResult = aborted(options);
      if (abortedResult) return abortedResult;
      const rawResponse = await callResolvedSessionRpc({
        transport: params,
        method: SESSION_RPC_METHODS.SESSION_CONNECTED_SERVICE_AUTH_INVALIDATE_TRANSPORTS,
        request: {},
      });
      const parsedResponse = SessionConnectedServiceAuthInvalidateTransportsResponseV1Schema.safeParse(rawResponse);
      if (!parsedResponse.success || parsedResponse.data.ok !== true) {
        return failure('session_transport_invalidation_failed');
      }
      return success(true);
    },
    applyConnectedServiceAuthGeneration: async (
      request: SessionConnectedServiceAuthApplyGenerationRequestV1,
      options,
    ) => {
      const abortedResult = aborted<SessionConnectedServiceAuthApplyGenerationResponseV1>(options);
      if (abortedResult) return abortedResult;
      return await callConnectedServiceAuthSessionRpc({
        transport: params,
        method: SESSION_RPC_METHODS.SESSION_CONNECTED_SERVICE_AUTH_APPLY_GENERATION,
        request,
        timeoutMs: CONNECTED_SERVICE_AUTH_APPLY_RPC_TIMEOUT_MS,
        responseSchema: SessionConnectedServiceAuthApplyGenerationResponseV1Schema,
        failureCode: 'connected_service_auth_apply_failed',
      });
    },
    readConnectedServiceRuntimeIdentity: async (
      request: SessionConnectedServiceAuthReadRuntimeIdentityRequestV1,
      options,
    ) => {
      const abortedResult = aborted<SessionConnectedServiceAuthReadRuntimeIdentityResponseV1>(options);
      if (abortedResult) return abortedResult;
      return await callConnectedServiceAuthSessionRpc({
        transport: params,
        method: SESSION_RPC_METHODS.SESSION_CONNECTED_SERVICE_AUTH_READ_RUNTIME_IDENTITY,
        request,
        responseSchema: SessionConnectedServiceAuthReadRuntimeIdentityResponseV1Schema,
        failureCode: 'connected_service_runtime_identity_failed',
      });
    },
  };
}
