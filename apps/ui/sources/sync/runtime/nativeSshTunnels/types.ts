export type NativeSshTunnelPurpose =
    | 'server-http'
    | 'server-websocket'
    | 'relay-runtime';

export type NativeSshCredentialsRef = Readonly<{
    remoteHostId: string;
    credentialId: string;
    storage: 'native-secure-storage' | 'session-memory';
}>;

export type NativeSshTunnelRequest = Readonly<{
    remoteHostId: string;
    sshTarget: string;
    sshPort?: number;
    destinationHost: '127.0.0.1' | 'localhost';
    destinationPort: number;
    purpose: NativeSshTunnelPurpose;
    credentialsRef: NativeSshCredentialsRef;
    requestedLocalPort?: number;
}>;

export type NativeSshTunnelStatus =
    | 'starting'
    | 'ready'
    | 'degraded'
    | 'failed'
    | 'stopped';

export type NativeSshTunnelLease = Readonly<{
    leaseId: string;
    key: string;
    remoteHostId: string;
    localUrl?: string;
    channelMode: 'loopback-port';
    purpose: NativeSshTunnelPurpose;
    status: NativeSshTunnelStatus;
    startedAt: string;
    expiresAt?: string;
}>;

export type NativeSshTunnelLimitation = Readonly<{
    id: string;
    severity: 'info' | 'warning' | 'error';
    reason:
        | 'authentication-failed'
        | 'foreground-only'
        | 'host-key-mismatch'
        | 'host-key-rejected'
        | 'host-key-untrusted'
        | 'loopback-bind-failed'
        | 'native-module-unavailable'
        | 'remote-service-unreachable'
        | 'platform-suspended'
        | 'network-captive-portal';
    message: string;
}>;

export type NativeSshTunnelSnapshot = Readonly<{
    leases: readonly NativeSshTunnelLease[];
    platformLimitations: readonly NativeSshTunnelLimitation[];
}>;

export type NativeSshTunnelAdapter = Readonly<{
    startLoopbackTunnel: (request: NativeSshTunnelRequest) => Promise<Readonly<{
        nativeTunnelId: string;
        localPort: number;
    }>>;
    stopLoopbackTunnel: (nativeTunnelId: string) => Promise<void>;
}>;

export type NativeSshTunnelProbeResult =
    | Readonly<{ ok: true }>
    | Readonly<{
        ok: false;
        reason:
            | 'remote-service-unreachable'
            | 'network-captive-portal'
            | 'loopback-bind-failed';
    }>;

export type NativeSshTunnelProbe = (url: string) => Promise<NativeSshTunnelProbeResult>;

export type NativeSshTunnelSupervisor = Readonly<{
    ensureTunnel: (request: NativeSshTunnelRequest) => Promise<NativeSshTunnelLease>;
    listTunnels: () => NativeSshTunnelSnapshot;
    releaseTunnel: (leaseId: string) => Promise<void>;
    markSuspended: () => void;
    markForeground: () => Promise<void>;
}>;
