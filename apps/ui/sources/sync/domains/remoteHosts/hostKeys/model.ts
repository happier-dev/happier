export type RemoteHostTrustedHostKeyRecord = Readonly<{
    hostLower: string;
    port: number;
    algorithm: string;
    fingerprintSha256: string;
    trustedAtMs: number;
    lastSeenAtMs: number;
    remoteHostId?: string;
    source: 'remote-host';
}>;

export type RemoteHostTrustedHostKeyLookup = Readonly<{
    host: string;
    port: number;
    algorithm: string;
}>;

export type RemoteHostTrustedHostKeyTrustParams = RemoteHostTrustedHostKeyLookup & Readonly<{
    fingerprintSha256: string;
    remoteHostId?: string;
    nowMs?: number;
}>;

export type RemoteHostTrustedHostKeyStore = Readonly<{
    readAll: () => readonly RemoteHostTrustedHostKeyRecord[];
    get: (lookup: RemoteHostTrustedHostKeyLookup) => RemoteHostTrustedHostKeyRecord | null;
    trust: (params: RemoteHostTrustedHostKeyTrustParams) => RemoteHostTrustedHostKeyRecord;
    markSeen: (params: RemoteHostTrustedHostKeyLookup & Readonly<{ nowMs?: number }>) => void;
    delete: (lookup: RemoteHostTrustedHostKeyLookup) => void;
    clear: () => void;
}>;
