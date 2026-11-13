export type LoopbackTunnelStatus = 'starting' | 'ready' | 'degraded' | 'failed' | 'stopped';

/**
 * Shared identity/purpose facts only. Carrier-specific facts (SSH destinations,
 * Iroh descriptors/verification tokens) stay in the specializing request types.
 */
export type LoopbackTunnelRequest = Readonly<{
    remoteHostId: string;
    purpose: string;
}>;

export type LoopbackTunnelLease = Readonly<{
    leaseId: string;
    key: string;
    remoteHostId: string;
    localUrl?: string;
    channelMode: 'loopback-port';
    purpose: string;
    status: LoopbackTunnelStatus;
    /** Active-server generation captured when this lease was established. */
    generation?: number;
    startedAt: string;
    expiresAt?: string;
}>;

export type LoopbackTunnelLimitation = Readonly<{
    id: string;
    severity: 'info' | 'warning' | 'error';
    reason: string;
    message: string;
}>;

/** Native start metadata handed back to the specializing lease factory (never payload bytes). */
export type LoopbackTunnelStartResult<Native = unknown> = Readonly<{
    nativeTunnelId: string;
    localPort: number;
    native?: Native;
}>;

/** Payload-free status fact emitted by a carrier's native lifecycle owner. */
export type LoopbackTunnelNativeEvent = Readonly<{
    type: 'ready' | 'path_changed' | 'degraded' | 'closed' | 'error';
    tunnelHandle: string;
    status: 'ready' | 'degraded' | 'closed' | 'error';
    observedPath?: string;
    errorCode?: string;
    atMs: number;
}>;

/** Native fact after it is correlated with the existing shared lease owner. */
export type LoopbackTunnelLifecycleEvent<Lease extends LoopbackTunnelLease = LoopbackTunnelLease> =
    LoopbackTunnelNativeEvent & Readonly<{ lease: Lease }>;

export type LoopbackTunnelAdapter<
    Request extends LoopbackTunnelRequest = LoopbackTunnelRequest,
    Native = unknown,
> = Readonly<{
    startLoopbackTunnel: (request: Request) => Promise<LoopbackTunnelStartResult<Native>>;
    stopLoopbackTunnel: (nativeTunnelId: string) => Promise<void>;
    subscribeLoopbackTunnelEvents?: (
        nativeTunnelId: string,
        listener: (event: LoopbackTunnelNativeEvent) => void,
    ) => () => void;
}>;

export type LoopbackTunnelProbeResult<Reason extends string = string> =
    | Readonly<{ ok: true }>
    | Readonly<{ ok: false; reason: Reason }>;

/**
 * Probes receive the tunnel request so carrier-specific verification facts
 * (for example the Iroh endpoint-scoped token) stay out of the shared type.
 */
export type LoopbackTunnelProbe<
    Request extends LoopbackTunnelRequest = LoopbackTunnelRequest,
    Reason extends string = string,
> = (url: string, request: Request) => Promise<LoopbackTunnelProbeResult<Reason>>;

export type LoopbackTunnelFailureCodes = Readonly<{ suspended: string; probeFailed: string; staleGeneration: string; disposed?: string; }>;

export type LoopbackTunnelLeaseFactoryInput<
    Request extends LoopbackTunnelRequest,
    Native = unknown,
> = Readonly<{
    key: string;
    request: Request;
    localPort: number;
    generation?: number;
    native?: Native;
}>;

export type LoopbackTunnelSupervisorOptions<
    Request extends LoopbackTunnelRequest,
    Lease extends LoopbackTunnelLease,
    Limitation extends LoopbackTunnelLimitation = LoopbackTunnelLimitation,
    Native = unknown,
> = Readonly<{
    adapter: LoopbackTunnelAdapter<Request, Native>;
    probe: LoopbackTunnelProbe<Request>;
    buildKey: (request: Request) => string;
    /**
     * The verification facts `buildKey` leaves out (e.g. the bearer a probe authenticates).
     * When present, a ready lease whose stored request carries the same verification is
     * shared without re-running the probe: that exact request already proved it, and the
     * native event subscription owns its liveness. Absent, every reuse re-probes.
     */
    buildVerificationKey?: (request: Request) => string;
    createLease: (value: LoopbackTunnelLeaseFactoryInput<Request, Native>) => Lease;
    probeTimeoutMs?: number;
    /** Probe-result reason used when the bounded probe times out. */
    probeTimeoutReason?: string;
    getGeneration?: () => number;
    /** Consumer-owned error identities for suspension, probe failure, and stale generations. */
    failureCodes?: Partial<LoopbackTunnelFailureCodes>;
    /** Static platform diagnostics always/conditionally exposed in snapshots. */
    platformLimitations?: Readonly<{
        foreground?: Limitation | null;
        suspended?: Limitation | null;
    }>;
    /** Maps a native start error to a runtime diagnostic; `null` records nothing. */
    limitationForStartError?: (error: unknown) => Limitation | null;
    /** Maps a failed probe/timed-out probe to a runtime diagnostic; `null` records nothing. */
    limitationForProbeFailure?: (reason: string) => Limitation | null;
    /** Specializing metadata projection only; lifecycle decisions stay shared. */
    updateLeaseForNativeEvent?: (lease: Lease, event: LoopbackTunnelNativeEvent) => Lease;
}>;

export type LoopbackTunnelSupervisor<
    Request extends LoopbackTunnelRequest = LoopbackTunnelRequest,
    Lease extends LoopbackTunnelLease = LoopbackTunnelLease,
    Limitation extends LoopbackTunnelLimitation = LoopbackTunnelLimitation,
> = Readonly<{
    ensureTunnel: (request: Request) => Promise<Lease>;
    listTunnels: () => LoopbackTunnelSnapshot<Lease, Limitation>;
    releaseTunnel: (leaseId: string) => Promise<void>;
    /** Force-releases every supervisor-owned native handle, regardless of caller reference count. */
    dispose: () => Promise<void>;
    markSuspended: () => void;
    markForeground: () => Promise<void>;
    subscribe: (listener: (event: LoopbackTunnelLifecycleEvent<Lease>) => void) => () => void;
}>;

export type LoopbackTunnelSnapshot<
    Lease extends LoopbackTunnelLease = LoopbackTunnelLease,
    Limitation extends LoopbackTunnelLimitation = LoopbackTunnelLimitation,
> = Readonly<{
    leases: readonly Lease[];
    platformLimitations: readonly Limitation[];
}>;
