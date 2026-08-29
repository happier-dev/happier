export type LoopbackTunnelStatus = 'starting' | 'ready' | 'degraded' | 'failed' | 'stopped';

export type LoopbackTunnelRequest = Readonly<{
    remoteHostId: string;
    destinationHost: string;
    destinationPort: number;
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

export type LoopbackTunnelSnapshot<
    Lease extends LoopbackTunnelLease = LoopbackTunnelLease,
    Limitation extends LoopbackTunnelLimitation = LoopbackTunnelLimitation,
> = Readonly<{
    leases: readonly Lease[];
    platformLimitations: readonly Limitation[];
}>;

export type LoopbackTunnelAdapter<Request extends LoopbackTunnelRequest = LoopbackTunnelRequest> = Readonly<{
    startLoopbackTunnel: (request: Request) => Promise<Readonly<{ nativeTunnelId: string; localPort: number }>>;
    stopLoopbackTunnel: (nativeTunnelId: string) => Promise<void>;
}>;

export type LoopbackTunnelProbeResult<Reason extends string = string> =
    | Readonly<{ ok: true }>
    | Readonly<{ ok: false; reason: Reason }>;

export type LoopbackTunnelProbe<Reason extends string = string> =
    (url: string) => Promise<LoopbackTunnelProbeResult<Reason>>;

export type LoopbackTunnelSupervisor<
    Request extends LoopbackTunnelRequest = LoopbackTunnelRequest,
    Lease extends LoopbackTunnelLease = LoopbackTunnelLease,
    Limitation extends LoopbackTunnelLimitation = LoopbackTunnelLimitation,
> = Readonly<{
    ensureTunnel: (request: Request) => Promise<Lease>;
    listTunnels: () => LoopbackTunnelSnapshot<Lease, Limitation>;
    releaseTunnel: (leaseId: string) => Promise<void>;
    markSuspended: () => void;
    markForeground: () => Promise<void>;
}>;
