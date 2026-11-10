import {
    type FeaturesResponse} from '@happier-dev/protocol/features/payload/featuresResponseSchema';
import {
    type MachineLiveStreamCapsV1,
    type MachineLiveStreamRelayAuthorizationV1,
    type MachineLiveStreamStartRequestV1,
    type MachineLiveStreamSourceAdmissionV1,
} from '@happier-dev/protocol/machines/peer/mediation/stream/v1';
import {
    type MachineLiveStreamCodecIdV1} from '@happier-dev/protocol/machines/peer/mediation/stream/codecsV1';

import { TokenStorage } from '@/auth/storage/tokenStorage';
import { getReadyServerFeatures } from '@/sync/api/capabilities/getReadyServerFeatures';
import { parseToken } from '@/utils/auth/parseToken';
import { resolvePeerMediationDirectPreferencesForScope } from '@/sync/domains/settings/peerMediationPreferences';

import {
    createBaseStartRequest,
    createLiveStreamStartRequest,
    requestLiveStreamRelayAuthorization,
    resolveTargetServer,
    type MachineLiveStreamUnsignedStartRequest,
} from './productionRouteHttp';
import { resolveMachineLiveStreamAvailability } from './availability';
import { requestMachineLiveStreamSourceAdmission } from './sourceAdmission';
import { readRegisteredStorageState } from '@/sync/domains/state/storageStateReaderBridge';
import { resolveServerScopedMachine } from '@/sync/domains/machines/resolveServerScopedMachine';


const SERVER_FEATURES_TIMEOUT_MS = 5_000;

export type ProductionMachineLiveStreamStartResult =
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

async function resolveServerFeatures(input: Readonly<{
    serverId: string;
    timeoutMs?: number;
    signal?: AbortSignal;
}>): Promise<FeaturesResponse | null> {
    return await getReadyServerFeatures({
        serverId: input.serverId,
        timeoutMs: input.timeoutMs ?? SERVER_FEATURES_TIMEOUT_MS,
        signal: input.signal,
    }).catch(() => null);
}

async function startServerRelayedStream(input: Readonly<{
    server: Readonly<{ serverId: string; serverUrl: string }>;
    credentials: Awaited<ReturnType<typeof TokenStorage.getCredentialsForServerUrl>>;
    startRequest: MachineLiveStreamUnsignedStartRequest;
    sourceAdmission?: MachineLiveStreamSourceAdmissionV1;
    timeoutMs?: number;
    signal?: AbortSignal;
}>): Promise<ProductionMachineLiveStreamStartResult> {
    if (!input.credentials) return { ok: false, reasonCode: 'grant_missing' };
    const relayAuthorization = await requestLiveStreamRelayAuthorization({
        server: input.server,
        credentials: input.credentials,
        startRequest: input.startRequest,
        sourceAdmission: input.sourceAdmission,
        timeoutMs: input.timeoutMs,
        signal: input.signal,
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

export async function startProductionMachineLiveStream(input: Readonly<{
    serverId?: string | null;
    sessionId?: string;
    sourceMachineId: string;
    targetMachineId: string;
    routeKind: 'loopback_direct' | 'server_relay';
    streamId: string;
    streamFamily: string;
    sourceId?: string;
    sourceAdmission?: MachineLiveStreamSourceAdmissionV1;
    // Per-tab viewer socket id (W1-C-2). Threaded into the base start request so it reaches both
    // the server mint body and the signed start request; the protocol superRefine then asserts the
    // start request and the minted grant agree on it.
    viewerSocketId?: string | null;
    caps: MachineLiveStreamCapsV1;
    codecId?: MachineLiveStreamCodecIdV1;
    viewerCodecs?: readonly MachineLiveStreamCodecIdV1[];
    timeoutMs?: number;
    signal?: AbortSignal;
}>): Promise<ProductionMachineLiveStreamStartResult> {
    const server = resolveTargetServer(input.serverId);
    if (!server) return { ok: false, reasonCode: 'topology_unavailable' };

    const serverFeatures = await resolveServerFeatures({
        serverId: server.serverId,
        timeoutMs: input.timeoutMs,
        signal: input.signal,
    });
    if (!serverFeatures) return { ok: false, reasonCode: 'server_features_unavailable' };

    const credentials = await TokenStorage.getCredentialsForServerUrl(server.serverUrl, {
        serverId: server.serverId,
    });
    if (!credentials) return { ok: false, reasonCode: 'grant_missing' };

    let accountId: string;
    try { accountId = parseToken(credentials.token); } catch { return { ok: false, reasonCode: 'grant_missing' }; }
    const availability = resolveMachineLiveStreamAvailability({
        serverFeatures,
        preferredRouteKinds: [input.routeKind],
        // The caller negotiates capture/display before requesting a grant. No
        // direct receive/control carrier exists, so endpoint presence is never
        // promoted to proven delivery viability here.
        localCaptureAvailable: true,
        remoteDisplayAvailable: true,
        loopbackRoute: { status: 'unknown' },
        relayCaps: null,
        directGrant: { status: 'missing' },
        daemonPolicy: null,
        ...resolvePeerMediationDirectPreferencesForScope({
            scope: { serverId: server.serverId, accountId }, machineId: input.sourceMachineId, flowKind: 'live_stream',
        }),
        productDefaultPreference: 'enabled',
    });
    if (availability.status !== 'available') return { ok: false,
        reasonCode: availability.status === 'disabled' ? availability.reasonCode : 'server_features_unavailable' };
    let sourceAdmission = input.sourceAdmission;
    const state = readRegisteredStorageState();
    const machine = state ? resolveServerScopedMachine(state, server.serverId, input.sourceMachineId) : null;
    if (!sourceAdmission && (input.sessionId || machine?.isShared === true)) {
        const admitted = await requestMachineLiveStreamSourceAdmission({ ...input, serverId: server.serverId, accountId });
        if (!admitted.ok) return admitted;
        sourceAdmission = admitted.sourceAdmission;
    }
    return await startServerRelayedStream({
        server, credentials, startRequest: createBaseStartRequest(input), sourceAdmission,
        timeoutMs: input.timeoutMs, signal: input.signal,
    });
}
