import { DIRECT_ROUTE_GRANT_TTL_MS } from '@happier-dev/protocol/machines/peer/mediation/directRouteGrantCachePolicyV1';
import { SignedDirectRouteGrantV2Schema, type SignedDirectRouteGrantV2 } from '@happier-dev/protocol/machines/peer/mediation/directRouteGrantV2';
import { createEphemeralPeerRouteProofHandleV2, type PeerRouteEphemeralProofV2 } from '@happier-dev/protocol/machines/peer/mediation/ephemeralPeerRouteProofV2';
import { getRandomBytes } from '@/platform/cryptoRandom';
import { requestPeerMediationServerJsonForCredential } from '../peerMediationServerRequest';
import { CredentialRequestRedirectError, fetchWithCredentialRedirectRefusal } from '@happier-dev/cli-common/homeTarget';
import { runtimeFetchManualResponse } from '@/utils/system/runtimeFetch';
import { PEER_MEDIATION_RECEIPTS } from '@happier-dev/protocol/machines/peer/mediation/receipts';
import { PeerLoopbackEndpointCandidateV1Schema, type PeerLoopbackEndpointCandidateV1 } from '@happier-dev/protocol/machines/peer/mediation/loopbackEndpointV1';
import { PeerMachineRpcDirectResponseV2Schema, type PeerMachineRpcDirectRequestV2, type PeerMachineRpcDirectResponseV2 } from '@happier-dev/protocol/machines/peer/mediation/rpc/directV2';
import type { PeerMachineRpcDirectFallbackReasonCodeV1 } from '@happier-dev/protocol/machines/peer/mediation/rpc/directV1';
import { markRpcRequestDisposition } from '@happier-dev/sync-client';
import { RPC_ERROR_CODES, RpcError } from '@happier-dev/protocol/rpcErrors';

import { TokenStorage, type AuthCredentials } from '@/auth/storage/tokenStorage';
import { resolveAuthCredentialsScopeKey } from '@/auth/storage/resolveAuthCredentialsScopeKey';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
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
import { readMachineRequestReachabilityObservation, recordMachineRequestFailed, recordMachineRequestSucceeded } from '@/sync/domains/machines/reachability/machineReachability';
import { getSystemTasksRunner } from '@/components/systemTasks/systemTasksRuntime';
import { readLocalDaemonSharedState } from '@/components/settings/machines/localControl/localDaemonSharedState';
import type { LocalDaemonStatusData } from '@/components/settings/machines/localControl/useLocalDaemonControl';
import { isDaemonOnActiveRelay } from '@/sync/domains/server/relayDrift/relayDriftModel';

import { readPeerEndpointForServerScope } from '../readPeerEndpointForServerScope';
import { MachineRpcDirectIdentityError, resolveDirectRpcUrl, type MachineRpcDirectRouteResolution } from './client';
import { resolveMachineRpcDirectRoutePreflight } from './directRoutePreflight';
import { resolveMachineRpcDirectRouteGrant } from './routeGrant';

const MACHINE_RPC_DIRECT_FETCH_TIMEOUT_MS = 5_000;

type TargetServer = Readonly<{
    serverId: string;
    serverUrl: string;
}>;

type DirectJsonResponse = Readonly<{
    ok: boolean;
    status: number;
    contentType: string | null;
    bodyWasJson: boolean;
    body: unknown;
}>;

type OperationResult<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; reasonCode: string }>;
type Admission = Readonly<{ grant: SignedDirectRouteGrantV2; proof: PeerRouteEphemeralProofV2 }>;
const MACHINE_RPC_DIRECT_GRANT_MAX_IDLE_MS = 30_000;

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
    } catch (error) {
        if (error instanceof CredentialRequestRedirectError) throw error;
        return { ok: false, reasonCode: 'grant_missing' };
    }
}


function resolveMachineRpcRouteAdmission(input: Readonly<{
    server: TargetServer;
    credentials: AuthCredentials;
    accountId: string;
    machineId: string;
    method: string;
    endpointUrl: string;
    endpointFingerprint: string;
    timeoutMs?: number;
}>): Promise<OperationResult<Admission>> {
    // The immutable credential fingerprint separates present-user and automation
    // bearer authority. The issuer signs that authority into each admission.
    const key = JSON.stringify([input.server.serverId, input.server.serverUrl, input.accountId,
        resolveAuthCredentialsScopeKey(input.credentials), input.machineId, input.method,
        input.endpointUrl, input.endpointFingerprint]);
    return resolveMachineRpcDirectRouteGrant({ key, admit: async () => {
        const proofHandle = createEphemeralPeerRouteProofHandleV2({ randomBytes: getRandomBytes });
        try {
            const result = await requestMachineRpcRouteGrantV2({ ...input, ephemeralPublicKeyBase64Url: proofHandle.publicKeyBase64Url });
            if (!result.ok) return result;
            return { ok: true, value: { grant: result.value, proof: proofHandle.sign(result.value) } };
        } catch (error) {
            if (error instanceof CredentialRequestRedirectError) throw error;
            return { ok: false, reasonCode: 'grant_invalid' };
        } finally {
            proofHandle.dispose();
        }
    } });
}

function createDirectResponseError(
    response: DirectJsonResponse,
    schemaIssues: ReadonlyArray<Readonly<{ code: string; path: readonly PropertyKey[] }>> = [],
) {
    // Keep only structural diagnostics: schema messages and response data can
    // contain private method results, credentials or gateway body excerpts.
    const diagnostics = {
        httpStatus: response.status,
        contentType: response.contentType,
        bodyWasJson: response.bodyWasJson,
        schemaIssues: schemaIssues.map(issue => ({ code: issue.code, path: issue.path })),
    };
    const reason = !response.ok ? 'Machine RPC direct HTTP response failed'
        : !response.bodyWasJson ? 'Machine RPC direct response is not JSON'
            : 'Machine RPC direct response is invalid';
    const message = `${reason}: ${JSON.stringify(diagnostics)}`;
    return Object.assign(new MachineRpcDirectIdentityError(response.contentType?.split(';')[0]?.trim().toLowerCase() !== 'application/json'
        ? 'direct_response_content_type' : 'direct_response_invalid', message,
        response.ok ? 'MACHINE_RPC_INVALID_RESPONSE' : RPC_ERROR_CODES.OUTCOME_UNKNOWN), diagnostics);
}

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
    operationTimeoutMs?: null;
    signal?: AbortSignal;
    onDispatched?: () => void;
    onResponse?: () => void;
}>): Promise<DirectJsonResponse> {
    const timeoutMs = typeof params.timeoutMs === 'number' && params.timeoutMs > 0
        ? params.timeoutMs
        : MACHINE_RPC_DIRECT_FETCH_TIMEOUT_MS;
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timeoutId = controller && params.operationTimeoutMs !== null ? setTimeout(() => controller.abort(), timeoutMs) : null;
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
        const pending = fetchWithCredentialRedirectRefusal(params.url, {
            ...params.init,
            ...(controller ? { signal: controller.signal } : {}),
        }, runtimeFetchManualResponse);
        params.onDispatched?.();
        const response = await pending;
        params.onResponse?.();
        const contentType = response.headers.get('content-type');
        let body: unknown = null;
        let bodyWasJson = false;
        try {
            body = await response.json();
            bodyWasJson = true;
        } catch (error) {
            // SyntaxError means JSON decoding failed. A lost/aborted body stream
            // is still a transport failure; preserve its original type and code.
            if (!(error instanceof SyntaxError)) {
                throw error instanceof Error ? Object.assign(error, {
                    httpStatus: response.status, contentType, bodyWasJson: false,
                }) : error;
            }
        }
        return {
            ok: response.ok,
            status: response.status,
            contentType,
            bodyWasJson,
            body,
        };
    } finally {
        if (timeoutId) clearTimeout(timeoutId);
        if (externalSignal && forwardExternalAbort) {
            externalSignal.removeEventListener('abort', forwardExternalAbort);
        }
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
    /** Remaining setup budget from the machine RPC caller's deadline owner. */
    resolveRemainingTimeoutMs?: () => number;
    signal?: AbortSignal;
}>): Promise<MachineRpcDirectRouteResolution> {
    const readLifetime = captureActiveServerAccountScopeLifetime();
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

    const featuresTimeoutMs = input.resolveRemainingTimeoutMs?.() ?? input.timeoutMs ?? MACHINE_RPC_DIRECT_FETCH_TIMEOUT_MS;
    if (featuresTimeoutMs <= 0) return fallback('topology_unavailable');
    const serverFeatures = await getReadyServerFeatures({
        serverId: server.serverId,
        timeoutMs: featuresTimeoutMs,
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
    // A daemon advert describes its host's loopback, never the browser's.
    // Reuse an already observed desktop status; no probe can establish locality.
    const localRunner = getSystemTasksRunner();
    const local = localRunner.mode === 'tauri'
        ? readLocalDaemonSharedState<LocalDaemonStatusData>(localRunner).status : null;
    if (local?.machineId !== input.machineId || local.daemonAccountId !== accountId
        || isDaemonOnActiveRelay({ activeRelayUrl: server.serverUrl, daemonRelayUrl: local.daemonServerUrl }) !== true) {
        return fallback('loopback_locality_unproven');
    }
    const routeServerProfile = getServerProfileById(server.serverId);
    const routeScope = { serverId: routeServerProfile ? resolveServerProfileScopeId(routeServerProfile) : server.serverId,
        accountId, machineId: input.machineId, route: 'loopback_direct' as const };
    if (readMachineRequestReachabilityObservation(routeScope, input.machineId, routeScope.route)?.outcome === 'failed') {
        return fallback('topology_unavailable');
    }

    // Check the eligible same-host endpoint before asking Home for a grant;
    // a stopped listener must not consume the relay's entire setup budget.
    // This existing harmless probe also distinguishes an unsent request from
    // a lost POST reply, which browsers expose as the same network TypeError.
    const readinessTimeoutMs = input.resolveRemainingTimeoutMs?.() ?? input.timeoutMs;
    if (readinessTimeoutMs !== undefined && readinessTimeoutMs <= 0) return fallback('topology_unavailable');
    try {
        await fetchJson({ url: resolveDirectRpcUrl(endpoint.url), init: { method: 'OPTIONS' },
            timeoutMs: readinessTimeoutMs, signal: input.signal });
    } catch (error) {
        if (error instanceof CredentialRequestRedirectError) throw error;
        if (input.signal?.aborted) throw error;
        recordMachineRequestFailed(routeScope);
        return fallback('topology_unavailable');
    }
    recordMachineRequestSucceeded(routeScope);

    {
        try {
            const grantTimeoutMs = input.resolveRemainingTimeoutMs?.() ?? input.timeoutMs;
            if (grantTimeoutMs !== undefined && grantTimeoutMs <= 0) return fallback('topology_unavailable');
            const admission = await resolveMachineRpcRouteAdmission({
                server,
                credentials,
                accountId,
                machineId: input.machineId,
                method: input.method,
                endpointUrl: endpoint.url,
                endpointFingerprint: endpoint.endpointFingerprint,
                timeoutMs: grantTimeoutMs,
            });
            if (!admission.ok) return fallback(admission.reasonCode);
            const { grant, proof } = admission.value;
            return {
                kind: 'selected',
                receipt: PEER_MEDIATION_RECEIPTS.routeSelected,
                endpoint: {
                    url: endpoint.url,
                    endpointFingerprint: endpoint.endpointFingerprint,
                },
                grant,
                proof,
                ...(readLifetime?.isCurrent() && readLifetime.scope.accountId === accountId
                    && areServerProfileIdentifiersEquivalent(readLifetime.scope.serverId, server.serverId)
                    ? { readBinding: {
                        key: JSON.stringify(['direct', server.serverId, server.serverUrl,
                            resolveAuthCredentialsScopeKey(credentials), input.machineId, input.method,
                            endpoint.url, endpoint.endpointFingerprint, grant.signature.keyId,
                            grant.payload.scope, grant.payload.callerAuthority ?? null]),
                        scope: [readLifetime],
                        assertCurrent: () => {
                            const currentServer = resolveTargetServer(input.serverId);
                            const currentEndpoint = readEndpointFromMachineState({ serverId: server.serverId, machineId: input.machineId });
                            if (!readLifetime.isCurrent() || currentServer?.serverUrl !== server.serverUrl
                                || currentEndpoint?.url !== endpoint.url || currentEndpoint.endpointFingerprint !== endpoint.endpointFingerprint) {
                                throw new RpcError('Direct Machine read authority retired', 'MACHINE_ENCRYPTION_UNAVAILABLE');
                            }
                        },
                    } } : {}),
            };
        } catch (error) {
            if (error instanceof CredentialRequestRedirectError) throw error;
            return fallback('grant_invalid');
        }
    }

}

export async function postProductionMachineRpcDirect(input: Readonly<{
    url: string;
    request: PeerMachineRpcDirectRequestV2;
    timeoutMs?: number;
    operationTimeoutMs?: null;
    signal?: AbortSignal;
    onDispatched?: () => void;
    /** Witnesses HTTP arrival before asynchronous reply decoding. */
    onResponse?: () => void;
}>): Promise<PeerMachineRpcDirectResponseV2> {
    let dispatched = false;
    try {
        const response = await fetchJson({
            url: input.url,
            timeoutMs: input.timeoutMs,
            operationTimeoutMs: input.operationTimeoutMs,
            signal: input.signal,
            onResponse: input.onResponse,
            onDispatched: () => { dispatched = true; input.onDispatched?.(); },
            init: {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(input.request),
            },
        });
        if (!response.ok || !response.bodyWasJson || response.contentType?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
            throw createDirectResponseError(response);
        }
        const parsed = PeerMachineRpcDirectResponseV2Schema.safeParse(response.body);
        if (!parsed.success) throw createDirectResponseError(response, parsed.error.issues);
        return parsed.data;
    } catch (error) {
        if (error instanceof CredentialRequestRedirectError) throw error;
        // HTTP loss/status/decoding failure is not a daemon refusal. Once fetch
        // was issued, synthesizing one would authorize a second effect on relay.
        if (dispatched) throw markRpcRequestDisposition(error, 'outcomeUnknown');
        return fallbackDirectResponse(input.request, 'topology_unavailable');
    }
}
