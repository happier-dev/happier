import { Platform } from 'react-native';
import { createEphemeralPeerRouteProofHandleV2 } from '@happier-dev/protocol/machines/peer/mediation/ephemeralPeerRouteProofV2';
import { IrohMachineHandshakeV1Schema } from '@happier-dev/protocol/connectivity/iroh/machineHandshakeV1';
import { PeerTcpTunnelOpenV2Schema } from '@happier-dev/protocol/machines/peer/mediation/tunnel/openAuthorizationV2';
import { LocalServicePreviewNativeDirectAccessRequestV1Schema, LocalServicePreviewNativeDirectAccessV1Schema, LocalServicePreviewServerAccessRequestV1Schema, LocalServicePreviewServerAccessV1Schema } from '@happier-dev/protocol/local/services/preview/nativeDirect';
import { resolveEffectivePeerDirectRoutePolicy } from '@happier-dev/peer-mediation';

import { getRandomBytes } from '@/platform/cryptoRandom';
import { resolveTargetServer } from '@/sync/domains/machines/peer/mediation/stream/productionRouteHttp';
import { serverFetch } from '@/sync/http/client';
import { resolvePeerMediationDirectPreferencesForScope } from '@/sync/domains/settings/peerMediationPreferences';
import { readHomeApplicationCarrierEligibility } from '@/sync/runtime/homeCarrierPolicy';
import { getIrohApplicationEndpoint, probeIrohMachineTransferLifecycleAvailability, startIrohMachineTransferTunnel } from '@/sync/runtime/nativeIrohTunnels/machineTransferLifecycle';
import { runWithServerRequestAuthorityForServerAccountScope } from '@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope';
import { desktopHostKind } from '@/utils/platform/desktopHost';
import { isRuntimeActive } from '@/utils/runtime/isRuntimeActive';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

export type NativeDirectPreviewLease = Readonly<{
    localOrigin: string;
    initialPath: string;
    release: () => Promise<void>;
}>;

export function hasNativePreviewRenderer(): boolean {
    return Platform.OS !== 'web' || desktopHostKind() !== null;
}

export async function acquireServerPreviewAccess(input: Readonly<{
    previewId: string;
    machineId: string;
    serverId?: string | null;
    scope?: ServerAccountScope;
    signal?: AbortSignal;
    onScopeCaptured?: (scope: ServerAccountScope) => void;
}>): Promise<string | null> {
    // Standard HTTPS admission is shareable and available to web viewers too.
    // Only the device-local iroh lease below requires a native renderer.
    const eligible = () => !input.signal?.aborted && isRuntimeActive();
    try {
        const server = resolveTargetServer(input.serverId ?? input.scope?.serverId);
        if (!server || !eligible() || input.scope && input.scope.serverId !== server.serverId) return null;
        return await runWithServerRequestAuthorityForServerAccountScope({
            ...(input.scope ? { scope: input.scope } : { serverId: server.serverId }),
            activeRequest: (path, init) => serverFetch(path, init),
        }, async (authority) => {
            input.onScopeCaptured?.(authority.scope);
            if (!eligible()) return null;
            const response = await authority.request(`/v1/local-services/preview/${encodeURIComponent(input.previewId)}/access`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(LocalServicePreviewServerAccessRequestV1Schema.parse({ v: 1, kind: 'server_preview' })),
                signal: input.signal,
            });
            if (!response.ok) return null;
            const access = LocalServicePreviewServerAccessV1Schema.parse(await response.json());
            return eligible() && access.previewId === input.previewId && access.machineId === input.machineId ? access.accessUrl : null;
        });
    } catch { return null; }
}

export async function acquireNativeDirectPreviewAccess(input: Readonly<{
    previewId: string;
    machineId: string;
    serverId?: string | null;
    scope?: ServerAccountScope;
    signal?: AbortSignal;
    onScopeCaptured?: (scope: ServerAccountScope) => void;
}>): Promise<NativeDirectPreviewLease | null> {
    const eligible = () => !input.signal?.aborted && isRuntimeActive()
        && readHomeApplicationCarrierEligibility() !== 'standard_only'
        && hasNativePreviewRenderer();
    let proofHandle: ReturnType<typeof createEphemeralPeerRouteProofHandleV2> | undefined;
    let lease: Awaited<ReturnType<typeof startIrohMachineTransferTunnel>> | undefined;
    let directAllowed = () => false;
    try {
        if (!eligible() || !await probeIrohMachineTransferLifecycleAvailability()) return null;
        const server = resolveTargetServer(input.serverId);
        if (!server || !eligible() || input.scope && input.scope.serverId !== server.serverId) return null;
        const endpoint = await getIrohApplicationEndpoint();
        if (!eligible()) return null;
        proofHandle = createEphemeralPeerRouteProofHandleV2({ randomBytes: getRandomBytes });
        const request = LocalServicePreviewNativeDirectAccessRequestV1Schema.parse({
            v: 1,
            initiator: { kind: 'account_client', endpointId: endpoint.endpointId },
            ephemeralPublicKeyBase64Url: proofHandle.publicKeyBase64Url,
        });
        // This owner pins the Home and its Account credential until JSON bytes
        // are consumed; a snapshot never supplies viewer authorization.
        const access = await runWithServerRequestAuthorityForServerAccountScope({
            ...(input.scope ? { scope: input.scope } : { serverId: server.serverId }),
            activeRequest: (path, init) => serverFetch(path, init),
        }, async (authority) => {
            input.onScopeCaptured?.(authority.scope);
            const scope = { serverId: server.serverId, accountId: authority.scope.accountId };
            directAllowed = () => resolveEffectivePeerDirectRoutePolicy({
                flowKind: 'tcp_tunnel', routeKind: 'iroh_peer',
                // Home and daemon admission remain enforced by the access endpoint
                // and signed native handshake; this folds the exact local preferences.
                serverGateEnabled: true, daemonPolicy: null, productDefaultPreference: 'enabled',
                grant: { status: 'valid' },
                ...resolvePeerMediationDirectPreferencesForScope({ scope, machineId: input.machineId, flowKind: 'tcp_tunnel' }),
            }).allowed;
            if (!eligible() || !directAllowed()) return null;
            const response = await authority.request(`/v1/local-services/preview/${encodeURIComponent(input.previewId)}/access`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(request), signal: input.signal,
            });
            if (!response.ok) return null;
            return LocalServicePreviewNativeDirectAccessV1Schema.parse(await response.json());
        });
        if (!access || !eligible() || !directAllowed() || access.previewId !== input.previewId || access.machineId !== input.machineId) return null;
        const { grant } = access;
        const { iroh, scope } = grant.payload;
        if (!iroh || scope.kind !== 'tcp_tunnel'
            || iroh.initiator.kind !== 'account_client' || iroh.initiator.endpointId !== endpoint.endpointId) return null;
        const proof = proofHandle.sign(grant);
        const handshake = IrohMachineHandshakeV1Schema.parse({
            v: 1, accountId: grant.payload.accountId, flow: 'tcp_tunnel',
            initiator: iroh.initiator, target: iroh.target, grant, proof,
        });
        const open = PeerTcpTunnelOpenV2Schema.parse({
            v: 2, kind: 'open', tunnelId: scope.tunnelId, targetMachineId: input.machineId,
            routeKind: 'iroh_peer', destination: access.destination, grant, proof,
        });
        lease = await startIrohMachineTransferTunnel({
            endpointId: access.target.endpointId,
            directAddresses: access.target.directAddresses, relayUrls: access.target.relayUrls,
            handshakeJson: JSON.stringify(handshake), nativeHttpLease: { openJson: JSON.stringify(open) },
        });
        if (!eligible()) {
            await lease.release().catch(() => undefined);
            return null;
        }
        return { localOrigin: lease.localOrigin, initialPath: access.initialPath.pathname + access.initialPath.search, release: lease.release };
    } catch {
        // The native lifecycle retains failed stops for its existing retry owner.
        await lease?.release().catch(() => undefined);
        return null;
    } finally {
        proofHandle?.dispose();
    }
}
