import { type CapturedServerRequestPreparation } from './capturedServerReadTransport';
import {
  TokenStorage,
  type AuthCredentials,
} from '@/auth/storage/tokenStorage';
import { resolveScopedAccountEncryption } from '@/sync/encryption/scopedAccountEncryption';
import type { Encryption } from '@/sync/encryption/encryption';
import {
  areServerProfileIdentifiersEquivalent,
  getServerProfileById,
  resolveServerProfileScopeIdForIdentifier,
} from '@/sync/domains/server/serverProfiles';
import {
  getAppliedActiveServerSnapshot,
  isAppliedActiveServerRuntimeAvailable,
} from '@/sync/runtime/orchestration/connectionManager';
import type { HomeCarrier } from '@/sync/runtime/homeCarrier';
import { parseToken } from '@/utils/auth/parseToken';
import { readCredentialAuthorityKind } from '@/auth/context/credentialAuthority';
import {
  readRegisteredStorageState,
  subscribeRegisteredStorageState,
} from '@/sync/domains/state/storageStateReaderBridge';
import {
  resolveServerScopedTransport,
  ServerScopedTransportUnavailableError,
} from './resolveServerScopedTransport';

export { ServerScopedTransportUnavailableError };

import { DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS } from './serverScopedRpcTypes';
import { isEmbedWindowContext } from '@/embed/isEmbedWindowContext';
import { getSyncSingleton } from '@/sync/runtime/getSyncSingleton';
import { throwIfAborted } from '@/utils/runtime/abortSignals';
import { createCapturedServerReadTransport, type CapturedServerReadTransport } from './capturedServerReadTransport';
import { captureAccountEncryptionObservationForHome, type AccountEncryptionObservationBinding } from '@/sync/http/accountEncryptionObservationBinding';

function normalizeId(raw: unknown): string {
  return String(raw ?? '').trim();
}

export type ResolvedServerAccountRequestContext =
  | Readonly<{ scope: 'active'; timeoutMs: number }>
  | Readonly<{
      scope: 'scoped';
      timeoutMs: number;
      targetServerId: string;
      targetServerUrl: string;
      targetAccountId: string;
      token: string;
      /** Present for contexts produced by the runtime; optional for injected adapters. */
      credentials?: AuthCredentials;
      encryption: Encryption | null;
      runtimeOrigin?: string;
      carrier?: 'https' | 'iroh';
      /** Semantic carrier for a Home with no reachable URL origin (browser Iroh). */
      homeCarrier?: HomeCarrier;
      readTransport?: CapturedServerReadTransport;
      accountEncryptionObservation?: AccountEncryptionObservationBinding;
      release?: () => Promise<void>;
    }>;

async function buildScopedContext(params: Readonly<{
  serverId: string;
  serverUrl: string;
  profile?: Readonly<{
    serverUrl: string;
    canonicalServerUrl?: string | null;
    publicServerUrl?: string | null;
    serverIdentityId?: string | null;
    homeConnectionDescriptor?: import('@happier-dev/protocol').HomeConnectionDescriptorV1;
  }>;
  timeoutMs: number;
  prepareRequest?: CapturedServerRequestPreparation;
}>): Promise<Extract<ResolvedServerAccountRequestContext, { scope: 'scoped' }>> {
  const credentials = await TokenStorage.getCredentialsForServerUrl(params.serverUrl, { serverId: params.serverId });
  if (!credentials) {
    throw new Error(`No authentication credentials for target server "${params.serverId}"`);
  }

  const encryption = await resolveScopedAccountEncryption({
    serverId: params.serverId,
    serverUrl: params.profile?.canonicalServerUrl ?? params.serverUrl,
    credentials,
  });
  const transport = await resolveServerScopedTransport({
    profile: params.profile ?? { serverUrl: params.serverUrl },
    credentials,
  });
  const accountEncryptionObservation = readCredentialAuthorityKind(credentials.token) === 'api_token' ? undefined
    : captureAccountEncryptionObservationForHome({ serverId: params.serverId,
      endpointUrl: transport.canonicalServerUrl, credentials });
  return {
    scope: 'scoped',
    timeoutMs: params.timeoutMs,
    targetServerId: params.serverId,
    targetServerUrl: transport.canonicalServerUrl,
    targetAccountId: parseToken(credentials.token),
    token: credentials.token,
    credentials,
    encryption,
    accountEncryptionObservation,
    ...(readCredentialAuthorityKind(credentials.token) === 'api_token' ? {} : {
      readTransport: createCapturedServerReadTransport({ serverId: params.serverId,
        profile: params.profile ?? { serverUrl: params.serverUrl }, credentials, accountEncryptionObservation,
        ...(params.prepareRequest ? { prepareRequest: params.prepareRequest } : {}) }),
    }),
    runtimeOrigin: transport.runtimeOrigin,
    carrier: transport.carrier,
    ...(transport.homeCarrier ? { homeCarrier: transport.homeCarrier } : {}),
    release: transport.release,
  };
}

/**
 * Whether the connection supervisor has concluded the active Home is not answering: the endpoint
 * status the connection summary (footer status, `HomeReachabilityGate`) reads as "unavailable".
 */
function isActiveHomeUnreachable(): boolean {
  return readRegisteredStorageState()?.endpointStatus === 'offline';
}

/**
 * Settles when the caller leaves or the active Home becomes unreachable, without cancelling a
 * shared carrier dial that may never answer. A context arriving after settlement is released;
 * later callers resolve afresh. The caller or connection supervisor owns the lifetime, not a
 * second timer here.
 */
async function settleScopedContext(
  build: () => Promise<Extract<ResolvedServerAccountRequestContext, { scope: 'scoped' }>>,
  options: Readonly<{ watchActiveHome: boolean; signal?: AbortSignal }>,
): Promise<Extract<ResolvedServerAccountRequestContext, { scope: 'scoped' }>> {
  throwIfAborted(options.signal);
  if (options.watchActiveHome && isActiveHomeUnreachable()) throw new ServerScopedTransportUnavailableError();
  if (!options.watchActiveHome && !options.signal) return await build();
  let unsubscribe: (() => void) | null = null;
  let onAbort: (() => void) | null = null;
  let abandoned = false;
  let settled = false;
  const pending = build();
  const observed = pending.then(
    (context) => { settled = true; return context; },
    (error: unknown) => { settled = true; throw error; },
  );
  const cancelled = new Promise<never>((_, reject) => {
    const abandon = (error: unknown) => {
      if (settled) return;
      abandoned = true;
      settled = true;
      reject(error);
    };
    if (options.watchActiveHome) {
      unsubscribe = subscribeRegisteredStorageState((state) => {
        if (state.endpointStatus === 'offline') abandon(new ServerScopedTransportUnavailableError());
      });
    }
    if (options.signal) {
      onAbort = () => {
        try { throwIfAborted(options.signal); } catch (error) { abandon(error); }
      };
      options.signal.addEventListener('abort', onAbort, { once: true });
      if (options.signal.aborted) onAbort();
    }
  });
  try {
    return await Promise.race([observed, cancelled]);
  } finally {
    (unsubscribe as (() => void) | null)?.();
    if (onAbort) options.signal?.removeEventListener('abort', onAbort);
    if (abandoned) {
      pending.then(
        (context) => { void context.release?.().catch(() => {
          console.warn('Failed to release an abandoned Home request carrier');
        }); },
        () => undefined,
      );
    }
  }
}

export async function resolveServerAccountRequestContext(params: Readonly<{
  serverId?: string | null;
  timeoutMs?: number;
  preferScoped?: boolean;
  signal?: AbortSignal;
  networkMode?: 'background-task';
  prepareRequest?: CapturedServerRequestPreparation;
}>): Promise<ResolvedServerAccountRequestContext> {
  throwIfAborted(params.signal);
  const targetServerId = normalizeId(params.serverId);
  const timeoutMs = typeof params.timeoutMs === 'number' && params.timeoutMs > 0
    ? params.timeoutMs
    : DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS;
  if (isEmbedWindowContext()) {
    const embed = getSyncSingleton().getEmbedSessionRequestContext();
    if (!embed || targetServerId && targetServerId !== embed.serverId) throw new ServerScopedTransportUnavailableError();
    return { scope: 'active', timeoutMs };
  }
  const activeSnapshot = getAppliedActiveServerSnapshot();

  const activeServerId = normalizeId(activeSnapshot.serverId);
  const targetsActiveServer = !targetServerId || areServerProfileIdentifiersEquivalent(targetServerId, activeServerId);
  if (targetsActiveServer && params.preferScoped !== true && isAppliedActiveServerRuntimeAvailable()) {
    return { scope: 'active', timeoutMs };
  }

  if (targetsActiveServer) {
    return await settleScopedContext(() => buildScopedContext({
      serverId: activeServerId,
      serverUrl: activeSnapshot.serverUrl,
      timeoutMs,
      profile: getServerProfileById(activeServerId) ?? { serverUrl: activeSnapshot.serverUrl },
      ...(params.prepareRequest ? { prepareRequest: params.prepareRequest } : {}),
    }), { watchActiveHome: params.networkMode !== 'background-task', signal: params.signal });
  }

  const resolvedTargetServerId = resolveServerProfileScopeIdForIdentifier(targetServerId);
  const targetProfile = getServerProfileById(resolvedTargetServerId);
  if (!targetProfile) {
    throw new Error(`Target server profile not found for serverId "${resolvedTargetServerId}"`);
  }

  return await settleScopedContext(() => buildScopedContext({
    serverId: resolvedTargetServerId,
    serverUrl: targetProfile.serverUrl,
    timeoutMs,
    profile: targetProfile,
    ...(params.prepareRequest ? { prepareRequest: params.prepareRequest } : {}),
  }), { watchActiveHome: false, signal: params.signal });
}
