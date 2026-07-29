import {
    readServerEnabledBit,
    createEphemeralPeerRouteProofHandleV2,
    type FeaturesResponse,
    type MachineLiveStreamCapsV1,
    type MachineLiveStreamRelayAuthorizationV1,
    type MachineLiveStreamStartRequestV1,
    type PeerRouteNonceProofV1,
    type SignedDirectRouteGrantV1,
} from '@happier-dev/protocol';
import { createPeerRouteViabilityCache } from '@happier-dev/peer-mediation';

import { TokenStorage } from '@/auth/storage/tokenStorage';
import { getReadyServerFeatures } from '@/sync/api/capabilities/getReadyServerFeatures';
import { getRandomBytes } from '@/platform/cryptoRandom';
import { resolvePeerRouteCallerProofNegotiation } from '../identity/proofNegotiation';
import { resolvePeerRouteSigningReadiness } from '../identity/signingReadiness';

import { resolvePeerLoopbackRouteAvailability } from '../loopback/resolvePeerLoopbackRouteAvailability';
import {
    MACHINE_LIVE_STREAM_DIRECT_FETCH_TIMEOUT_MS,
    createBaseStartRequest,
    createLiveStreamStartRequest,
    createLiveStreamNonceProof,
    postLiveStreamDirectStart,
    postLiveStreamDirectStartV2,
    postLiveStreamLoopbackProbe,
    readEndpointFromMachineState,
    requestLiveStreamRelayAuthorization,
    requestLiveStreamRouteGrant,
    requestLiveStreamRouteGrantV2,
    resolveTargetServer,
    type MachineLiveStreamDirectStartResponse,
    type MachineLiveStreamUnsignedStartRequest,
} from './productionRouteHttp';

const MACHINE_LIVE_STREAM_DIRECT_CACHE_POSITIVE_TTL_MS = 30_000;
const MACHINE_LIVE_STREAM_DIRECT_CACHE_NEGATIVE_TTL_MS = 5_000;

export type ProductionMachineLiveStreamStartResult =
    | Readonly<{
        ok: true;
        routeKind: 'loopback_direct';
        response: MachineLiveStreamDirectStartResponse;
    }>
    | Readonly<{
        ok: true;
        routeKind: 'server_relay';
        startRequest: MachineLiveStreamStartRequestV1;
        relayAuthorization: MachineLiveStreamRelayAuthorizationV1;
    }>
    | Readonly<{
        ok: false;
        reasonCode: string;
        requiredCapability?: string;
    }>;

const liveStreamRouteAvailabilityCache = createPeerRouteViabilityCache({
    now: Date.now,
    positiveTtlMs: MACHINE_LIVE_STREAM_DIRECT_CACHE_POSITIVE_TTL_MS,
    negativeTtlMs: MACHINE_LIVE_STREAM_DIRECT_CACHE_NEGATIVE_TTL_MS,
});

async function resolveServerFeatures(input: Readonly<{
    serverId: string;
    timeoutMs?: number;
}>): Promise<FeaturesResponse | null> {
    return await getReadyServerFeatures({
        serverId: input.serverId,
        timeoutMs: input.timeoutMs ?? MACHINE_LIVE_STREAM_DIRECT_FETCH_TIMEOUT_MS,
    }).catch(() => null);
}

async function startServerRelayedStream(input: Readonly<{
    server: Readonly<{ serverId: string; serverUrl: string }>;
    credentials: Awaited<ReturnType<typeof TokenStorage.getCredentialsForServerUrl>>;
    startRequest: MachineLiveStreamUnsignedStartRequest;
    timeoutMs?: number;
}>): Promise<ProductionMachineLiveStreamStartResult> {
    if (!input.credentials) return { ok: false, reasonCode: 'grant_missing' };
    const relayAuthorization = await requestLiveStreamRelayAuthorization({
        server: input.server,
        credentials: input.credentials,
        startRequest: input.startRequest,
        timeoutMs: input.timeoutMs,
    });
    if (!relayAuthorization.ok) return { ok: false, reasonCode: relayAuthorization.reasonCode };
    const authorizedStartRequest = createLiveStreamStartRequest({
        baseRequest: input.startRequest,
        authorization: relayAuthorization.value,
    });
    return {
        ok: true,
        routeKind: 'server_relay',
        startRequest: authorizedStartRequest,
        relayAuthorization: relayAuthorization.value,
    };
}

async function resolveDirectAuthorization(input: Readonly<{
    server: Readonly<{ serverId: string; serverUrl: string }>;
    credentials: NonNullable<Awaited<ReturnType<typeof TokenStorage.getCredentialsForServerUrl>>>;
    sourceMachineId: string;
    streamId: string;
    streamFamily: string;
    caps: MachineLiveStreamCapsV1;
    timeoutMs?: number;
}>): Promise<Readonly<{
    ok: true;
    endpoint: NonNullable<ReturnType<typeof readEndpointFromMachineState>>;
    grant: SignedDirectRouteGrantV1;
    nonceProof: PeerRouteNonceProofV1;
}> | Readonly<{ ok: false; reasonCode: string }>> {
    const endpoint = readEndpointFromMachineState({
        serverId: input.server.serverId,
        machineId: input.sourceMachineId,
    });
    if (!endpoint) return { ok: false, reasonCode: 'topology_unavailable' };

    const requestGrant = async () => await requestLiveStreamRouteGrant({
        server: input.server,
        credentials: input.credentials,
        sourceMachineId: input.sourceMachineId,
        endpointFingerprint: endpoint.endpointFingerprint,
        streamId: input.streamId,
        streamFamily: input.streamFamily,
        caps: input.caps,
        timeoutMs: input.timeoutMs,
    });
    const createProof = (grant: SignedDirectRouteGrantV1) => createLiveStreamNonceProof({
        credentials: input.credentials,
        grant,
        endpointFingerprint: endpoint.endpointFingerprint,
    });

    const availability = await resolvePeerLoopbackRouteAvailability({
        serverId: input.server.serverId,
        targetMachineId: input.sourceMachineId,
        flowKind: 'live_stream',
        routeKind: 'loopback_direct',
        endpoint,
        cache: liveStreamRouteAvailabilityCache,
        requestGrant: async () => {
            const grant = await requestGrant();
            return grant.ok ? { ok: true, grant: grant.value } : grant;
        },
        createNonceProof: async ({ grant }) => {
            const nonceProof = createProof(grant);
            return nonceProof.ok ? { ok: true, nonceProof: nonceProof.value } : nonceProof;
        },
        postProbe: async ({ url, request }) => await postLiveStreamLoopbackProbe({
            url,
            request,
            timeoutMs: input.timeoutMs,
        }),
    });
    if (availability.kind === 'fallback') return { ok: false, reasonCode: availability.reasonCode };

    const grant = availability.grant
        ? { ok: true as const, value: availability.grant }
        : await requestGrant();
    if (!grant.ok) return { ok: false, reasonCode: grant.reasonCode };
    const nonceProof = availability.nonceProof
        ? { ok: true as const, value: availability.nonceProof }
        : createProof(grant.value);
    if (!nonceProof.ok) return { ok: false, reasonCode: nonceProof.reasonCode };
    return {
        ok: true,
        endpoint,
        grant: grant.value,
        nonceProof: nonceProof.value,
    };
}

export async function startProductionMachineLiveStream(input: Readonly<{
    serverId?: string | null;
    sourceMachineId: string;
    targetMachineId: string;
    routeKind: 'loopback_direct' | 'server_relay';
    streamId: string;
    streamFamily: string;
    // Per-tab viewer socket id (W1-C-2). Threaded into the base start request so it reaches both
    // the server mint body and the signed start request; the protocol superRefine then asserts the
    // start request and the minted grant agree on it.
    viewerSocketId?: string | null;
    caps: MachineLiveStreamCapsV1;
    timeoutMs?: number;
}>): Promise<ProductionMachineLiveStreamStartResult> {
    const server = resolveTargetServer(input.serverId);
    if (!server) return { ok: false, reasonCode: 'topology_unavailable' };

    const serverFeatures = await resolveServerFeatures({
        serverId: server.serverId,
        timeoutMs: input.timeoutMs,
    });
    if (!serverFeatures) return { ok: false, reasonCode: 'server_features_unavailable' };

    const credentials = await TokenStorage.getCredentialsForServerUrl(server.serverUrl, {
        serverId: server.serverId,
    });
    if (!credentials) return { ok: false, reasonCode: 'grant_missing' };

    const baseStartRequest = createBaseStartRequest(input);
    if (input.routeKind === 'server_relay') {
        if (readServerEnabledBit(serverFeatures, 'machines.liveStream.serverRouted') !== true) {
            return { ok: false, reasonCode: 'server_relay_disabled' };
        }
        return await startServerRelayedStream({
            server,
            credentials,
            startRequest: baseStartRequest,
            timeoutMs: input.timeoutMs,
        });
    }

    if (readServerEnabledBit(serverFeatures, 'machines.liveStream.directPeer') !== true) {
        return { ok: false, reasonCode: 'server_direct_disabled' };
    }
    const signingReadiness = resolvePeerRouteSigningReadiness(credentials);
    if (signingReadiness.status === 'unavailable') {
        const preflight = resolvePeerRouteCallerProofNegotiation({ credentials, serverFeatures });
        if (preflight.kind === 'unavailable') {
            return {
                ok: false,
                reasonCode: preflight.reasonCode,
                ...(preflight.requiredCapability ? { requiredCapability: preflight.requiredCapability } : {}),
            };
        }
        if (preflight.kind !== 'ephemeral_v2_endpoint_required') {
            return { ok: false, reasonCode: 'grant_invalid' };
        }
        const endpoint = readEndpointFromMachineState({
            serverId: server.serverId,
            machineId: input.sourceMachineId,
        });
        const negotiation = resolvePeerRouteCallerProofNegotiation({ credentials, serverFeatures, endpoint });
        if (negotiation.kind === 'unavailable') {
            return {
                ok: false,
                reasonCode: negotiation.reasonCode,
                ...(negotiation.requiredCapability ? { requiredCapability: negotiation.requiredCapability } : {}),
            };
        }
        if (negotiation.kind !== 'ephemeral_v2' || !endpoint) {
            return { ok: false, reasonCode: 'grant_invalid' };
        }
        const proofHandle = createEphemeralPeerRouteProofHandleV2({ randomBytes: getRandomBytes });
        try {
            const grant = await requestLiveStreamRouteGrantV2({
                server,
                credentials,
                sourceMachineId: input.sourceMachineId,
                endpointFingerprint: endpoint.endpointFingerprint,
                streamId: input.streamId,
                streamFamily: input.streamFamily,
                caps: input.caps,
                ephemeralPublicKeyBase64Url: proofHandle.publicKeyBase64Url,
                timeoutMs: input.timeoutMs,
            });
            if (!grant.ok) return { ok: false, reasonCode: grant.reasonCode };
            const proof = proofHandle.sign(grant.value);
            const startRequest = createLiveStreamStartRequest({ baseRequest: baseStartRequest });
            const response = await postLiveStreamDirectStartV2({
                endpoint,
                grant: grant.value,
                proof,
                startRequest,
                timeoutMs: input.timeoutMs,
            });
            return response.ok
                ? { ok: true, routeKind: 'loopback_direct', response: response.value }
                : { ok: false, reasonCode: response.reasonCode };
        } catch {
            return { ok: false, reasonCode: 'grant_invalid' };
        } finally {
            proofHandle.dispose();
        }
    }
    const authorization = await resolveDirectAuthorization({
        server,
        credentials,
        sourceMachineId: input.sourceMachineId,
        streamId: input.streamId,
        streamFamily: input.streamFamily,
        caps: input.caps,
        timeoutMs: input.timeoutMs,
    });
    if (!authorization.ok) return { ok: false, reasonCode: authorization.reasonCode };

    const startRequest = createLiveStreamStartRequest({ baseRequest: baseStartRequest });
    const response = await postLiveStreamDirectStart({
        endpoint: authorization.endpoint,
        grant: authorization.grant,
        nonceProof: authorization.nonceProof,
        startRequest,
        timeoutMs: input.timeoutMs,
    });
    return response.ok
        ? { ok: true, routeKind: 'loopback_direct', response: response.value }
        : { ok: false, reasonCode: response.reasonCode };
}
