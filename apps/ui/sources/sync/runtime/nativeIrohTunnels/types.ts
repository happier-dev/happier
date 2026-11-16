import type { IrohEndpointDescriptorV1, IrohObservedPath, IrohRelayPolicy } from '@happier-dev/iroh-native';
import type { LoopbackTunnelLease, LoopbackTunnelSnapshot } from '@/sync/runtime/nativeLoopbackTunnels/types';

/**
 * One reusable Home lease request. The keying facts are the Home/profile
 * identity plus the endpoint/descriptor facts that actually invalidate a lease;
 * the endpoint-scoped verification token is deliberately not part of the key.
 * There is no peer-selected destination host/port: the native layer binds a
 * loopback listener and dials the descriptor endpoint only.
 */
export type IrohHomeTunnelRequest = Readonly<{
    remoteHostId: string;
    purpose: 'home';
    homeServerIdentityId: string;
    endpointId: string;
    canonicalServerUrl: string;
    policy: IrohRelayPolicy;
    relayUrls?: readonly string[];
    directAddresses?: readonly string[];
    /** Verification performed before this runtime origin can be consumed. */
    verification: IrohHomeTunnelVerification;
}>;

export type IrohHomeTunnelVerification =
    | Readonly<{ kind: 'enrollment' }>
    | Readonly<{ kind: 'authenticated'; token: string }>;

/** Verified Home lease; `observedPath` is preserved from the native report, never inferred. */
export type IrohHomeTunnelLease = LoopbackTunnelLease & Readonly<{
    homeServerIdentityId: string;
    endpointId: string;
    carrier: 'iroh';
    observedPath: IrohObservedPath;
}>;

export type IrohHomeTunnelAcquireInput = Readonly<{
    homeServerIdentityId: string;
    endpoint: IrohEndpointDescriptorV1;
    canonicalServerUrl: string;
    policy?: IrohRelayPolicy;
    verification: IrohHomeTunnelVerification;
}>;

/**
 * Lifecycle-neutral verified origin. Releasing this handle only releases this
 * caller's supervisor reference; it never mutates active-profile publication.
 */
export type IrohHomeRuntimeOriginLease = IrohHomeTunnelLease & Readonly<{
    runtimeOrigin: string;
    release: () => Promise<void>;
}>;

export type IrohHomeTunnelRecoveryRequired = Readonly<{
    leaseId: string;
    homeServerIdentityId: string;
    reason: 'terminal' | 'degraded' | 'foreground_probe_failed' | 'stale_generation';
    /** True only when this lease owned the focused Home runtime-origin publication. */
    activePublication: boolean;
}>;

export type IrohHomeTunnelRuntime = Readonly<{
    /** Acquires a verified origin without reading or publishing active-profile state. */
    acquireHomeRuntimeOrigin: (input: IrohHomeTunnelAcquireInput) => Promise<IrohHomeRuntimeOriginLease>;
    /** Acquires (or retains) the verified Home lease and publishes its runtime origin. */
    ensureHomeTunnel: (input: IrohHomeTunnelAcquireInput) => Promise<IrohHomeRuntimeOriginLease>;
    /** Releases the native lease and unpublishes only its own target-scoped origin. */
    releaseHomeTunnel: (leaseId: string) => Promise<void>;
    /** Releases every currently published active-Home lease (logout/shutdown). */
    releaseActiveHomeTunnels: () => Promise<void>;
    /** Releases owned active leases and detaches native lifecycle observation. */
    dispose: () => Promise<void>;
    /** Releases leases that belong to a prior Home/focus generation (switch-time cleanup). */
    releaseLeasesForStaleTargets: () => Promise<void>;
    markSuspended: () => void;
    markForeground: () => Promise<void>;
    /** Transport-fact notification consumed by the existing focused/secondary retry owners. */
    subscribeRecoveryRequired: (listener: (event: IrohHomeTunnelRecoveryRequired) => void) => () => void;
    listTunnels: () => LoopbackTunnelSnapshot<IrohHomeTunnelLease, never>;
}>;
