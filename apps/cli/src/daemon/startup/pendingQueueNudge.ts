import type { StoredCredentials } from '@/persistence';
import { fetchSessionByIdCompat } from '@/session/transport/http/sessionsHttp';
import { resolveSessionEncryptionContextFromCredentials, resolveSessionStoredContentEncryptionMode } from '@/session/transport/encryption/sessionEncryptionContext';
import { callSessionRpc } from '@/session/transport/rpc/sessionRpc';
import { logger } from '@/ui/logger';
import {
  SessionPendingQueueWakeCapabilityResponseV1Schema,
  SessionPendingQueueWakeResponseV1Schema,
} from '@happier-dev/protocol';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { isRpcMethodNotAvailableError } from '@happier-dev/protocol/rpcErrors';

type Cancellation = Readonly<{ abortSignal?: AbortSignal; isShuttingDown?: () => boolean }>;
const cancelled = (params: Cancellation) => params.abortSignal?.aborted === true || params.isShuttingDown?.() === true;

export type PendingQueueNudgeResult =
  | Readonly<{ type: 'wake_published' }>
  | Readonly<{ type: 'unavailable'; reason: 'no_token' | 'shutdown' | 'transport_unavailable' | 'encryption_material_unavailable' | 'runtime_upgrade_required' | 'malformed_response' | 'rpc_method_unavailable' | 'rpc_failed'; error?: unknown }>;

export type ExistingSessionServiceability =
  | Readonly<{ state: 'servable' }>
  | Readonly<{ state: 'recoverable_unservable'; reason: 'encryption_material_unavailable' | 'runtime_upgrade_required' | 'malformed_response' | 'rpc_method_unavailable' }>
  | Readonly<{ state: 'unknown'; reason: 'no_token' | 'shutdown' | 'transport_unavailable' | 'rpc_failed' }>;

type ServiceabilityParams = Readonly<{ sessionId: string; credentials: StoredCredentials }> & Cancellation;
type CapabilityDiscovery =
  | Readonly<{ result: Extract<ExistingSessionServiceability, { state: 'servable' }>; transport: Parameters<typeof callSessionRpc>[0] }>
  | Readonly<{ result: Exclude<ExistingSessionServiceability, { state: 'servable' }>; error?: unknown }>;

async function discoverPendingQueueCapability(params: ServiceabilityParams): Promise<CapabilityDiscovery> {
  const token = params.credentials.token.trim();
  if (!token) return { result: { state: 'unknown', reason: 'no_token' } };
  if (cancelled(params)) return { result: { state: 'unknown', reason: 'shutdown' } };
  try {
    const rawSession = await fetchSessionByIdCompat({ token, sessionId: params.sessionId });
    if (!rawSession) return { result: { state: 'unknown', reason: 'transport_unavailable' } };
    if (cancelled(params)) return { result: { state: 'unknown', reason: 'shutdown' } };
    const mode = resolveSessionStoredContentEncryptionMode(rawSession);
    const transport = mode === 'plain'
      ? {
          token,
          sessionId: params.sessionId,
          mode,
          ctx: null,
          method: `${params.sessionId}:${SESSION_RPC_METHODS.SESSION_PENDING_QUEUE_WAKE_CAPABILITY_GET_V1}`,
          request: {},
        } satisfies Parameters<typeof callSessionRpc>[0]
      : (() => {
          const ctx = resolveSessionEncryptionContextFromCredentials(params.credentials, rawSession);
          if (!ctx) return null;
          return {
            token,
            sessionId: params.sessionId,
            mode,
            ctx,
            method: `${params.sessionId}:${SESSION_RPC_METHODS.SESSION_PENDING_QUEUE_WAKE_CAPABILITY_GET_V1}`,
            request: {},
          } satisfies Parameters<typeof callSessionRpc>[0];
        })();
    if (!transport) {
      return {
        result: {
          state: 'recoverable_unservable',
          reason: 'encryption_material_unavailable',
        },
      };
    }
    const capabilityRaw = await callSessionRpc(transport);
    const capability = SessionPendingQueueWakeCapabilityResponseV1Schema.safeParse(capabilityRaw);
    if (!capability.success || (capability.data.ok && capability.data.method !== SESSION_RPC_METHODS.SESSION_PENDING_QUEUE_WAKE_V1)) {
      return { result: { state: 'recoverable_unservable', reason: 'malformed_response' } };
    }
    if (!capability.data.ok) return { result: { state: 'recoverable_unservable', reason: 'runtime_upgrade_required' } };
    return { result: { state: 'servable' }, transport };
  } catch (error) {
    return isRpcMethodNotAvailableError(error)
      ? { result: { state: 'recoverable_unservable', reason: 'rpc_method_unavailable' }, error }
      : { result: { state: 'unknown', reason: 'rpc_failed' }, error };
  }
}

/** Exact-session capability probe only; never invokes the wake method. */
export async function probeAlreadyRunningExistingSessionServiceability(params: ServiceabilityParams): Promise<ExistingSessionServiceability> {
  return (await discoverPendingQueueCapability(params)).result;
}

export async function nudgeAlreadyRunningExistingSessionPendingQueue(params: Readonly<{
  sessionId: string;
  credentials: StoredCredentials;
}> & Cancellation): Promise<PendingQueueNudgeResult> {
  const discovery = await discoverPendingQueueCapability(params);
  if (!('transport' in discovery)) {
    return { type: 'unavailable', reason: discovery.result.reason, ...(discovery.error === undefined ? {} : { error: discovery.error }) };
  }
  try {
    if (cancelled(params)) return { type: 'unavailable', reason: 'shutdown' };
    const wakeRaw = await callSessionRpc({ ...discovery.transport, method: `${params.sessionId}:${SESSION_RPC_METHODS.SESSION_PENDING_QUEUE_WAKE_V1}`, request: { protocolVersion: 1 } });
    const wake = SessionPendingQueueWakeResponseV1Schema.safeParse(wakeRaw);
    if (!wake.success) return { type: 'unavailable', reason: 'malformed_response' };
    return wake.data.ok ? { type: 'wake_published' } : { type: 'unavailable', reason: 'runtime_upgrade_required' };
  } catch (error) {
    logger.debug('[DAEMON RUN] Failed to publish pending queue wake');
    return { type: 'unavailable', reason: isRpcMethodNotAvailableError(error) ? 'rpc_method_unavailable' : 'rpc_failed', error };
  }
}
