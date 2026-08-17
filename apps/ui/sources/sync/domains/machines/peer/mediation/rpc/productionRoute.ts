import {
    DIRECT_ROUTE_GRANT_TTL_MS,
    PEER_MEDIATION_RECEIPTS,
    PeerLoopbackEndpointCandidateV1Schema,
    PeerLoopbackProbeResponseV1Schema,
    PeerMachineRpcDirectResponseV1Schema,
    PeerMachineRpcDirectResponseV2Schema,
    SignedDirectRouteGrantV1Schema,
    SignedDirectRouteGrantV2Schema,
    createEphemeralPeerRouteProofHandleV2,
    createPeerRouteNonceSigningInputV1,
    type DirectPeerRouteKindV1,
    type PeerFlowKindV1,
    type PeerLoopbackEndpointCandidateV1,
    type PeerLoopbackProbeRequestV1,
    type PeerLoopbackProbeResponseV1,
    type PeerMachineRpcDirectFallbackReasonCodeV1,
    type PeerMachineRpcDirectRequestV1,
    type PeerMachineRpcDirectRequestV2,
    type PeerMachineRpcDirectResponseV1,
    type PeerMachineRpcDirectResponseV2,
    type PeerRouteNonceProofV1,
    type SignedDirectRouteGrantV1,
    type SignedDirectRouteGrantV2,
} from '@happier-dev/protocol';
import { createPeerRouteViabilityCache } from '@happier-dev/peer-mediation';

import { TokenStorage, isLegacyAuthCredentials, type AuthCredentials } from '@/auth/storage/tokenStorage';
import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import sodium from '@/encryption/libsodium.lib';
import { getRandomBytes } from '@/platform/cryptoRandom';
import { getReadyServerFeatures } from '@/sync/api/capabilities/getReadyServerFeatures';
import {
    areServerProfileIdentifiersEquivalent,
    getServerProfileById,
    resolveServerProfileScopeId,
} from '@/sync/domains/server/serverProfiles';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { storage } from '@/sync/domains/state/storage';

import { resolvePeerLoopbackRouteAvailability } from '../loopback/resolvePeerLoopbackRouteAvailability';
import type { PeerLoopbackRouteAvailabilityResult } from '../loopback/resolvePeerLoopbackRouteAvailability';
import type { MachineRpcDirectRouteResolution } from './client';
import { resolveMachineRpcDirectRoutePreflight } from './directRoutePreflight';

const MACHINE_RPC_DIRECT_FETCH_TIMEOUT_MS = 5_000;
const MACHINE_RPC_DIRECT_GRANT_MAX_CALLS = 2;
const MACHINE_RPC_DIRECT_GRANT_MAX_IDLE_MS = 30_000;
const MACHINE_RPC_DIRECT_NONCE_BYTES = 16;
const MACHINE_RPC_DIRECT_CACHE_POSITIVE_TTL_MS = 30_000;
const MACHINE_RPC_DIRECT_CACHE_NEGATIVE_TTL_MS = 5_000;

const machineRpcRouteAvailabilityCache = createPeerRouteViabilityCache({
    now: Date.now,
    positiveTtlMs: MACHINE_RPC_DIRECT_CACHE_POSITIVE_TTL_MS,
    negativeTtlMs: MACHINE_RPC_DIRECT_CACHE_NEGATIVE_TTL_MS,
});

type TargetServer = Readonly<{
    serverId: string;
    serverUrl: string;
}>;

type OperationResult<T> =
    | Readonly<{ ok: true; value: T }>
    | Readonly<{ ok: false; reasonCode: string }>;

export { resolvePeerRouteSigningReadiness } from '../identity/signingReadiness';
export type { PeerRouteSigningReadiness } from '../identity/signingReadiness';

function normalizeId(raw: unknown): string {
    return String(raw ?? '').trim();
}

function fallback(
    reasonCode: string,
    details?: Readonly<{ requiredCapability: string }>,
): Extract<MachineRpcDirectRouteResolution, { kind: 'fallback' }> {
    return {
        kind: 'fallback',
        receipt: PEER_MEDIATION_RECEIPTS.routeFallback,
        reasonCode,
        ...details,
    };
}

function normalizeBaseUrl(serverUrl: string): string {
    return String(serverUrl ?? '').trim().replace(/\/+$/, '');
}

function joinBaseAndPath(serverUrl: string, path: string): string {
    return `${normalizeBaseUrl(serverUrl)}${path.startsWith('/') ? path : `/${path}`}`;
}

function resolveTargetServer(serverId: string | null | undefined): TargetServer | null {
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

function readEndpointFromMachineState(input: Readonly<{
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
    signal?: AbortSignal;
}>): Promise<Readonly<{ ok: boolean; status: number; body: unknown }>> {
    const timeoutMs = typeof params.timeoutMs === 'number' && params.timeoutMs > 0
        ? params.timeoutMs
        : MACHINE_RPC_DIRECT_FETCH_TIMEOUT_MS;
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timeoutId = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    const externalSignal = params.signal;
    const forwardExternalAbort = controller && externalSignal ? () => controller.abort() : null;
    if (controller && externalSignal && forwardExternalAbort) {
        if (externalSignal.aborted) {
            controller.abort();
        } else {
            externalSignal.addEventListener('abort', forwardExternalAbort, { once: true });
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
        if (externalSignal && forwardExternalAbort) {
            externalSignal.removeEventListener('abort', forwardExternalAbort);
        }
    }
}

async function requestMachineRpcRouteGrant(input: Readonly<{
    server: TargetServer;
    credentials: AuthCredentials;
    machineId: string;
    method: string;
    flowKind: PeerFlowKindV1;
    routeKind: DirectPeerRouteKindV1;
    endpointFingerprint: string;
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
                    machineId: input.machineId,
                    flowKind: input.flowKind,
                    routeKind: input.routeKind,
                    endpointFingerprint: input.endpointFingerprint,
                    ttlMs: DIRECT_ROUTE_GRANT_TTL_MS.loopbackMachineRpcDefault,
                    scope: {
                        kind: 'machine_rpc',
                        rpcScopeId: `${input.machineId}:${input.method}`,
                        allowedMethods: [input.method],
                        maxCalls: MACHINE_RPC_DIRECT_GRANT_MAX_CALLS,
                        maxIdleMs: MACHINE_RPC_DIRECT_GRANT_MAX_IDLE_MS,
                    },
                }),
            },
        });
        if (!response.ok) {
            return { ok: false, reasonCode: 'grant_missing' };
        }
        const body = response.body as { ok?: unknown; reasonCode?: unknown; grant?: unknown } | null;
        if (body?.ok !== true) {
            return {
                ok: false,
                reasonCode: typeof body?.reasonCode === 'string' ? body.reasonCode : 'grant_missing',
            };
        }
        const parsed = SignedDirectRouteGrantV1Schema.safeParse(body.grant);
        return parsed.success
            ? { ok: true, value: parsed.data }
            : { ok: false, reasonCode: 'grant_invalid' };
    } catch {
        return { ok: false, reasonCode: 'grant_missing' };
    }
}

async function requestMachineRpcRouteGrantV2(input: Readonly<{
    server: TargetServer;
    credentials: AuthCredentials;
    machineId: string;
    method: string;
    endpointFingerprint: string;
    ephemeralPublicKeyBase64Url: string;
    timeoutMs?: number;
}>): Promise<OperationResult<SignedDirectRouteGrantV2>> {
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
                    v: 2,
                    kind: 'ephemeral_ed25519',
                    ephemeralPublicKeyBase64Url: input.ephemeralPublicKeyBase64Url,
                    machineId: input.machineId,
                    flowKind: 'machine_rpc',
                    routeKind: 'loopback_direct',
                    endpointFingerprint: input.endpointFingerprint,
                    ttlMs: DIRECT_ROUTE_GRANT_TTL_MS.loopbackMachineRpcDefault,
                    scope: {
                        kind: 'machine_rpc',
                        rpcScopeId: `${input.machineId}:${input.method}`,
                        allowedMethods: [input.method],
                        maxCalls: 1,
                        maxIdleMs: MACHINE_RPC_DIRECT_GRANT_MAX_IDLE_MS,
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
        const parsed = SignedDirectRouteGrantV2Schema.safeParse(body.grant);
        return parsed.success
            ? { ok: true, value: parsed.data }
            : { ok: false, reasonCode: 'grant_invalid' };
    } catch {
        return { ok: false, reasonCode: 'grant_missing' };
    }
}

function createNonceProof(input: Readonly<{
    credentials: AuthCredentials;
    grant: SignedDirectRouteGrantV1;
    routeKind: DirectPeerRouteKindV1;
    flowKind: PeerFlowKindV1;
    endpointFingerprint: string;
}>): OperationResult<PeerRouteNonceProofV1> {
    if (!isLegacyAuthCredentials(input.credentials)) {
        return { ok: false, reasonCode: 'nonce_invalid' };
    }
    try {
        const seed = decodeBase64(input.credentials.secret);
        const keyPair = sodium.crypto_sign_seed_keypair(seed);
        const nonceBase64Url = encodeBase64(getRandomBytes(MACHINE_RPC_DIRECT_NONCE_BYTES), 'base64url');
        const signingInput = createPeerRouteNonceSigningInputV1({
            grantId: input.grant.payload.grantId,
            routeKind: input.routeKind,
            flowKind: input.flowKind,
            endpointFingerprint: input.endpointFingerprint,
            nonceBase64Url,
        });
        const signature = sodium.crypto_sign_detached(new TextEncoder().encode(signingInput), keyPair.privateKey);
        return {
            ok: true,
            value: {
                v: 1,
                grantId: input.grant.payload.grantId,
                routeKind: input.routeKind,
                flowKind: input.flowKind,
                endpointFingerprint: input.endpointFingerprint,
                nonceBase64Url,
                signatureBase64Url: encodeBase64(signature, 'base64url'),
            },
        };
    } catch {
        return { ok: false, reasonCode: 'nonce_invalid' };
    }
}

async function postLoopbackProbe(input: Readonly<{
    url: string;
    request: PeerLoopbackProbeRequestV1;
    timeoutMs?: number;
}>): Promise<PeerLoopbackProbeResponseV1> {
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
    if (!parsed.success) {
        return {
            v: 1,
            ok: false,
            receipt: PEER_MEDIATION_RECEIPTS.routeFallback,
            reasonCode: 'grant_invalid',
        };
    }
    return parsed.data;
}

function fallbackDirectResponse(
    request: PeerMachineRpcDirectRequestV1 | PeerMachineRpcDirectRequestV2,
    reasonCode: PeerMachineRpcDirectFallbackReasonCodeV1,
): PeerMachineRpcDirectResponseV1 | PeerMachineRpcDirectResponseV2 {
    return {
        v: request.v,
        ok: false,
        receipt: PEER_MEDIATION_RECEIPTS.rpcFellBackToServer,
        requestId: request.requestId,
        method: request.method,
        reasonCode,
    };
}

export async function resolveProductionMachineRpcDirectRoute(input: Readonly<{
    serverId?: string | null;
    machineId: string;
    method: string;
    timeoutMs?: number;
}>): Promise<MachineRpcDirectRouteResolution> {
    const server = resolveTargetServer(input.serverId);
    if (!server) return fallback('topology_unavailable');

    const serverFeatures = await getReadyServerFeatures({
        serverId: server.serverId,
        timeoutMs: input.timeoutMs ?? MACHINE_RPC_DIRECT_FETCH_TIMEOUT_MS,
    }).catch(() => null);
    const policyPreflight = resolveMachineRpcDirectRoutePreflight({
        method: input.method,
        serverFeatures,
    });
    if (policyPreflight.kind === 'fallback') return policyPreflight;
    if (policyPreflight.kind !== 'credentials_required') return fallback('grant_invalid');
    const credentials = await TokenStorage.getCredentialsForServerUrl(server.serverUrl, {
        serverId: server.serverId,
    });
    if (!credentials) return fallback('grant_missing');
    const identityPreflight = resolveMachineRpcDirectRoutePreflight({
        method: input.method,
        serverFeatures,
        credentials,
    });
    if (identityPreflight.kind === 'fallback') return identityPreflight;
    if (identityPreflight.kind !== 'endpoint_required') return fallback('grant_invalid');
    const routePreflight = resolveMachineRpcDirectRoutePreflight({
        method: input.method,
        serverFeatures,
        credentials,
        endpoint: readEndpointFromMachineState({
            serverId: server.serverId,
            machineId: input.machineId,
        }),
    });
    if (routePreflight.kind !== 'direct_eligible') {
        return routePreflight.kind === 'fallback'
            ? routePreflight
            : fallback('topology_unavailable');
    }
    const endpoint = routePreflight.endpoint;

    if (routePreflight.proofKind === 'ephemeral_v2') {
        const proofHandle = createEphemeralPeerRouteProofHandleV2({ randomBytes: getRandomBytes });
        try {
            const grant = await requestMachineRpcRouteGrantV2({
                server,
                credentials,
                machineId: input.machineId,
                method: input.method,
                endpointFingerprint: endpoint.endpointFingerprint,
                ephemeralPublicKeyBase64Url: proofHandle.publicKeyBase64Url,
                timeoutMs: input.timeoutMs,
            });
            if (!grant.ok) return fallback(grant.reasonCode);
            const proof = proofHandle.sign(grant.value);
            return {
                kind: 'selected',
                receipt: PEER_MEDIATION_RECEIPTS.routeSelected,
                endpoint: {
                    url: endpoint.url,
                    endpointFingerprint: endpoint.endpointFingerprint,
                },
                grant: grant.value,
                proof,
            };
        } catch {
            return fallback('grant_invalid');
        } finally {
            proofHandle.dispose();
        }
    }

    const requestGrant = async () => await requestMachineRpcRouteGrant({
        server,
        credentials,
        machineId: input.machineId,
        method: input.method,
        flowKind: 'machine_rpc',
        routeKind: 'loopback_direct',
        endpointFingerprint: endpoint.endpointFingerprint,
        timeoutMs: input.timeoutMs,
    });
    const createProof = (grant: SignedDirectRouteGrantV1) => createNonceProof({
        credentials,
        grant,
        routeKind: 'loopback_direct',
        flowKind: 'machine_rpc',
        endpointFingerprint: endpoint.endpointFingerprint,
    });

    const availability = await resolvePeerLoopbackRouteAvailability({
        serverId: server.serverId,
        targetMachineId: input.machineId,
        flowKind: 'machine_rpc',
        routeKind: 'loopback_direct',
        endpoint,
        cache: machineRpcRouteAvailabilityCache,
        requestGrant: async () => {
            const grant = await requestGrant();
            return grant.ok ? { ok: true, grant: grant.value } : grant;
        },
        createNonceProof: async ({ grant }) => {
            const nonceProof = createProof(grant);
            return nonceProof.ok ? { ok: true, nonceProof: nonceProof.value } : nonceProof;
        },
        postProbe: async ({ url, request }) => await postLoopbackProbe({
            url,
            request,
            timeoutMs: input.timeoutMs,
        }),
    }).catch((): PeerLoopbackRouteAvailabilityResult => ({
        kind: 'fallback',
        receipt: PEER_MEDIATION_RECEIPTS.routeFallback,
        reasonCode: 'topology_unavailable',
    }));
    if (availability.kind === 'fallback') {
        return availability;
    }

    const grant = availability.grant
        ? { ok: true as const, value: availability.grant }
        : await requestGrant();
    if (!grant.ok) return fallback(grant.reasonCode);
    const nonceProof = availability.nonceProof
        ? { ok: true as const, value: availability.nonceProof }
        : createProof(grant.value);
    if (!nonceProof.ok) return fallback(nonceProof.reasonCode);

    return {
        kind: 'selected',
        receipt: availability.receipt,
        endpoint: {
            url: endpoint.url,
            endpointFingerprint: endpoint.endpointFingerprint,
        },
        grant: grant.value,
        nonceProof: nonceProof.value,
    };
}

export async function postProductionMachineRpcDirect(input: Readonly<{
    url: string;
    request: PeerMachineRpcDirectRequestV1 | PeerMachineRpcDirectRequestV2;
    timeoutMs?: number;
    signal?: AbortSignal;
}>): Promise<PeerMachineRpcDirectResponseV1 | PeerMachineRpcDirectResponseV2> {
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
            return fallbackDirectResponse(input.request, 'topology_unavailable');
        }
        const parsed = input.request.v === 2
            ? PeerMachineRpcDirectResponseV2Schema.safeParse(response.body)
            : PeerMachineRpcDirectResponseV1Schema.safeParse(response.body);
        return parsed.success ? parsed.data : fallbackDirectResponse(input.request, 'invalid_request');
    } catch {
        return fallbackDirectResponse(input.request, 'topology_unavailable');
    }
}
