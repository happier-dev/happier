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

const PEER_MEDIATION_LOOPBACK_BODY_LIMIT_BYTES = 64 * 1024;
const PEER_MEDIATION_LOOPBACK_PROBE_PATH = '/peer-mediation/v1/probe';

export type PeerMediationLoopbackExpectedBinding = Readonly<{
  accountId: string;
  machineId: string;
  flowKind: PeerFlowKindV1;
  routeKind: DirectPeerRouteKindV1;
  endpointFingerprint: string;
  accountPublicKey: string;
}>;

export type PeerMediationLoopbackAppOptions = Readonly<{
  nowMs: () => number;
  expected: PeerMediationLoopbackExpectedBinding;
  expectedByFlow?: Partial<Record<PeerFlowKindV1, PeerMediationLoopbackExpectedBinding>>;
  trustRoots: readonly DirectRouteGrantTrustRoot[];
  revokedGrantIds?: ReadonlySet<string>;
  revokedGrantFamilyIds?: ReadonlySet<string>;
  bodyLimitBytes?: number;
  rpc?: PeerMachineRpcDirectRuntimeOptions;
  stream?: PeerMachineLiveStreamDirectRuntimeOptions;
  tunnel?: Omit<RegisterPeerTcpTunnelLoopbackRoutesOptions, 'nowMs' | 'expected' | 'trustRoots' | 'revokedGrantIds' | 'revokedGrantFamilyIds'>;
}>;

export type StartPeerMediationLoopbackServerOptions = PeerMediationLoopbackAppOptions & Readonly<{
  host?: string;
  port?: number;
  endpointExpiresAt: number;
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
  const app = fastify({
    logger: false,
    bodyLimit: Math.max(1024, options.bodyLimitBytes ?? PEER_MEDIATION_LOOPBACK_BODY_LIMIT_BYTES),
  });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
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
      revokedGrantIds: options.revokedGrantIds,
      revokedGrantFamilyIds: options.revokedGrantFamilyIds,
    });
    if (!verification.valid) return fallback(verification.reasonCode);

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

  if (options.rpc) {
    const expected = resolveExpectedBindingForFlow(options, 'machine_rpc');
    registerPeerMediationMachineRpcDirectRoutes(app, {
      ...options.rpc,
      nowMs: options.nowMs,
      expected,
      trustRoots: options.trustRoots,
      revokedGrantIds: options.revokedGrantIds,
      revokedGrantFamilyIds: options.revokedGrantFamilyIds,
    });
  }

  if (options.stream) {
    const expected = resolveExpectedBindingForFlow(options, 'live_stream');
    registerMachineLiveStreamRoutes(app, {
      ...options.stream,
      nowMs: options.nowMs,
      expected,
      trustRoots: options.trustRoots,
      revokedGrantIds: options.revokedGrantIds,
      revokedGrantFamilyIds: options.revokedGrantFamilyIds,
    });
  }

  if (options.tunnel) {
    const expected = resolveExpectedBindingForFlow(options, 'tcp_tunnel');
    registerPeerTcpTunnelLoopbackRoutes(app, {
      ...options.tunnel,
      nowMs: options.nowMs,
      expected: {
        accountId: expected.accountId,
        machineId: expected.machineId,
        endpointFingerprint: expected.endpointFingerprint,
        accountPublicKey: expected.accountPublicKey,
      },
      trustRoots: options.trustRoots,
      revokedGrantIds: options.revokedGrantIds,
      revokedGrantFamilyIds: options.revokedGrantFamilyIds,
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
  });
  return {
    app,
    url,
    endpoint,
    stop: () => app.close(),
  };
}
