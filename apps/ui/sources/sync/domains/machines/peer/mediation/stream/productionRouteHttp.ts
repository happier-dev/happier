import { DIRECT_ROUTE_GRANT_TTL_MS } from '@happier-dev/protocol/machines/peer/mediation/directRouteGrantCachePolicyV1';
import { MachineLiveStreamRelayAuthorizationV1Schema, type MachineLiveStreamRelayAuthorizationV1 } from '@happier-dev/protocol/machines/peer/mediation/stream/v1';
import { PeerLoopbackEndpointCandidateV1Schema, type PeerLoopbackEndpointCandidateV1 } from '@happier-dev/protocol/machines/peer/mediation/loopbackEndpointV1';
import { SignedDirectRouteGrantV2Schema, DirectRouteGrantRequestV2Schema, type SignedDirectRouteGrantV2 } from '@happier-dev/protocol/machines/peer/mediation/directRouteGrantV2';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import {
    areServerProfileIdentifiersEquivalent,
    getServerProfileById,
    resolveServerProfileScopeId,
} from '@/sync/domains/server/serverProfiles';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { storage } from '@/sync/domains/state/storage';
import type { ServerAccountRequestAuthority } from '@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope';
import {
    requestPeerMediationServerJson,
    requestPeerMediationServerJsonForCredential,
} from '../peerMediationServerRequest';
import { readPeerEndpointForServerScope } from '../readPeerEndpointForServerScope';
import type { MachineLiveStreamUnsignedStartRequest } from './startRequest';
export { createBaseStartRequest, createLiveStreamStartRequest, type MachineLiveStreamUnsignedStartRequest } from './startRequest';

export type TargetServer = Readonly<{
    serverId: string;
    serverUrl: string;
}>;

export type OperationResult<T> =
    | Readonly<{ ok: true; value: T }>
    | Readonly<{ ok: false; reasonCode: string }>;

/** Canonical authenticated UI HTTP seam for a V2 peer-route grant. */
export async function requestPeerRouteGrantV2(input: Readonly<{
    authority: Pick<ServerAccountRequestAuthority, 'request'>;
    request: ReturnType<typeof DirectRouteGrantRequestV2Schema.parse>;
    timeoutMs?: number;
}>): Promise<OperationResult<SignedDirectRouteGrantV2>> {
    try {
        const response = await requestPeerMediationServerJson({
            authorityRequest: input.authority.request,
            path: '/v1/machines/peer/mediation/route-grants',
            timeoutMs: input.timeoutMs,
            init: {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(input.request),
            },
        });
        if (!response.ok) return { ok: false, reasonCode: 'grant_missing' };
        const body = response.body as { ok?: unknown; reasonCode?: unknown; grant?: unknown } | null;
        if (body?.ok !== true) return { ok: false, reasonCode: typeof body?.reasonCode === 'string' ? body.reasonCode : 'grant_missing' };
        const parsed = SignedDirectRouteGrantV2Schema.safeParse(body.grant);
        return parsed.success ? { ok: true, value: parsed.data } : { ok: false, reasonCode: 'grant_invalid' };
    } catch {
        return { ok: false, reasonCode: 'grant_missing' };
    }
}

function normalizeId(raw: unknown): string {
    return String(raw ?? '').trim();
}

function normalizeBaseUrl(serverUrl: string): string {
    return String(serverUrl ?? '').trim().replace(/\/+$/, '');
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
    const endpoint = readPeerEndpointForServerScope({
        state,
        serverId: input.serverId,
        machineId: input.machineId,
        select: (machine) => machine.daemonState?.peerMediation?.loopback?.endpoint,
    });
    const parsed = PeerLoopbackEndpointCandidateV1Schema.safeParse(endpoint);
    return parsed.success ? parsed.data : null;
}

export async function requestLiveStreamRelayAuthorization(input: Readonly<{
    server: TargetServer;
    credentials: AuthCredentials;
    startRequest: MachineLiveStreamUnsignedStartRequest;
    timeoutMs?: number;
}>): Promise<OperationResult<MachineLiveStreamRelayAuthorizationV1>> {
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
                    machineId: input.startRequest.sourceMachineId,
                    targetMachineId: input.startRequest.targetMachineId,
                    flowKind: 'live_stream',
                    routeKind: 'server_relay',
                    ttlMs: DIRECT_ROUTE_GRANT_TTL_MS.serverRelayedLiveStream,
                    // Per-tab viewer target (W1-C-2): the server mint binds this socket id into the
                    // signed grant payload so frames are delivered to the exact tab. Omitted on the
                    // legacy machine→machine path (no viewer socket).
                    ...(input.startRequest.viewerSocketId
                        ? { viewerSocketId: input.startRequest.viewerSocketId }
                        : {}),
                    maxFramesPerSecond: input.startRequest.maxFramesPerSecond,
                    maxFrameBytes: input.startRequest.maxFrameBytes,
                    codecId: input.startRequest.codecId,
                    viewerCodecs: input.startRequest.viewerCodecs,
                    scope: {
                        kind: 'live_stream',
                        streamId: input.startRequest.streamId,
                        streamFamily: input.startRequest.streamFamily,
                        ...(input.startRequest.sourceId ? { sourceId: input.startRequest.sourceId } : {}),
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
