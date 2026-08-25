import fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  PEER_MEDIATION_RECEIPTS,
  PeerLoopbackEndpointCandidateV1Schema,
  PeerLoopbackProbeRequestV1Schema,
  type DirectPeerRouteKindV1,
  type PeerFlowKindV1,
  type PeerLoopbackEndpointCandidateV1,
  type PeerLoopbackProbeFallbackReasonCodeV1,
  type PeerLoopbackProbeResponseV1,
} from '@happier-dev/protocol';

import {
  createDaemonPeerMediationDirectFlowObserver,
  type DaemonPeerMediationObservabilityEmitter,
} from '../observability/events';
import {
  verifyDirectRouteGrantV1,
  verifyPeerRouteNonceV1,
  type DirectRouteGrantTrustRoot,
} from '../verifyDirectRouteGrantV1';
import {
  registerPeerMediationMachineRpcDirectRoutes,
  type PeerMachineRpcDirectRuntimeOptions,
} from '../rpc/registerRoutes';
import {
  registerMachineLiveStreamRoutes,
  type PeerMachineLiveStreamDirectRuntimeOptions,
} from '../stream/registerRoutes';
import {
  registerPeerTcpTunnelLoopbackRoutes,
  type RegisterPeerTcpTunnelLoopbackRoutesOptions,
} from '../tunnel/registerRoutes';
import { FILES_TRANSFER_CHUNK_CONFIG_MAX_BYTES } from '../../../../configuration/fileTransferLimits';

const ENCRYPTED_TRANSFER_CHUNK_OVERHEAD_BYTES = 1 + 12 + 16;
const MAX_ENCRYPTED_DATA_KEY_ENVELOPE_BYTES = 16 * 1024;
const SIGNED_MACHINE_RPC_ENVELOPE_BUDGET_BYTES = 64 * 1024;
function resolveBase64EncodedLength(decodedBytes: number): number {
  return Math.ceil(decodedBytes / 3) * 4;
}
// The direct RPC route carries configured transfer chunks as base64 inside a signed JSON envelope.
// Keep admission finite while covering the CLI's hard configuration ceiling and encryption overhead.
export const PEER_MEDIATION_LOOPBACK_BODY_LIMIT_BYTES =
  resolveBase64EncodedLength(FILES_TRANSFER_CHUNK_CONFIG_MAX_BYTES + ENCRYPTED_TRANSFER_CHUNK_OVERHEAD_BYTES)
  + resolveBase64EncodedLength(MAX_ENCRYPTED_DATA_KEY_ENVELOPE_BYTES)
  + SIGNED_MACHINE_RPC_ENVELOPE_BUDGET_BYTES;
const PEER_MEDIATION_LOOPBACK_PROBE_PATH = '/peer-mediation/v1/probe';
const PEER_MEDIATION_LOOPBACK_BROWSER_METHODS = 'POST, OPTIONS';
const PEER_MEDIATION_LOOPBACK_BROWSER_HEADERS = 'content-type';

export type PeerMediationLoopbackExpectedBinding = Readonly<{
  accountId: string;
  machineId: string;
  flowKind: PeerFlowKindV1;
  routeKind: DirectPeerRouteKindV1;
  endpointFingerprint: string;
  accountPublicKey?: string;
}>;

/**
 * The tunnel registrar's options minus everything this composition root supplies itself. Named and
 * exported so `rpc/startLoopback.ts` consumes it rather than restating the same `Omit<...>`; the
 * live-stream sibling already follows this shape (`PeerMachineLiveStreamDirectRuntimeOptions`).
 */
export type PeerTcpTunnelDirectRuntimeOptions = Omit<
  RegisterPeerTcpTunnelLoopbackRoutesOptions,
  'nowMs' | 'expected' | 'trustRoots'
>;

export type PeerMediationLoopbackAppOptions = Readonly<{
  nowMs: () => number;
  expected: PeerMediationLoopbackExpectedBinding;
  expectedByFlow?: Partial<Record<PeerFlowKindV1, PeerMediationLoopbackExpectedBinding>>;
  trustRoots: readonly DirectRouteGrantTrustRoot[];
  bodyLimitBytes?: number;
  rpc?: PeerMachineRpcDirectRuntimeOptions;
  stream?: PeerMachineLiveStreamDirectRuntimeOptions;
  tunnel?: PeerTcpTunnelDirectRuntimeOptions;
  /**
   * PMS-9 / P1-9. This composition root is the one place that knows the account, machine, route
   * kind and clock for every direct route, so the emitter is bound here once and each registrar
   * receives an already-scoped observer.
   */
  observability?: DaemonPeerMediationObservabilityEmitter;
}>;

export type StartPeerMediationLoopbackServerOptions = PeerMediationLoopbackAppOptions & Readonly<{
  host?: string;
  port?: number;
  endpointExpiresAt: number;
  directRouteGrantProofVerifierVersions?: readonly 2[];
  daemonRuntimeId?: string;
}>;

export type StartedPeerMediationLoopbackServer = Readonly<{
  app: FastifyInstance;
  url: string;
  endpoint: PeerLoopbackEndpointCandidateV1;
  stop: () => Promise<void>;
}>;
type PeerLoopbackFallbackReasonCode = PeerLoopbackProbeFallbackReasonCodeV1;

function normalizeBindHost(host: string): string {
  const normalized = host.trim().toLowerCase();
  return normalized.startsWith('[') && normalized.endsWith(']') ? normalized.slice(1, -1) : normalized;
}

function isIpv4LoopbackHost(host: string): boolean {
  const parts = host.split('.');
  if (parts.length !== 4 || parts[0] !== '127') return false;
  return parts.slice(1).every((part) => {
    if (!/^\d+$/.test(part)) return false;
    const value = Number(part);
    return Number.isInteger(value) && value >= 0 && value <= 255;
  });
}

export function assertPeerMediationLoopbackBindHost(host: string): string {
  const normalized = normalizeBindHost(host);
  if (normalized === 'localhost' || normalized === '::1' || isIpv4LoopbackHost(normalized)) {
    return normalized === '::1' ? '::1' : host.trim().toLowerCase();
  }
  throw new Error('Peer mediation loopback server must bind to a loopback host');
}

function fallback(reasonCode: PeerLoopbackFallbackReasonCode): PeerLoopbackProbeResponseV1 {
  return {
    v: 1,
    ok: false,
    receipt: PEER_MEDIATION_RECEIPTS.routeFallback,
    reasonCode,
  };
}

function resolveExpectedBindingForFlow(
  options: PeerMediationLoopbackAppOptions,
  flowKind: PeerFlowKindV1,
): PeerMediationLoopbackExpectedBinding {
  return options.expectedByFlow?.[flowKind] ?? options.expected;
}

export function createPeerMediationLoopbackApp(options: PeerMediationLoopbackAppOptions): FastifyInstance {
  const configuredBodyLimit = typeof options.bodyLimitBytes === 'number' && Number.isFinite(options.bodyLimitBytes)
    ? Math.floor(options.bodyLimitBytes)
    : PEER_MEDIATION_LOOPBACK_BODY_LIMIT_BYTES;
  const app = fastify({
    logger: false,
    bodyLimit: Math.max(1024, Math.min(configuredBodyLimit, PEER_MEDIATION_LOOPBACK_BODY_LIMIT_BYTES)),
  });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  // Browser clients reach this loopback-only server from the UI's dev/web
  // origin on a different port. CORS is transport admission only: every
  // operation still requires a server-signed route grant plus an
  // account-signed nonce, so no origin is treated as an authorization
  // boundary. PNA is required by Chromium when a web origin targets a local
  // address. Keep the exposed method/header surface intentionally minimal.
  app.addHook('onRequest', (request, reply, done) => {
    if (request.headers.origin) {
      reply.header('Access-Control-Allow-Origin', '*');
      reply.header('Access-Control-Allow-Methods', PEER_MEDIATION_LOOPBACK_BROWSER_METHODS);
      reply.header('Access-Control-Allow-Headers', PEER_MEDIATION_LOOPBACK_BROWSER_HEADERS);
      if (request.headers['access-control-request-private-network'] === 'true') {
        reply.header('Access-Control-Allow-Private-Network', 'true');
      }
    }
    if (request.method === 'OPTIONS') {
      void reply.code(204).send();
      return;
    }
    done();
  });
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.post(PEER_MEDIATION_LOOPBACK_PROBE_PATH, async (request): Promise<PeerLoopbackProbeResponseV1> => {
    const parsedRequest = PeerLoopbackProbeRequestV1Schema.safeParse(request.body);
    if (!parsedRequest.success) return fallback('grant_invalid');
    const expected = resolveExpectedBindingForFlow(options, parsedRequest.data.grant.payload.flowKind);

    const verification = verifyDirectRouteGrantV1({
      grant: parsedRequest.data.grant,
      trustRoots: options.trustRoots,
      nowMs: options.nowMs(),
      expected: {
        accountId: expected.accountId,
        machineId: expected.machineId,
        flowKind: expected.flowKind,
        routeKind: expected.routeKind,
        endpointFingerprint: expected.endpointFingerprint,
      },
    });
    if (!verification.valid) return fallback(verification.reasonCode);

    if (!expected.accountPublicKey) return fallback('nonce_invalid');
    const nonceVerification = verifyPeerRouteNonceV1({
      proof: parsedRequest.data.nonceProof,
      accountPublicKey: expected.accountPublicKey,
      expected: {
        grantId: verification.payload.grantId,
        routeKind: verification.payload.routeKind,
        flowKind: verification.payload.flowKind,
        endpointFingerprint: verification.payload.endpointFingerprint,
      },
    });
    if (!nonceVerification.valid) return fallback(nonceVerification.reasonCode);

    return {
      v: 1,
      ok: true,
      receipt: PEER_MEDIATION_RECEIPTS.routeSelected,
      routeKind: 'loopback_direct',
      flowKind: verification.payload.flowKind,
      endpointFingerprint: verification.payload.endpointFingerprint ?? expected.endpointFingerprint,
    };
  });

  const directFlowObserverFor = (expected: PeerMediationLoopbackExpectedBinding) => (
    createDaemonPeerMediationDirectFlowObserver({
      ...(options.observability ? { observability: options.observability } : {}),
      accountId: expected.accountId,
      machineId: expected.machineId,
      routeKind: expected.routeKind,
      nowMs: options.nowMs,
    })
  );

  if (options.rpc) {
    const expected = resolveExpectedBindingForFlow(options, 'machine_rpc');
    registerPeerMediationMachineRpcDirectRoutes(app, {
      ...options.rpc,
      nowMs: options.nowMs,
      expected,
      observability: directFlowObserverFor(expected),
      trustRoots: options.trustRoots,
    });
  }

  if (options.stream) {
    const expected = resolveExpectedBindingForFlow(options, 'live_stream');
    registerMachineLiveStreamRoutes(app, {
      ...options.stream,
      nowMs: options.nowMs,
      expected,
      observability: directFlowObserverFor(expected),
      trustRoots: options.trustRoots,
    });
  }

  if (options.tunnel) {
    const expected = resolveExpectedBindingForFlow(options, 'tcp_tunnel');
    registerPeerTcpTunnelLoopbackRoutes(app, {
      ...options.tunnel,
      nowMs: options.nowMs,
      observability: directFlowObserverFor(expected),
      expected: {
        accountId: expected.accountId,
        machineId: expected.machineId,
        endpointFingerprint: expected.endpointFingerprint,
        accountPublicKey: expected.accountPublicKey,
      },
      trustRoots: options.trustRoots,
    });
  }

  return app;
}

function formatLoopbackUrlHost(host: string): string {
  return normalizeBindHost(host) === '::1' ? '[::1]' : host;
}

export async function startPeerMediationLoopbackServer(
  options: StartPeerMediationLoopbackServerOptions,
): Promise<StartedPeerMediationLoopbackServer> {
  const host = assertPeerMediationLoopbackBindHost(options.host ?? '127.0.0.1');
  const app = createPeerMediationLoopbackApp(options);
  const address = await app.listen({ host, port: options.port ?? 0 });
  const parsedAddress = new URL(address);
  const url = `http://${formatLoopbackUrlHost(host)}:${parsedAddress.port}${PEER_MEDIATION_LOOPBACK_PROBE_PATH}`;
  const endpoint = PeerLoopbackEndpointCandidateV1Schema.parse({
    v: 1,
    routeKind: 'loopback_direct',
    url,
    endpointFingerprint: options.expected.endpointFingerprint,
    expiresAt: options.endpointExpiresAt,
    directRouteGrantProofVerifierVersions: options.directRouteGrantProofVerifierVersions ?? [],
  });
  return {
    app,
    url,
    endpoint,
    stop: () => app.close(),
  };
}
