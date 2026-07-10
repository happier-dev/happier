import {
  SessionConnectedServiceAuthApplyGenerationResponseV1Schema,
  SessionConnectedServiceAuthInvalidateTransportsResponseV1Schema,
  SessionConnectedServiceAuthReadRuntimeIdentityResponseV1Schema,
} from '@happier-dev/protocol';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import type {
  HostRuntimeControlRequestOptionsV1,
  HostRuntimeControlResultV1,
  HostRuntimeControlSessionDelegateV1,
  HostRuntimeControlConnectedServiceAuthApplyGenerationInputV1,
  HostRuntimeControlConnectedServiceAuthApplyGenerationOutputV1,
  HostRuntimeControlConnectedServiceRuntimeIdentityInputV1,
  HostRuntimeControlConnectedServiceRuntimeIdentityOutputV1,
} from '@happier-dev/agents';

import type { Credentials } from '@/persistence';
import { resolveSessionTransportContext } from '@/session/services/resolveSessionTransportContext';
import type {
  SessionEncryptionContext,
  SessionStoredContentEncryptionMode,
} from '@/session/transport/encryption/sessionEncryptionContext';
import { callSessionRpc } from '@/session/transport/rpc/sessionRpc';

type ResolvedTransport = Awaited<ReturnType<typeof resolveSessionTransportContext>>;

export type CreateSessionRuntimeControlTransportParams = Readonly<{
  credentials?: Credentials | null;
  sessionId: string;
}>;

export type CreateResolvedSessionRuntimeControlTransportParams = Readonly<{
  token: string;
  sessionId: string;
  ctx: SessionEncryptionContext;
  mode: SessionStoredContentEncryptionMode;
}>;

type ResponseSchema<T> = Readonly<{
  safeParse(value: unknown): { success: true; data: T } | { success: false };
}>;

function success<T>(value: T): HostRuntimeControlResultV1<T> {
  return { ok: true, value };
}

function failure<T = never>(code: string): HostRuntimeControlResultV1<T> {
  return {
    ok: false,
    code,
    error: code,
    diagnostics: [{ code }],
  };
}

function aborted<T = never>(options?: HostRuntimeControlRequestOptionsV1): HostRuntimeControlResultV1<T> | null {
  return options?.signal?.aborted ? failure('runtime_control_aborted') : null;
}

async function callRuntimeControlSessionRpc<T>(params: Readonly<{
  token: string;
  sessionId: string;
  ctx: SessionEncryptionContext;
  mode: SessionStoredContentEncryptionMode;
  method: string;
  request: unknown;
  responseSchema: ResponseSchema<T>;
  failureCode: string;
}>): Promise<HostRuntimeControlResultV1<T>> {
  const rawResponse = await callSessionRpc({
    token: params.token,
    sessionId: params.sessionId,
    ctx: params.ctx,
    mode: params.mode,
    method: `${params.sessionId}:${params.method}`,
    request: params.request,
  });
  const parsedResponse = params.responseSchema.safeParse(rawResponse);
  if (!parsedResponse.success) {
    return failure(params.failureCode);
  }
  return success(parsedResponse.data);
}

export function createSessionRuntimeControlTransport(
  params: CreateSessionRuntimeControlTransportParams,
): HostRuntimeControlSessionDelegateV1 {
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
      return transport.ok ? success(true) : failure('session_transport_unavailable');
    },
    invalidateConnectedServiceAuthTransports: async (options) => {
      const abortedResult = aborted(options);
      if (abortedResult) return abortedResult;
      const transport = await resolveTransport();
      if (!transport.ok || !params.credentials) return failure('session_transport_unavailable');
      if (options?.signal?.aborted) return failure('runtime_control_aborted');

      const rawResponse = await callSessionRpc({
        token: params.credentials.token,
        sessionId: transport.sessionId,
        ctx: transport.ctx,
        mode: transport.mode,
        method: `${transport.sessionId}:${SESSION_RPC_METHODS.SESSION_CONNECTED_SERVICE_AUTH_INVALIDATE_TRANSPORTS}`,
        request: {},
      });
      const parsedResponse = SessionConnectedServiceAuthInvalidateTransportsResponseV1Schema.safeParse(rawResponse);
      if (!parsedResponse.success || parsedResponse.data.ok !== true) {
        return failure('session_transport_invalidation_failed');
      }
      return success(true);
    },
    applyConnectedServiceAuthGeneration: async (
      request: HostRuntimeControlConnectedServiceAuthApplyGenerationInputV1,
      options,
    ) => {
      const abortedResult = aborted<HostRuntimeControlConnectedServiceAuthApplyGenerationOutputV1>(options);
      if (abortedResult) return abortedResult;
      const transport = await resolveTransport();
      if (!transport.ok || !params.credentials) return failure('session_transport_unavailable');
      if (options?.signal?.aborted) return failure('runtime_control_aborted');
      return await callRuntimeControlSessionRpc({
        token: params.credentials.token,
        sessionId: transport.sessionId,
        ctx: transport.ctx,
        mode: transport.mode,
        method: SESSION_RPC_METHODS.SESSION_CONNECTED_SERVICE_AUTH_APPLY_GENERATION,
        request,
        responseSchema: SessionConnectedServiceAuthApplyGenerationResponseV1Schema,
        failureCode: 'connected_service_auth_apply_failed',
      });
    },
    readConnectedServiceRuntimeIdentity: async (
      request: HostRuntimeControlConnectedServiceRuntimeIdentityInputV1,
      options,
    ) => {
      const abortedResult = aborted<HostRuntimeControlConnectedServiceRuntimeIdentityOutputV1>(options);
      if (abortedResult) return abortedResult;
      const transport = await resolveTransport();
      if (!transport.ok || !params.credentials) return failure('session_transport_unavailable');
      if (options?.signal?.aborted) return failure('runtime_control_aborted');
      return await callRuntimeControlSessionRpc({
        token: params.credentials.token,
        sessionId: transport.sessionId,
        ctx: transport.ctx,
        mode: transport.mode,
        method: SESSION_RPC_METHODS.SESSION_CONNECTED_SERVICE_AUTH_READ_RUNTIME_IDENTITY,
        request,
        responseSchema: SessionConnectedServiceAuthReadRuntimeIdentityResponseV1Schema,
        failureCode: 'connected_service_runtime_identity_failed',
      });
    },
  };
}

export function createResolvedSessionRuntimeControlTransport(
  params: CreateResolvedSessionRuntimeControlTransportParams,
): HostRuntimeControlSessionDelegateV1 {
  return {
    checkConnectedServiceAuthTransportInvalidation: async (options) =>
      aborted(options) ?? success(true),
    invalidateConnectedServiceAuthTransports: async (options) => {
      const abortedResult = aborted(options);
      if (abortedResult) return abortedResult;
      const rawResponse = await callSessionRpc({
        token: params.token,
        sessionId: params.sessionId,
        ctx: params.ctx,
        mode: params.mode,
        method: `${params.sessionId}:${SESSION_RPC_METHODS.SESSION_CONNECTED_SERVICE_AUTH_INVALIDATE_TRANSPORTS}`,
        request: {},
      });
      const parsedResponse = SessionConnectedServiceAuthInvalidateTransportsResponseV1Schema.safeParse(rawResponse);
      if (!parsedResponse.success || parsedResponse.data.ok !== true) {
        return failure('session_transport_invalidation_failed');
      }
      return success(true);
    },
    applyConnectedServiceAuthGeneration: async (
      request: HostRuntimeControlConnectedServiceAuthApplyGenerationInputV1,
      options,
    ) => {
      const abortedResult = aborted<HostRuntimeControlConnectedServiceAuthApplyGenerationOutputV1>(options);
      if (abortedResult) return abortedResult;
      return await callRuntimeControlSessionRpc({
        token: params.token,
        sessionId: params.sessionId,
        ctx: params.ctx,
        mode: params.mode,
        method: SESSION_RPC_METHODS.SESSION_CONNECTED_SERVICE_AUTH_APPLY_GENERATION,
        request,
        responseSchema: SessionConnectedServiceAuthApplyGenerationResponseV1Schema,
        failureCode: 'connected_service_auth_apply_failed',
      });
    },
    readConnectedServiceRuntimeIdentity: async (
      request: HostRuntimeControlConnectedServiceRuntimeIdentityInputV1,
      options,
    ) => {
      const abortedResult = aborted<HostRuntimeControlConnectedServiceRuntimeIdentityOutputV1>(options);
      if (abortedResult) return abortedResult;
      return await callRuntimeControlSessionRpc({
        token: params.token,
        sessionId: params.sessionId,
        ctx: params.ctx,
        mode: params.mode,
        method: SESSION_RPC_METHODS.SESSION_CONNECTED_SERVICE_AUTH_READ_RUNTIME_IDENTITY,
        request,
        responseSchema: SessionConnectedServiceAuthReadRuntimeIdentityResponseV1Schema,
        failureCode: 'connected_service_runtime_identity_failed',
      });
    },
  };
}
