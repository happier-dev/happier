import {
    createIrohNativeAdapter,
    createOptionalIrohNativeAdapter,
    IROH_HOME_TUNNEL_PROBE_FAILED_ERROR,
    IROH_HOME_TUNNEL_STALE_GENERATION_ERROR,
    IROH_HOME_TUNNEL_SUSPENDED_ERROR,
    type IrohHomeTunnelLease as IrohNativeHomeTunnelLease,
    type IrohNativeAdapter,
} from '@happier-dev/iroh-native';
import type { DoctorSnapshotHomeTransportDiagnostics } from '@happier-dev/protocol/diagnostics/doctorSnapshot';

import { createLoopbackTunnelSupervisor } from '@/sync/runtime/nativeLoopbackTunnels/supervisor';
import type {
    LoopbackTunnelAdapter,
    LoopbackTunnelNativeEvent,
    LoopbackTunnelProbeResult,
    LoopbackTunnelSupervisor,
} from '@/sync/runtime/nativeLoopbackTunnels/types';

import { createDesktopIrohLifecycleModule } from './desktopLifecycle';
import { probeIrohHomeTunnelOrigin, type IrohHomeTunnelProbeFailureReason } from './probe';
import {
    createInitialIrohHomeTransportDiagnostics,
    projectIrohHomeTransportDiagnosticsEvent,
    projectIrohHomeTransportDiagnosticsFailure,
    projectIrohHomeTransportDiagnosticsReady,
} from './diagnostics';
import type { IrohHomeTunnelLease, IrohHomeTunnelRequest } from './types';
import {
    createIrohHomeTransportDiagnosticsPublisher,
    type IrohHomeTransportDiagnosticsPublisher,
} from '@/sync/runtime/irohHomeTransportDiagnostics';

let nextDiagnosticsProducerId = 1;

/** Lifecycle-only native boundary consumed by the supervisor (see `createIrohNativeAdapter`). */
export type IrohNativeLifecycleModule = NonNullable<Parameters<typeof createIrohNativeAdapter>[0]>;

/** Terminal admission refusal once the owning supervisor/runtime disposal has begun. */
export const IROH_HOME_TUNNEL_DISPOSED_ERROR = 'iroh_home_tunnel_disposed';

export type IrohHomeTunnelSupervisor = LoopbackTunnelSupervisor<IrohHomeTunnelRequest, IrohHomeTunnelLease, never>;

function readDiagnosticError(error: unknown): Readonly<{ code: string; message?: string }> {
    if (error && typeof error === 'object') {
        const record = error as { code?: unknown; message?: unknown };
        const message = typeof record.message === 'string' && record.message.trim() ? record.message : undefined;
        if (typeof record.code === 'string' && record.code.trim()) {
            return { code: record.code, ...(message ? { message } : {}) };
        }
        if (message) return { code: message.split(':', 1)[0] || 'unknown', message };
    }
    return { code: 'unknown' };
}

/**
 * `undefined` resolves the platform lifecycle module per start: the desktop
 * host command bridge in a desktop shell, otherwise the optional Expo native
 * module (the SSH adapter's convention); `null` means explicitly none.
 * Resolving per start keeps lifecycle supervision working when the native
 * module appears mid-session.
 */
function createBoundNativeAdapter(native?: IrohNativeLifecycleModule | null): IrohNativeAdapter {
    if (native === undefined) {
        const desktopModule = createDesktopIrohLifecycleModule();
        if (desktopModule !== null) return createIrohNativeAdapter(desktopModule);
        return createOptionalIrohNativeAdapter();
    }
    return createIrohNativeAdapter(native ?? undefined);
}

/** Normalized Iroh lease identity: Home/endpoint/descriptor facts, never the verification token. */
export function buildIrohHomeTunnelKey(request: IrohHomeTunnelRequest): string {
    return JSON.stringify({
        remoteHostId: request.remoteHostId.trim(),
        purpose: request.purpose,
        homeServerIdentityId: request.homeServerIdentityId.trim(),
        endpointId: request.endpointId.trim(),
        canonicalServerUrl: request.canonicalServerUrl.trim().replace(/\/+$/, ''),
        policy: request.policy,
        relayUrls: request.relayUrls ? [...request.relayUrls] : null,
        directAddresses: request.directAddresses ? [...request.directAddresses] : null,
    });
}

export function createIrohHomeTunnelSupervisor(params: Readonly<{
    native?: IrohNativeLifecycleModule | null;
    probe?: (url: string, request: IrohHomeTunnelRequest) => Promise<LoopbackTunnelProbeResult<IrohHomeTunnelProbeFailureReason>>;
    probeTimeoutMs?: number;
}> = {}): IrohHomeTunnelSupervisor {
    const nativeAdaptersByTunnelId = new Map<string, IrohNativeAdapter>();
    /**
     * Native adapters whose disposal could not release every native lease they
     * own (a start rejected for identity mismatch whose cleanup also failed).
     * They stay owned here and are retried at this supervisor's own disposal.
     */
    const nativeAdaptersRetainingCustody = new Set<IrohNativeAdapter>();
    const adapter: LoopbackTunnelAdapter<IrohHomeTunnelRequest, IrohNativeHomeTunnelLease> = {
        async startLoopbackTunnel(request) {
            const nativeAdapter = createBoundNativeAdapter(params.native);
            // Carries homeServerIdentityId, endpointId, relay URLs, direct
            // addresses and the relay policy verbatim into
            // the native request. The verification token never enters native config.
            let nativeLease: IrohNativeHomeTunnelLease;
            try {
                nativeLease = await nativeAdapter.ensureHomeTunnel({
                    homeServerIdentityId: request.homeServerIdentityId,
                    endpointId: request.endpointId,
                    policy: request.policy,
                    relayUrls: request.relayUrls,
                    directAddresses: request.directAddresses,
                });
            } catch (error) {
                // A rejected start can still leave this adapter owning a native
                // lease it refused to publish. Disposal is its terminal
                // boundary; keep it owned when disposal cannot finish.
                await nativeAdapter.dispose().catch(() => {
                    nativeAdaptersRetainingCustody.add(nativeAdapter);
                });
                throw error;
            }
            let localPort = 0;
            try {
                localPort = Number(new URL(nativeLease.runtimeOrigin).port) || 0;
            } catch {
                localPort = 0;
            }
            nativeAdaptersByTunnelId.set(nativeLease.leaseId, nativeAdapter);
            return { nativeTunnelId: nativeLease.leaseId, localPort, native: nativeLease };
        },
        async stopLoopbackTunnel(nativeTunnelId) {
            const nativeAdapter = nativeAdaptersByTunnelId.get(nativeTunnelId) ?? createBoundNativeAdapter(params.native);
            try {
                await nativeAdapter.releaseHomeTunnel(nativeTunnelId);
            } finally {
                nativeAdaptersByTunnelId.delete(nativeTunnelId);
            }
        },
        subscribeLoopbackTunnelEvents(nativeTunnelId, listener) {
            const nativeAdapter = nativeAdaptersByTunnelId.get(nativeTunnelId);
            return nativeAdapter?.subscribeEvents(nativeTunnelId, listener) ?? (() => undefined);
        },
    };

    const supervisor = createLoopbackTunnelSupervisor<IrohHomeTunnelRequest, IrohHomeTunnelLease, never, IrohNativeHomeTunnelLease>({
        adapter,
        probe: params.probe ?? probeIrohHomeTunnelOrigin,
        probeTimeoutMs: params.probeTimeoutMs,
        buildKey: buildIrohHomeTunnelKey,
        failureCodes: {
            suspended: IROH_HOME_TUNNEL_SUSPENDED_ERROR,
            probeFailed: IROH_HOME_TUNNEL_PROBE_FAILED_ERROR,
            staleGeneration: IROH_HOME_TUNNEL_STALE_GENERATION_ERROR,
            disposed: IROH_HOME_TUNNEL_DISPOSED_ERROR,
        },
        createLease: ({ key, request, native }) => ({
            leaseId: `iroh-home:${key}`,
            key,
            remoteHostId: request.remoteHostId,
            // Preserve the actual native runtime origin; observedPath is the
            // native-reported path, never inferred in TypeScript.
            ...(native?.runtimeOrigin ? { localUrl: native.runtimeOrigin } : {}),
            channelMode: 'loopback-port',
            purpose: 'home',
            status: 'ready',
            startedAt: new Date().toISOString(),
            homeServerIdentityId: request.homeServerIdentityId,
            endpointId: request.endpointId,
            carrier: 'iroh',
            observedPath: native?.observedPath ?? 'unknown',
        }),
        updateLeaseForNativeEvent: (lease, event: LoopbackTunnelNativeEvent) => ({
            ...lease,
            ...(event.observedPath === 'direct' || event.observedPath === 'relay' || event.observedPath === 'unknown'
                ? { observedPath: event.observedPath }
                : {}),
        }),
    });
    const diagnosticsProducerId = `native-home-tunnel-supervisor:${nextDiagnosticsProducerId++}`;
    const diagnosticsByLeaseId = new Map<string, Readonly<{
        diagnostics: DoctorSnapshotHomeTransportDiagnostics;
        publisher: IrohHomeTransportDiagnosticsPublisher;
    }>>();

    function publishDiagnostics(
        leaseId: string,
        diagnostics: DoctorSnapshotHomeTransportDiagnostics,
    ): void {
        const observation = diagnosticsByLeaseId.get(leaseId);
        if (!observation) return;
        diagnosticsByLeaseId.set(leaseId, { ...observation, diagnostics });
        observation.publisher.publish(diagnostics);
    }

    function releaseDiagnostics(leaseId: string): void {
        const observation = diagnosticsByLeaseId.get(leaseId);
        if (!observation) return;
        const closed = projectIrohHomeTransportDiagnosticsEvent(
            observation.diagnostics,
            { type: 'closed', atMs: Date.now() },
        );
        observation.publisher.release(closed);
        diagnosticsByLeaseId.delete(leaseId);
    }

    supervisor.subscribe((event) => {
        const current = diagnosticsByLeaseId.get(event.lease.leaseId)?.diagnostics;
        if (!current) return;
        publishDiagnostics(
            event.lease.leaseId,
            projectIrohHomeTransportDiagnosticsEvent(current, event),
        );
    });

    return {
        ...supervisor,
        async ensureTunnel(request) {
            const atMs = Date.now();
            const leaseId = `iroh-home:${buildIrohHomeTunnelKey(request)}`;
            let observation = diagnosticsByLeaseId.get(leaseId);
            if (!observation) {
                const initial = createInitialIrohHomeTransportDiagnostics({
                    homeServerIdentityId: request.homeServerIdentityId,
                    remoteEndpointId: request.endpointId,
                    policy: request.policy,
                    relayUrls: request.relayUrls,
                    directAddresses: request.directAddresses,
                    atMs,
                });
                const publisher = createIrohHomeTransportDiagnosticsPublisher({
                    producerId: diagnosticsProducerId,
                    leaseId,
                    homeServerIdentityId: request.homeServerIdentityId,
                });
                observation = { diagnostics: initial, publisher };
                diagnosticsByLeaseId.set(leaseId, observation);
                publisher.publish(initial);
            }
            try {
                const lease = await supervisor.ensureTunnel(request);
                publishDiagnostics(
                    leaseId,
                    projectIrohHomeTransportDiagnosticsReady(observation.diagnostics, {
                        observedPath: lease.observedPath,
                        atMs: Date.now(),
                    }),
                );
                return lease;
            } catch (error) {
                const currentObservation = diagnosticsByLeaseId.get(leaseId) ?? observation;
                const failure = projectIrohHomeTransportDiagnosticsFailure(currentObservation.diagnostics, {
                    ...readDiagnosticError(error),
                    atMs: Date.now(),
                });
                currentObservation.publisher.release(failure);
                if (diagnosticsByLeaseId.get(leaseId) === currentObservation) diagnosticsByLeaseId.delete(leaseId);
                throw error;
            }
        },
        async releaseTunnel(leaseId) {
            await supervisor.releaseTunnel(leaseId);
            if (!supervisor.listTunnels().leases.some((lease) => lease.leaseId === leaseId)) {
                releaseDiagnostics(leaseId);
            }
        },
        async dispose() {
            const ownedLeaseIds = new Set(supervisor.listTunnels().leases.map((lease) => lease.leaseId));
            try {
                const errors: unknown[] = [];
                try {
                    await supervisor.dispose();
                } catch (error) {
                    errors.push(error);
                }
                // Retry any native custody a rejected start could not release.
                // A successful disposal drops the adapter; a failing one stays
                // owned for the next disposal rather than being orphaned.
                for (const nativeAdapter of [...nativeAdaptersRetainingCustody]) {
                    try {
                        await nativeAdapter.dispose();
                        nativeAdaptersRetainingCustody.delete(nativeAdapter);
                    } catch (error) {
                        errors.push(error);
                    }
                }
                if (errors.length === 1) throw errors[0];
                if (errors.length > 1) throw new AggregateError(errors, 'Failed to dispose every Iroh Home tunnel.');
            } finally {
                // Disposal stops each owned handle once; failed stops stay owned
                // by the same supervisor, so only released Homes age here.
                for (const leaseId of ownedLeaseIds) {
                    if (!supervisor.listTunnels().leases.some((lease) => lease.leaseId === leaseId)) {
                        releaseDiagnostics(leaseId);
                    }
                }
            }
        },
    };
}
