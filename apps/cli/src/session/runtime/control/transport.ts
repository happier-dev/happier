import { SessionConnectedServiceAuthInvalidateTransportsResponseV1Schema } from '@happier-dev/protocol';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import type {
  HostRuntimeControlRequestOptionsV1,
  HostRuntimeControlResultV1,
  HostRuntimeControlSessionDelegateV1,
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

function success(): HostRuntimeControlResultV1<true> {
  return { ok: true, value: true };
}

function failure(code: string): HostRuntimeControlResultV1<true> {
  return {
    ok: false,
    code,
    error: code,
    diagnostics: [{ code }],
  };
}

function aborted(options?: HostRuntimeControlRequestOptionsV1): HostRuntimeControlResultV1<true> | null {
  return options?.signal?.aborted ? failure('runtime_control_aborted') : null;
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
      return transport.ok ? success() : failure('session_transport_unavailable');
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
      return success();
    },
  };
}

export function createResolvedSessionRuntimeControlTransport(
  params: CreateResolvedSessionRuntimeControlTransportParams,
): HostRuntimeControlSessionDelegateV1 {
  return {
    checkConnectedServiceAuthTransportInvalidation: async (options) =>
      aborted(options) ?? success(),
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
      return success();
    },
  };
}
