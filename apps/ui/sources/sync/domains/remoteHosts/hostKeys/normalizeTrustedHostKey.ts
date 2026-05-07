import {
    buildSshHostTrustKey,
    normalizeSshHostKeyAlgorithm,
    normalizeSshHostKeyFingerprintSha256,
    normalizeSshHostTrustHost,
    normalizeSshHostTrustPort,
} from '@happier-dev/protocol';

import type { RemoteHostTrustedHostKeyLookup } from './model';

export function normalizeRemoteHostTrustedHostKeyLookup(
    lookup: RemoteHostTrustedHostKeyLookup,
): Readonly<{
    hostLower: string;
    port: number;
    algorithm: string;
    key: string;
}> {
    const hostLower = normalizeSshHostTrustHost(lookup.host);
    const port = normalizeSshHostTrustPort(lookup.port);
    const algorithm = normalizeSshHostKeyAlgorithm(lookup.algorithm);
    return {
        hostLower,
        port,
        algorithm,
        key: buildSshHostTrustKey({ host: hostLower, port, algorithm }),
    };
}

export function normalizeRemoteHostTrustedHostKeyFingerprint(fingerprintSha256: string): string {
    return normalizeSshHostKeyFingerprintSha256(fingerprintSha256);
}
