import { z } from 'zod';
import {
    DIRECT_ROUTE_GRANT_TTL_MS,
    MachineLiveStreamCapsV1Schema,
    MachineLiveStreamRelayAuthorizationV1Schema,
    MachineLiveStreamStartRequestV1Schema,
    PEER_MEDIATION_RECEIPTS,
    PeerLoopbackEndpointCandidateV1Schema,
    PeerLoopbackProbeResponseV1Schema,
    SignedDirectRouteGrantV1Schema,
    createPeerRouteNonceSigningInputV1,
    type MachineLiveStreamCapsV1,
    type MachineLiveStreamRelayAuthorizationV1,
    type MachineLiveStreamStartRequestV1,
    type PeerLoopbackEndpointCandidateV1,
    type PeerLoopbackProbeRequestV1,
    type PeerLoopbackProbeResponseV1,
    type PeerRouteNonceProofV1,
    type SignedDirectRouteGrantV1,
} from '@happier-dev/protocol';

import { isLegacyAuthCredentials, type AuthCredentials } from '@/auth/storage/tokenStorage';
import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import sodium from '@/encryption/libsodium.lib';
import { getRandomBytes } from '@/platform/cryptoRandom';
import {
    areServerProfileIdentifiersEquivalent,
    getServerProfileById,
    resolveServerProfileScopeId,
} from '@/sync/domains/server/serverProfiles';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { storage } from '@/sync/domains/state/storage';

export const MACHINE_LIVE_STREAM_DIRECT_FETCH_TIMEOUT_MS = 5_000;

const MACHINE_LIVE_STREAM_DIRECT_NONCE_BYTES = 16;
const PEER_MACHINE_LIVE_STREAM_DIRECT_START_PATH_V1 = '/peer-mediation/v1/live-stream/start';

const MachineLiveStreamDirectStartResponseSchema = z.discriminatedUnion('ok', [
    z.object({
        v: z.literal(1),
        ok: z.literal(true),
        receipt: z.literal(PEER_MEDIATION_RECEIPTS.streamStarted),
        streamId: z.string().min(1),
        routeKind: z.literal('loopback_direct'),
        expiresAtMs: z.number().int().positive(),
    }).passthrough(),
    z.object({
        v: z.literal(1),
        ok: z.literal(false),
        receipt: z.literal(PEER_MEDIATION_RECEIPTS.routeFallback),
        reasonCode: z.string().min(1),
    }).passthrough(),
]);

export type MachineLiveStreamDirectStartResponse = z.infer<typeof MachineLiveStreamDirectStartResponseSchema>;

export type TargetServer = Readonly<{
    serverId: string;
    serverUrl: string;
}>;

export type OperationResult<T> =
    | Readonly<{ ok: true; value: T }>
    | Readonly<{ ok: false; reasonCode: string }>;

export type MachineLiveStreamUnsignedStartRequest = Readonly<{
    v: 1;
    streamId: string;
    streamFamily: string;
    routeKind: 'loopback_direct' | 'server_relay';
    sourceMachineId: string;
    targetMachineId: string;
    maxBitrateBps: number;
    maxFramesPerSecond: number;
    maxFrameBytes: number;
    maxDurationMs: number;
    maxTotalBytes?: number;
}>;

function normalizeId(raw: unknown): string {
    return String(raw ?? '').trim();
}

function normalizeBaseUrl(serverUrl: string): string {
    return String(serverUrl ?? '').trim().replace(/\/+$/, '');
}

function joinBaseAndPath(serverUrl: string, path: string): string {
    return `${normalizeBaseUrl(serverUrl)}${path.startsWith('/') ? path : `/${path}`}`;
}

export function resolveTargetServer(serverId: string | null | undefined): TargetServer | null {
    const active = getActiveServerSnapshot();
    const activeServerId = normalizeId(active.serverId);
    const requestedServerId = normalizeId(serverId) || activeServerId;
    if (!requestedServerId) return null;
    if (areServerProfileIdentifiersEquivalent(requestedServerId, activeServerId)) {
        const serverUrl = normalizeBaseUrl(active.serverUrl);
        return serverUrl ? { serverId: activeServerId, serverUrl } : null;
    }
    const profile = getServerProfileById(requestedServerId);
    const serverUrl = normalizeBaseUrl(profile?.serverUrl ?? '');
    return profile && serverUrl ? { serverId: resolveServerProfileScopeId(profile), serverUrl } : null;
}

export function readEndpointFromMachineState(input: Readonly<{
    serverId: string;
    machineId: string;
}>): PeerLoopbackEndpointCandidateV1 | null {
    const state = storage.getState();
    const scopedMachines = state.machineListByServerId?.[input.serverId];
    const scopedMachine = Array.isArray(scopedMachines)
        ? scopedMachines.find((machine) => machine.id === input.machineId) ?? null
        : null;
    const machine = scopedMachine ?? state.machines[input.machineId] ?? null;
    const endpoint = machine?.daemonState?.peerMediation?.loopback?.endpoint;
    const parsed = PeerLoopbackEndpointCandidateV1Schema.safeParse(endpoint);
    return parsed.success ? parsed.data : null;
}

async function fetchJson(params: Readonly<{
    url: string;
    init: RequestInit;
    timeoutMs?: number;
}>): Promise<Readonly<{ ok: boolean; status: number; body: unknown }>> {
    const timeoutMs = typeof params.timeoutMs === 'number' && params.timeoutMs > 0
        ? params.timeoutMs
        : MACHINE_LIVE_STREAM_DIRECT_FETCH_TIMEOUT_MS;
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timeoutId = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
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
    }
}

export function createBaseStartRequest(input: Readonly<{
    sourceMachineId: string;
    targetMachineId: string;
    routeKind: 'loopback_direct' | 'server_relay';
    streamId: string;
    streamFamily: string;
    caps: MachineLiveStreamCapsV1;
}>): MachineLiveStreamUnsignedStartRequest {
    const caps = MachineLiveStreamCapsV1Schema.parse(input.caps);
    return {
        v: 1,
        streamId: input.streamId,
        streamFamily: input.streamFamily,
        routeKind: input.routeKind,
        sourceMachineId: input.sourceMachineId,
        targetMachineId: input.targetMachineId,
        maxBitrateBps: caps.maxBitrateBps,
        maxFramesPerSecond: caps.maxFramesPerSecond,
        maxFrameBytes: caps.maxFrameBytes,
        maxDurationMs: caps.maxDurationMs,
        ...(caps.maxTotalBytes ? { maxTotalBytes: caps.maxTotalBytes } : {}),
    };
}

export function createLiveStreamStartRequest(input: Readonly<{
    baseRequest: MachineLiveStreamUnsignedStartRequest;
    authorization?: MachineLiveStreamRelayAuthorizationV1;
}>): MachineLiveStreamStartRequestV1 {
    return MachineLiveStreamStartRequestV1Schema.parse({
        ...input.baseRequest,
        ...(input.authorization ? { authorization: input.authorization } : {}),
    });
}

export async function requestLiveStreamRouteGrant(input: Readonly<{
    server: TargetServer;
    credentials: AuthCredentials;
    sourceMachineId: string;
    endpointFingerprint: string;
    streamId: string;
    streamFamily: string;
    caps: MachineLiveStreamCapsV1;
    timeoutMs?: number;
}>): Promise<OperationResult<SignedDirectRouteGrantV1>> {
    try {
        const response = await fetchJson({
            url: joinBaseAndPath(input.server.serverUrl, '/v1/machines/peer/mediation/route-grants'),
            timeoutMs: input.timeoutMs,
            init: {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${input.credentials.token}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    machineId: input.sourceMachineId,
                    flowKind: 'live_stream',
                    routeKind: 'loopback_direct',
                    endpointFingerprint: input.endpointFingerprint,
                    ttlMs: DIRECT_ROUTE_GRANT_TTL_MS.directLiveStream,
                    scope: {
                        kind: 'live_stream',
                        streamId: input.streamId,
                        streamFamily: input.streamFamily,
                        maxBitrateBps: input.caps.maxBitrateBps,
                        maxDurationMs: input.caps.maxDurationMs,
                        ...(input.caps.maxTotalBytes ? { maxTotalBytes: input.caps.maxTotalBytes } : {}),
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

export function createLiveStreamNonceProof(input: Readonly<{
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
        const nonceBase64Url = encodeBase64(getRandomBytes(MACHINE_LIVE_STREAM_DIRECT_NONCE_BYTES), 'base64url');
        const signingInput = createPeerRouteNonceSigningInputV1({
            grantId: input.grant.payload.grantId,
            routeKind: 'loopback_direct',
            flowKind: 'live_stream',
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
                flowKind: 'live_stream',
                endpointFingerprint: input.endpointFingerprint,
                nonceBase64Url,
                signatureBase64Url: encodeBase64(signature, 'base64url'),
            },
        };
    } catch {
        return { ok: false, reasonCode: 'nonce_invalid' };
    }
}

export async function postLiveStreamLoopbackProbe(input: Readonly<{
    url: string;
    request: PeerLoopbackProbeRequestV1;
    timeoutMs?: number;
}>): Promise<PeerLoopbackProbeResponseV1> {
    try {
        const response = await fetchJson({
            url: input.url,
            timeoutMs: input.timeoutMs,
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

function resolveDirectStreamStartUrl(endpointUrl: string): string {
    const parsed = new URL(endpointUrl);
    parsed.pathname = PEER_MACHINE_LIVE_STREAM_DIRECT_START_PATH_V1;
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
}

export async function postLiveStreamDirectStart(input: Readonly<{
    endpoint: PeerLoopbackEndpointCandidateV1;
    grant: SignedDirectRouteGrantV1;
    nonceProof: PeerRouteNonceProofV1;
    startRequest: MachineLiveStreamStartRequestV1;
    timeoutMs?: number;
}>): Promise<OperationResult<MachineLiveStreamDirectStartResponse>> {
    try {
        const response = await fetchJson({
            url: resolveDirectStreamStartUrl(input.endpoint.url),
            timeoutMs: input.timeoutMs,
            init: {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    v: 1,
                    streamId: input.startRequest.streamId,
                    streamFamily: input.startRequest.streamFamily,
                    routeKind: 'loopback_direct',
                    flowKind: 'live_stream',
                    endpointFingerprint: input.endpoint.endpointFingerprint,
                    grant: input.grant,
                    nonceProof: input.nonceProof,
                    startRequest: input.startRequest,
                }),
            },
        });
        if (!response.ok) return { ok: false, reasonCode: 'topology_unavailable' };
        const parsed = MachineLiveStreamDirectStartResponseSchema.safeParse(response.body);
        if (!parsed.success) return { ok: false, reasonCode: 'invalid_request' };
        return parsed.data.ok
            ? { ok: true, value: parsed.data }
            : { ok: false, reasonCode: parsed.data.reasonCode };
    } catch {
        return { ok: false, reasonCode: 'topology_unavailable' };
    }
}

export async function requestLiveStreamRelayAuthorization(input: Readonly<{
    server: TargetServer;
    credentials: AuthCredentials;
    startRequest: MachineLiveStreamUnsignedStartRequest;
    timeoutMs?: number;
}>): Promise<OperationResult<MachineLiveStreamRelayAuthorizationV1>> {
    try {
        const response = await fetchJson({
            url: joinBaseAndPath(input.server.serverUrl, '/v1/machines/peer/mediation/route-grants'),
            timeoutMs: input.timeoutMs,
            init: {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${input.credentials.token}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    machineId: input.startRequest.sourceMachineId,
                    targetMachineId: input.startRequest.targetMachineId,
                    flowKind: 'live_stream',
                    routeKind: 'server_relay',
                    ttlMs: DIRECT_ROUTE_GRANT_TTL_MS.serverRelayedLiveStream,
                    maxFramesPerSecond: input.startRequest.maxFramesPerSecond,
                    maxFrameBytes: input.startRequest.maxFrameBytes,
                    scope: {
                        kind: 'live_stream',
                        streamId: input.startRequest.streamId,
                        streamFamily: input.startRequest.streamFamily,
                        maxBitrateBps: input.startRequest.maxBitrateBps,
                        maxDurationMs: input.startRequest.maxDurationMs,
                        ...(input.startRequest.maxTotalBytes
                            ? { maxTotalBytes: input.startRequest.maxTotalBytes }
                            : {}),
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
        const parsed = MachineLiveStreamRelayAuthorizationV1Schema.safeParse(body.relayAuthorization);
        return parsed.success ? { ok: true, value: parsed.data } : { ok: false, reasonCode: 'grant_invalid' };
    } catch {
        return { ok: false, reasonCode: 'grant_missing' };
    }
}
