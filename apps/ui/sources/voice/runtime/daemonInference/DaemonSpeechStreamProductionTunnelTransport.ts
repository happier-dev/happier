import {
  DIRECT_ROUTE_GRANT_TTL_MS,
  DEFAULT_MACHINE_TUNNEL_CAPABILITIES,
  RPC_METHODS,
  MachineTunnelCapabilitiesSchema,
  PEER_MEDIATION_RECEIPTS,
  PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
  PEER_TCP_TUNNEL_OPEN_PATH,
  PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT,
  PeerLoopbackProbeResponseV1Schema,
  PeerTcpTunnelOpenResponseV1Schema,
  PeerTcpTunnelRelayAuthorizationV1Schema,
  SignedDirectRouteGrantV1Schema,
  createPeerRouteNonceSigningInputV1,
  createDaemonVoiceSttRelayTunnelId,
  readMachineLiveStreamRelayCaps,
  resolveMachineRpcRelayFallbackDecision,
  resolveMachineRpcRoutePolicy,
  type MachineTunnelCapabilities,
  type PeerLoopbackEndpointCandidateV1,
  type PeerLoopbackProbeRequestV1,
  type PeerLoopbackProbeResponseV1,
  type PeerRouteNonceProofV1,
  type PeerTcpTunnelDestinationV1,
  type PeerTcpTunnelOpenV1,
  type PeerTcpTunnelRelayEnvelope,
  type PeerTcpTunnelRelayAuthorizationV1,
  type SignedDirectRouteGrantV1,
} from '@happier-dev/protocol';
import { createPeerRouteViabilityCache } from '@happier-dev/peer-mediation';

import { isLegacyAuthCredentials, TokenStorage, type AuthCredentials } from '@/auth/storage/tokenStorage';
import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import sodium from '@/encryption/libsodium.lib';
import { getRandomBytes } from '@/platform/cryptoRandom';
import { getReadyServerFeatures } from '@/sync/api/capabilities/getReadyServerFeatures';
import { apiSocket } from '@/sync/api/session/apiSocket';
import { resolveRuntimeFeatureDecision } from '@/sync/domains/features/featureDecisionInputs';
import {
  resolvePeerLoopbackRouteAvailability,
  type PeerLoopbackRouteAvailabilityResult,
} from '@/sync/domains/machines/peer/mediation/loopback/resolvePeerLoopbackRouteAvailability';
import { openPeerTcpTunnel, type PeerTcpTunnelClientStream } from '@/sync/domains/machines/peer/mediation/tunnel/client';
import {
  readEndpointFromMachineState,
  resolveTargetServer,
  type TargetServer,
} from '@/sync/domains/machines/peer/mediation/stream/productionRouteHttp';
import { storage } from '@/sync/domains/state/storage';
import { createServerScopedRelaySocket } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedRelaySocket';

import { createDaemonSpeechStreamCarrierAdapter } from './DaemonSpeechStreamCarrier';
import { createDaemonSpeechStreamTunnelTransport } from './DaemonSpeechStreamTunnelTransport';
import type {
  DaemonVoiceInferenceStreamingSttTransportFactoryInput,
  DaemonVoiceInferenceStreamingSttTransportSelection,
} from './DaemonVoiceInferenceClient';
import type { DaemonSpeechStreamTransport } from './DaemonSpeechStreamSender';

const VOICE_STT_TUNNEL_FETCH_TIMEOUT_MS = 5_000;
const VOICE_STT_TUNNEL_NONCE_BYTES = 16;
const VOICE_STT_TUNNEL_CACHE_POSITIVE_TTL_MS = 30_000;
const VOICE_STT_TUNNEL_CACHE_NEGATIVE_TTL_MS = 5_000;

const voiceSttTunnelRouteAvailabilityCache = createPeerRouteViabilityCache({
  now: Date.now,
  positiveTtlMs: VOICE_STT_TUNNEL_CACHE_POSITIVE_TTL_MS,
  negativeTtlMs: VOICE_STT_TUNNEL_CACHE_NEGATIVE_TTL_MS,
});

type OperationResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; reasonCode: string }>;

type PreparedDirectTunnelRoute = Readonly<{
  endpoint: PeerLoopbackEndpointCandidateV1;
  grant: SignedDirectRouteGrantV1;
  nonceProof: PeerRouteNonceProofV1;
  availability: Extract<PeerLoopbackRouteAvailabilityResult, { kind: 'selected' }>;
}>;

type TunnelAttemptParams = Readonly<{
  input: DaemonVoiceInferenceStreamingSttTransportFactoryInput;
  server: TargetServer;
  destination: PeerTcpTunnelDestinationV1;
  tunnelId: string;
}>;

function normalizeBaseUrl(url: string): string {
  return String(url ?? '').trim().replace(/\/+$/, '');
}

function joinBaseAndPath(serverUrl: string, path: string): string {
  return `${normalizeBaseUrl(serverUrl)}${path.startsWith('/') ? path : `/${path}`}`;
}

function resolveEndpointPath(endpointUrl: string, path: string): string {
  const parsed = new URL(endpointUrl);
  parsed.pathname = path;
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readRecordValue(record: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

function readMachineRecord(input: Readonly<{
  serverId: string;
  machineId: string;
}>): Record<string, unknown> | null {
  const state = storage.getState() as unknown as {
    machineListByServerId?: Record<string, readonly unknown[]>;
    machines?: Record<string, unknown>;
  };
  const scopedMachines = state.machineListByServerId?.[input.serverId];
  if (Array.isArray(scopedMachines)) {
    for (const candidate of scopedMachines) {
      if (!isRecord(candidate)) continue;
      if (String(readRecordValue(candidate, 'id') ?? '') === input.machineId) {
        return candidate;
      }
    }
  }
  const fallbackMachine = state.machines?.[input.machineId];
  return isRecord(fallbackMachine) ? fallbackMachine : null;
}

function readDaemonHttpPort(input: Readonly<{
  serverId: string;
  machineId: string;
}>): number | null {
  const machine = readMachineRecord(input);
  const daemonState = isRecord(machine?.daemonState) ? machine.daemonState : null;
  const rawPort = daemonState ? readRecordValue(daemonState, 'httpPort') : null;
  const port = typeof rawPort === 'number'
    ? rawPort
    : typeof rawPort === 'string' && rawPort.trim().length > 0
      ? Number(rawPort)
      : Number.NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
  return port;
}

function readTunnelCapabilities(serverFeatures: unknown): MachineTunnelCapabilities {
  const featuresRecord = isRecord(serverFeatures) ? serverFeatures : null;
  const capabilities = isRecord(featuresRecord?.capabilities) ? featuresRecord.capabilities : null;
  const machines = isRecord(capabilities?.machines) ? capabilities.machines : null;
  const tunnel = isRecord(machines?.tunnel) ? machines.tunnel : null;
  const parsed = MachineTunnelCapabilitiesSchema.safeParse(tunnel);
  return parsed.success ? parsed.data : DEFAULT_MACHINE_TUNNEL_CAPABILITIES;
}

async function fetchJson(params: Readonly<{
  url: string;
  init: RequestInit;
  timeoutMs?: number;
  signal?: AbortSignal | null;
}>): Promise<Readonly<{ ok: boolean; status: number; body: unknown }>> {
  const timeoutMs = typeof params.timeoutMs === 'number' && params.timeoutMs > 0
    ? params.timeoutMs
    : VOICE_STT_TUNNEL_FETCH_TIMEOUT_MS;
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timeoutId = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  const externalSignal = params.signal ?? null;
  const abort = controller && externalSignal ? () => controller.abort() : null;
  if (controller && externalSignal && abort) {
    if (externalSignal.aborted) {
      controller.abort();
    } else {
      externalSignal.addEventListener('abort', abort, { once: true });
    }
  }
  try {
    const response = await fetch(params.url, {
      ...params.init,
      ...(controller ? { signal: controller.signal } : {}),
    });
    return {
      ok: response.ok,
      status: response.status,
      body: await response.json().catch(() => null),
    };
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    if (externalSignal && abort) {
      externalSignal.removeEventListener('abort', abort);
    }
  }
}

async function requestTcpTunnelRouteGrant(input: Readonly<{
  server: TargetServer;
  credentials: AuthCredentials;
  machineId: string;
  tunnelId: string;
  endpointFingerprint: string;
  destination: PeerTcpTunnelDestinationV1;
  maxIdleMs: number;
  maxDurationMs: number;
  maxTotalBytes?: number;
  timeoutMs?: number;
  signal?: AbortSignal | null;
}>): Promise<OperationResult<SignedDirectRouteGrantV1>> {
  try {
    const response = await fetchJson({
      url: joinBaseAndPath(input.server.serverUrl, '/v1/machines/peer/mediation/route-grants'),
      timeoutMs: input.timeoutMs,
      signal: input.signal,
      init: {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${input.credentials.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          machineId: input.machineId,
          flowKind: 'tcp_tunnel',
          routeKind: 'loopback_direct',
          endpointFingerprint: input.endpointFingerprint,
          ttlMs: DIRECT_ROUTE_GRANT_TTL_MS.directTcpTunnel,
          scope: {
            kind: 'tcp_tunnel',
            tunnelId: input.tunnelId,
            allowedPorts: [input.destination.port],
            maxIdleMs: input.maxIdleMs,
            maxDurationMs: input.maxDurationMs,
            ...(input.maxTotalBytes ? { maxTotalBytes: input.maxTotalBytes } : {}),
          },
        }),
      },
    });
    if (!response.ok) return { ok: false, reasonCode: 'grant_missing' };
    const body = response.body as { ok?: unknown; reasonCode?: unknown; grant?: unknown } | null;
    if (body?.ok !== true) {
      return {
        ok: false,
        reasonCode: typeof body?.reasonCode === 'string' ? body.reasonCode : 'grant_missing',
      };
    }
    const parsed = SignedDirectRouteGrantV1Schema.safeParse(body.grant);
    return parsed.success ? { ok: true, value: parsed.data } : { ok: false, reasonCode: 'grant_invalid' };
  } catch {
    return { ok: false, reasonCode: 'grant_missing' };
  }
}

async function requestTcpTunnelRelayAuthorization(input: Readonly<{
  server: TargetServer;
  credentials: AuthCredentials;
  machineId: string;
  tunnelId: string;
  destination: PeerTcpTunnelDestinationV1;
  maxIdleMs: number;
  maxDurationMs: number;
  maxTotalBytes: number;
  timeoutMs?: number;
  signal?: AbortSignal | null;
}>): Promise<OperationResult<PeerTcpTunnelRelayAuthorizationV1>> {
  try {
    const response = await fetchJson({
      url: joinBaseAndPath(input.server.serverUrl, '/v1/machines/peer/mediation/route-grants'),
      timeoutMs: input.timeoutMs,
      signal: input.signal,
      init: {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${input.credentials.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          machineId: input.machineId,
          flowKind: 'tcp_tunnel',
          routeKind: 'server_relay',
          ttlMs: DIRECT_ROUTE_GRANT_TTL_MS.serverRelayedTcpTunnel,
          destination: input.destination,
          scope: {
            kind: 'tcp_tunnel',
            tunnelId: input.tunnelId,
            allowedPorts: [input.destination.port],
            maxIdleMs: input.maxIdleMs,
            maxDurationMs: input.maxDurationMs,
            maxTotalBytes: input.maxTotalBytes,
          },
        }),
      },
    });
    if (!response.ok) return { ok: false, reasonCode: 'grant_missing' };
    const body = response.body as { ok?: unknown; reasonCode?: unknown; relayAuthorization?: unknown } | null;
    if (body?.ok !== true) {
      return {
        ok: false,
        reasonCode: typeof body?.reasonCode === 'string' ? body.reasonCode : 'grant_missing',
      };
    }
    const parsed = PeerTcpTunnelRelayAuthorizationV1Schema.safeParse(body.relayAuthorization);
    return parsed.success ? { ok: true, value: parsed.data } : { ok: false, reasonCode: 'grant_invalid' };
  } catch {
    return { ok: false, reasonCode: 'grant_missing' };
  }
}

function createTcpTunnelNonceProof(input: Readonly<{
  credentials: AuthCredentials;
  grant: SignedDirectRouteGrantV1;
  endpointFingerprint: string;
}>): OperationResult<PeerRouteNonceProofV1> {
  if (!isLegacyAuthCredentials(input.credentials)) {
    return { ok: false, reasonCode: 'nonce_invalid' };
  }
  try {
    const seed = decodeBase64(input.credentials.secret);
    const keyPair = sodium.crypto_sign_seed_keypair(seed);
    const nonceBase64Url = encodeBase64(getRandomBytes(VOICE_STT_TUNNEL_NONCE_BYTES), 'base64url');
    const signingInput = createPeerRouteNonceSigningInputV1({
      grantId: input.grant.payload.grantId,
      routeKind: 'loopback_direct',
      flowKind: 'tcp_tunnel',
      endpointFingerprint: input.endpointFingerprint,
      nonceBase64Url,
    });
    const signature = sodium.crypto_sign_detached(new TextEncoder().encode(signingInput), keyPair.privateKey);
    return {
      ok: true,
      value: {
        v: 1,
        grantId: input.grant.payload.grantId,
        routeKind: 'loopback_direct',
        flowKind: 'tcp_tunnel',
        endpointFingerprint: input.endpointFingerprint,
        nonceBase64Url,
        signatureBase64Url: encodeBase64(signature, 'base64url'),
      },
    };
  } catch {
    return { ok: false, reasonCode: 'nonce_invalid' };
  }
}

async function postTcpTunnelLoopbackProbe(input: Readonly<{
  url: string;
  request: PeerLoopbackProbeRequestV1;
  timeoutMs?: number;
  signal?: AbortSignal | null;
}>): Promise<PeerLoopbackProbeResponseV1> {
  try {
    const response = await fetchJson({
      url: input.url,
      timeoutMs: input.timeoutMs,
      signal: input.signal,
      init: {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input.request),
      },
    });
    if (!response.ok) {
      return {
        v: 1,
        ok: false,
        receipt: PEER_MEDIATION_RECEIPTS.routeFallback,
        reasonCode: 'grant_invalid',
      };
    }
    const parsed = PeerLoopbackProbeResponseV1Schema.safeParse(response.body);
    return parsed.success ? parsed.data : {
      v: 1,
      ok: false,
      receipt: PEER_MEDIATION_RECEIPTS.routeFallback,
      reasonCode: 'grant_invalid',
    };
  } catch {
    return {
      v: 1,
      ok: false,
      receipt: PEER_MEDIATION_RECEIPTS.routeFallback,
      reasonCode: 'grant_invalid',
    };
  }
}

async function postTcpTunnelOpen(input: Readonly<{
  endpoint: PeerLoopbackEndpointCandidateV1;
  open: PeerTcpTunnelOpenV1;
  timeoutMs?: number;
  signal?: AbortSignal | null;
}>) {
  const response = await fetchJson({
    url: resolveEndpointPath(input.endpoint.url, PEER_TCP_TUNNEL_OPEN_PATH),
    timeoutMs: input.timeoutMs,
    signal: input.signal,
    init: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input.open),
    },
  });
  if (!response.ok) {
    throw new Error('daemon_voice_inference_tcp_tunnel_open_failed');
  }
  return PeerTcpTunnelOpenResponseV1Schema.parse(response.body);
}

async function prepareDirectTunnelRoute(params: TunnelAttemptParams & Readonly<{
  credentials: AuthCredentials;
  endpoint: PeerLoopbackEndpointCandidateV1 | null;
  caps: MachineTunnelCapabilities;
}>): Promise<PreparedDirectTunnelRoute | null> {
  const endpoint = params.endpoint;
  if (!endpoint) return null;
  if (!params.caps.directPeer.allowedPorts.includes(params.destination.port)) return null;

  const requestGrant = async () => await requestTcpTunnelRouteGrant({
    server: params.server,
    credentials: params.credentials,
    machineId: params.input.machineTarget.machineId,
    tunnelId: params.tunnelId,
    endpointFingerprint: endpoint.endpointFingerprint,
    destination: params.destination,
    maxIdleMs: params.caps.directPeer.maxIdleMs,
    maxDurationMs: params.caps.directPeer.maxDurationMs,
    timeoutMs: VOICE_STT_TUNNEL_FETCH_TIMEOUT_MS,
    signal: params.input.signal,
  });
  const createProof = (grant: SignedDirectRouteGrantV1) => createTcpTunnelNonceProof({
    credentials: params.credentials,
    grant,
    endpointFingerprint: endpoint.endpointFingerprint,
  });
  const availability = await resolvePeerLoopbackRouteAvailability({
    serverId: params.server.serverId,
    targetMachineId: params.input.machineTarget.machineId,
    flowKind: 'tcp_tunnel',
    routeKind: 'loopback_direct',
    endpoint,
    cache: voiceSttTunnelRouteAvailabilityCache,
    requestGrant: async () => {
      const grant = await requestGrant();
      return grant.ok ? { ok: true, grant: grant.value } : grant;
    },
    createNonceProof: async ({ grant }) => {
      const nonceProof = createProof(grant);
      return nonceProof.ok ? { ok: true, nonceProof: nonceProof.value } : nonceProof;
    },
    postProbe: async ({ url, request }) => await postTcpTunnelLoopbackProbe({
      url,
      request,
      timeoutMs: VOICE_STT_TUNNEL_FETCH_TIMEOUT_MS,
      signal: params.input.signal,
    }),
  }).catch((): PeerLoopbackRouteAvailabilityResult => ({
    kind: 'fallback',
    receipt: PEER_MEDIATION_RECEIPTS.routeFallback,
    reasonCode: 'topology_unavailable',
  }));
  if (availability.kind === 'fallback') return null;

  const grant = availability.grant
    ? { ok: true as const, value: availability.grant }
    : await requestGrant();
  if (!grant.ok) return null;

  const nonceProof = availability.nonceProof
    ? { ok: true as const, value: availability.nonceProof }
    : createProof(grant.value);
  if (!nonceProof.ok) return null;

  return {
    endpoint: params.endpoint,
    grant: grant.value,
    nonceProof: nonceProof.value,
    availability,
  };
}

function createBinaryOpenBase(input: Readonly<{
  tunnelId: string;
  machineId: string;
  routeKind: 'loopback_direct' | 'server_relay';
  destination: PeerTcpTunnelDestinationV1;
}>): PeerTcpTunnelOpenV1 {
  return {
    v: 1,
    kind: 'open',
    tunnelId: input.tunnelId,
    targetMachineId: input.machineId,
    routeKind: input.routeKind,
    destination: input.destination,
    supportedEncodings: [PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2],
    selectedEncoding: PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
    allowV1Fallback: false,
  };
}

function createSelection(input: Readonly<{
  stream: PeerTcpTunnelClientStream;
  routeKind: 'loopback_direct' | 'server_relay';
  tunnelId: string;
  compatibilityTransport: DaemonSpeechStreamTransport;
  cleanup?: () => Promise<void> | void;
}>): DaemonVoiceInferenceStreamingSttTransportSelection {
  const tunnelTransport = createDaemonSpeechStreamTunnelTransport({
    tunnelId: input.tunnelId,
    stream: input.stream,
    controlTransport: input.compatibilityTransport,
    fallbackTransport: input.compatibilityTransport,
  });
  const close = async () => {
    try {
      await input.stream.close();
    } finally {
      await input.cleanup?.();
    }
  };
  return {
    carrierAdapter: createDaemonSpeechStreamCarrierAdapter({
      routeKind: input.routeKind,
      binaryCapable: true,
    }),
    transport: {
      start: tunnelTransport.start,
      chunk: tunnelTransport.chunk,
      finish: async (payload) => {
        try {
          return await tunnelTransport.finish(payload);
        } finally {
          await close();
        }
      },
      cancel: async (payload) => {
        try {
          return await tunnelTransport.cancel(payload);
        } finally {
          await close();
        }
      },
    },
  };
}

async function tryOpenDirectTunnel(
  params: TunnelAttemptParams & Readonly<{
    direct: PreparedDirectTunnelRoute;
  }>,
): Promise<DaemonVoiceInferenceStreamingSttTransportSelection | null> {
  const directDecision = await resolveRuntimeFeatureDecision({
    featureId: 'machines.tunnel.directPeer',
    serverId: params.server.serverId,
    timeoutMs: VOICE_STT_TUNNEL_FETCH_TIMEOUT_MS,
  }).catch(() => null);
  const open: PeerTcpTunnelOpenV1 = {
    ...createBinaryOpenBase({
      tunnelId: params.tunnelId,
      machineId: params.input.machineTarget.machineId,
      routeKind: 'loopback_direct',
      destination: params.destination,
    }),
    grant: params.direct.grant,
    nonceProof: params.direct.nonceProof,
  };
  const result = await openPeerTcpTunnel({
    open,
    directPeerDecision: directDecision,
    serverRoutedDecision: null,
    resolveLoopback: async () => params.direct.availability,
    postOpen: async ({ open: selectedOpen }) => await postTcpTunnelOpen({
      endpoint: params.direct.endpoint,
      open: selectedOpen,
      timeoutMs: VOICE_STT_TUNNEL_FETCH_TIMEOUT_MS,
      signal: params.input.signal,
    }),
    loopbackEndpointUrl: params.direct.endpoint.url,
  }).catch(() => null);
  if (!result?.ok) return null;
  if (result.response.encoding !== PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2) {
    await Promise.resolve(result.stream.close()).catch(() => {});
    return null;
  }
  return createSelection({
    stream: result.stream,
    routeKind: result.routeKind,
    tunnelId: params.tunnelId,
    compatibilityTransport: params.input.compatibilityTransport,
  });
}

async function tryOpenServerRelayTunnel(
  params: TunnelAttemptParams & Readonly<{
    credentials: AuthCredentials;
    caps: MachineTunnelCapabilities;
    serverFeatures: Parameters<typeof readMachineLiveStreamRelayCaps>[0];
  }>,
): Promise<DaemonVoiceInferenceStreamingSttTransportSelection | null> {
  if (!params.caps.serverRouted.supportedEncodings.includes(PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2)) {
    return null;
  }
  const serverRoutedDecision = await resolveRuntimeFeatureDecision({
    featureId: 'machines.liveStream.serverRouted',
    serverId: params.server.serverId,
    timeoutMs: VOICE_STT_TUNNEL_FETCH_TIMEOUT_MS,
  }).catch(() => null);
  const voiceRelayCaps = readMachineLiveStreamRelayCaps(params.serverFeatures);
  const voiceRelayPolicy = resolveMachineRpcRoutePolicy(RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_STREAM_CHUNK);
  const voiceRelayDecision = resolveMachineRpcRelayFallbackDecision({
    policy: voiceRelayPolicy,
    deploymentKind: 'shared_server',
    relayEnabled: serverRoutedDecision?.state === 'enabled',
    caps: voiceRelayCaps ?? undefined,
  });
  if (!voiceRelayDecision.ok) return null;

  const relayAuthorization = await requestTcpTunnelRelayAuthorization({
    server: params.server,
    credentials: params.credentials,
    machineId: params.input.machineTarget.machineId,
    tunnelId: params.tunnelId,
    destination: params.destination,
    maxIdleMs: Math.min(params.caps.serverRouted.maxIdleMs, voiceRelayDecision.caps.maxDurationMs),
    maxDurationMs: voiceRelayDecision.caps.maxDurationMs,
    maxTotalBytes: voiceRelayDecision.caps.maxTotalBytes,
    timeoutMs: VOICE_STT_TUNNEL_FETCH_TIMEOUT_MS,
    signal: params.input.signal,
  });
  if (!relayAuthorization.ok) return null;

  const relaySocket = await createServerScopedRelaySocket<PeerTcpTunnelRelayEnvelope>({
    machineId: params.input.machineTarget.machineId,
    serverId: params.server.serverId,
    timeoutMs: VOICE_STT_TUNNEL_FETCH_TIMEOUT_MS,
    missingScopeUserProfileErrorMessage: 'Active account profile id is unavailable for daemon speech tunnel relay',
    createActiveTransport: {
      send: (payload) => {
        apiSocket.send(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, payload);
      },
      on: (listener) => apiSocket.onMessage(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, listener),
    },
    createScopedTransport: (socket) => ({
      send: (payload) => {
        socket.emit(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, payload);
      },
      on: (listener) => {
        socket.on(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, listener);
        return () => {
          socket.off(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, listener);
        };
      },
    }),
  }).catch(() => null);
  if (!relaySocket) return null;

  const open: PeerTcpTunnelOpenV1 = {
    ...createBinaryOpenBase({
      tunnelId: params.tunnelId,
      machineId: params.input.machineTarget.machineId,
      routeKind: 'server_relay',
      destination: params.destination,
    }),
    relayAuthorization: relayAuthorization.value,
  };
  const result = await openPeerTcpTunnel({
    open,
    directPeerDecision: null,
    serverRoutedDecision,
    resolveLoopback: async () => ({
      kind: 'fallback',
      receipt: PEER_MEDIATION_RECEIPTS.routeFallback,
      reasonCode: 'direct_route_skipped',
    }),
    postOpen: async () => {
      throw new Error('server_relay_does_not_post_direct_open');
    },
    serverRelayScopeUserId: relaySocket.scopeUserId,
    serverRelaySocket: {
      send: (_event, envelope) => {
        relaySocket.sendEnvelope(envelope);
      },
      onEnvelope: relaySocket.onEnvelope,
    },
  }).catch(() => null);
  if (!result?.ok) {
    relaySocket.disconnect();
    return null;
  }
  if (result.response.encoding !== PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2) {
    await Promise.resolve(result.stream.close()).catch(() => {});
    relaySocket.disconnect();
    return null;
  }
  return createSelection({
    stream: result.stream,
    routeKind: result.routeKind,
    tunnelId: params.tunnelId,
    compatibilityTransport: params.input.compatibilityTransport,
    cleanup: () => {
      relaySocket.disconnect();
    },
  });
}

export async function createProductionDaemonSpeechStreamingSttTransport(
  input: DaemonVoiceInferenceStreamingSttTransportFactoryInput,
): Promise<DaemonVoiceInferenceStreamingSttTransportSelection | null> {
  if (input.signal?.aborted) return null;

  const server = resolveTargetServer(null);
  if (!server) return null;

  const [serverFeatures, credentials] = await Promise.all([
    getReadyServerFeatures({
      serverId: server.serverId,
      timeoutMs: VOICE_STT_TUNNEL_FETCH_TIMEOUT_MS,
    }).catch(() => null),
    TokenStorage.getCredentialsForServerUrl(server.serverUrl, {
      serverId: server.serverId,
    }).catch(() => null),
  ]);
  if (!credentials) return null;

  const port = readDaemonHttpPort({
    serverId: server.serverId,
    machineId: input.machineTarget.machineId,
  });
  if (!port) return null;

  const destination: PeerTcpTunnelDestinationV1 = {
    host: '127.0.0.1',
    port,
  };
  const tunnelId = createDaemonVoiceSttRelayTunnelId({
    machineId: input.machineTarget.machineId,
    requestId: input.requestId,
  });
  const endpoint = readEndpointFromMachineState({
    serverId: server.serverId,
    machineId: input.machineTarget.machineId,
  });
  const caps = readTunnelCapabilities(serverFeatures);
  const direct = await prepareDirectTunnelRoute({
    input,
    server,
    credentials,
    endpoint,
    destination,
    tunnelId,
    caps,
  });
  if (direct) {
    const selection = await tryOpenDirectTunnel({
      input,
      server,
      destination,
      tunnelId,
      direct,
    });
    if (selection) return selection;
  }

  if (input.signal?.aborted) return null;
  return await tryOpenServerRelayTunnel({
    input,
    server,
    credentials,
    destination,
    tunnelId,
    caps,
    serverFeatures,
  });
}
