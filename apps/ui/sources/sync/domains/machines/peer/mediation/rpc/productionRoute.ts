import { DIRECT_ROUTE_GRANT_TTL_MS } from '@happier-dev/protocol/machines/peer/mediation/directRouteGrantCachePolicyV1';
import { PEER_MEDIATION_RECEIPTS } from '@happier-dev/protocol/machines/peer/mediation/receipts';
import { PeerLoopbackEndpointCandidateV1Schema, type PeerLoopbackEndpointCandidateV1 } from '@happier-dev/protocol/machines/peer/mediation/loopbackEndpointV1';
import { PeerMachineRpcDirectResponseV2Schema, type PeerMachineRpcDirectRequestV2, type PeerMachineRpcDirectResponseV2 } from '@happier-dev/protocol/machines/peer/mediation/rpc/directV2';
import { SignedDirectRouteGrantV2Schema, type SignedDirectRouteGrantV2 } from '@happier-dev/protocol/machines/peer/mediation/directRouteGrantV2';
import { createEphemeralPeerRouteProofHandleV2 } from '@happier-dev/protocol/machines/peer/mediation/ephemeralPeerRouteProofV2';
import type { PeerMachineRpcDirectFallbackReasonCodeV1 } from '@happier-dev/protocol/machines/peer/mediation/rpc/directV1';

import { TokenStorage, type AuthCredentials } from '@/auth/storage/tokenStorage';
import { getRandomBytes } from '@/platform/cryptoRandom';
import { getReadyServerFeatures } from '@/sync/api/capabilities/getReadyServerFeatures';
import {
    areServerProfileIdentifiersEquivalent,
    getServerProfileById,
    resolveServerProfileScopeId,
} from '@/sync/domains/server/serverProfiles';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { storage } from '@/sync/domains/state/storage';
import { parseToken } from '@/utils/auth/parseToken';
import { resolvePeerMediationDirectPreferencesForScope } from '@/sync/domains/settings/peerMediationPreferences';

import { requestPeerMediationServerJsonForCredential } from '../peerMediationServerRequest';
import { readPeerEndpointForServerScope } from '../readPeerEndpointForServerScope';
import type { MachineRpcDirectRouteResolution } from './client';
import { resolveMachineRpcDirectRoutePreflight } from './directRoutePreflight';

const MACHINE_RPC_DIRECT_FETCH_TIMEOUT_MS = 5_000;
const MACHINE_RPC_DIRECT_GRANT_MAX_IDLE_MS = 30_000;

type TargetServer = Readonly<{
    serverId: string;
    serverUrl: string;
}>;

type OperationResult<T> =
    | Readonly<{ ok: true; value: T }>
    | Readonly<{ ok: false; reasonCode: string }>;

function normalizeId(raw: unknown): string {
    return String(raw ?? '').trim();
}

function fallback(reasonCode: string): Extract<MachineRpcDirectRouteResolution, { kind: 'fallback' }> {
    return {
        kind: 'fallback',
        receipt: PEER_MEDIATION_RECEIPTS.routeFallback,
        reasonCode,
    };
}

function normalizeBaseUrl(serverUrl: string): string {
    return String(serverUrl ?? '').trim().replace(/\/+$/, '');
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
    const endpoint = readPeerEndpointForServerScope({
        state,
        serverId: input.serverId,
        machineId: input.machineId,
        select: (machine) => machine.daemonState?.peerMediation?.loopback?.endpoint,
    });
    const parsed = PeerLoopbackEndpointCandidateV1Schema.safeParse(endpoint);
    return parsed.success ? parsed.data : null;
}

async function fetchJson(params: Readonly<{
    url: string;
    init: RequestInit;
    timeoutMs?: number;
    signal?: AbortSignal;
    onDispatched?: () => void;
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
        const pending = fetch(params.url, {
            ...params.init,
            ...(controller ? { signal: controller.signal } : {}),
        });
        params.onDispatched?.();
        const response = await pending;
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
        const response = await requestPeerMediationServerJsonForCredential({
            serverId: input.server.serverId,
            token: input.credentials.token,
            path: '/v1/machines/peer/mediation/route-grants',
            timeoutMs: input.timeoutMs,
            init: {
                method: 'POST',
                headers: {
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

function fallbackDirectResponse(
    request: PeerMachineRpcDirectRequestV2,
    reasonCode: PeerMachineRpcDirectFallbackReasonCodeV1,
): PeerMachineRpcDirectResponseV2 {
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
    accountId?: string | null;
    machineId: string;
    method: string;
    timeoutMs?: number;
}>): Promise<MachineRpcDirectRouteResolution> {
    const server = resolveTargetServer(input.serverId);
    if (!server) return fallback('topology_unavailable');

    const expectedAccountId = normalizeId(input.accountId);
    let credentials: AuthCredentials | null = null;
    if (expectedAccountId) {
        credentials = await TokenStorage.getCredentialsForServerUrl(server.serverUrl, {
            serverId: server.serverId,
        });
        if (!credentials) return fallback('grant_missing');
        let credentialAccountId = '';
        try {
            credentialAccountId = parseToken(credentials.token);
        } catch {
            return fallback('grant_missing');
        }
        if (credentialAccountId !== expectedAccountId) return fallback('grant_missing');
    }

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
    credentials ??= await TokenStorage.getCredentialsForServerUrl(server.serverUrl, {
        serverId: server.serverId,
    });
    if (!credentials) return fallback('grant_missing');
    let accountId: string;
    try { accountId = parseToken(credentials.token); } catch { return fallback('grant_missing'); }
    const directPreferences = resolvePeerMediationDirectPreferencesForScope({
        scope: { serverId: server.serverId, accountId },
        machineId: input.machineId,
        flowKind: 'machine_rpc',
    });
    const identityPreflight = resolveMachineRpcDirectRoutePreflight({
        method: input.method,
        serverFeatures,
        credentials,
        ...directPreferences,
    });
    if (identityPreflight.kind === 'fallback') return identityPreflight;
    if (identityPreflight.kind !== 'endpoint_required') return fallback('grant_invalid');
    const routePreflight = resolveMachineRpcDirectRoutePreflight({
        method: input.method,
        serverFeatures,
        credentials,
        ...directPreferences,
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

    {
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

}

export async function postProductionMachineRpcDirect(input: Readonly<{
    url: string;
    request: PeerMachineRpcDirectRequestV2;
    timeoutMs?: number;
    signal?: AbortSignal;
    onDispatched?: () => void;
}>): Promise<PeerMachineRpcDirectResponseV2> {
    try {
        const response = await fetchJson({
            url: input.url,
            timeoutMs: input.timeoutMs,
            signal: input.signal,
            onDispatched: input.onDispatched,
            init: {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(input.request),
            },
        });
        if (!response.ok) {
            return fallbackDirectResponse(input.request, 'topology_unavailable');
        }
        const parsed = PeerMachineRpcDirectResponseV2Schema.safeParse(response.body);
        return parsed.success ? parsed.data : fallbackDirectResponse(input.request, 'invalid_request');
    } catch {
        return fallbackDirectResponse(input.request, 'topology_unavailable');
    }
}
