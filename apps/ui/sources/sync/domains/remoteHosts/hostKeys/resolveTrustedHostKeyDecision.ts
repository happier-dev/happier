import { resolveSshHostTrust } from '@happier-dev/protocol';
import type { NativeSshHostKeyVerification } from '@happier-dev/ssh-native';

import type { RemoteHostTrustedHostKeyRecord } from './model';

export type RemoteHostTrustedHostKeyDecision =
    | Readonly<{
        action: 'accept';
        verification: NativeSshHostKeyVerification;
    }>
    | Readonly<{
        action: 'prompt';
        promptKind: 'ssh.trustHost' | 'ssh.replaceHostKey';
        existingFingerprintSha256?: string;
    }>;

export function resolveTrustedHostKeyDecision(params: Readonly<{
    event: Readonly<{
        host: string;
        port: number;
        algorithm: string;
        fingerprintSha256: string;
    }>;
    trusted: RemoteHostTrustedHostKeyRecord | null;
}>): RemoteHostTrustedHostKeyDecision {
    const trust = resolveSshHostTrust({
        host: params.event.host,
        port: params.event.port,
        algorithm: params.event.algorithm,
        fingerprintSha256: params.event.fingerprintSha256,
        trusted: params.trusted
            ? {
                host: params.trusted.hostLower,
                port: params.trusted.port,
                algorithm: params.trusted.algorithm,
                fingerprintSha256: params.trusted.fingerprintSha256,
            }
            : null,
    });

    if (trust.status === 'trusted') {
        return {
            action: 'accept',
            verification: {
                decision: 'accept-once',
                fingerprintSha256: params.event.fingerprintSha256,
            },
        };
    }

    return {
        action: 'prompt',
        promptKind: trust.promptKind,
        ...(trust.existingFingerprintSha256
            ? { existingFingerprintSha256: trust.existingFingerprintSha256 }
            : {}),
    };
}
