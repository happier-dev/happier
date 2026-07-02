import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';

import { isLegacyAuthCredentials, type AuthCredentials } from './tokenStorage';

function fingerprintCredentialPart(value: string): string {
    return `sha256:${bytesToHex(sha256(utf8ToBytes(value)))}`;
}

export function resolveAuthCredentialsScopeKey(credentials: AuthCredentials): string {
    if (isLegacyAuthCredentials(credentials)) {
        return [
            'legacy',
            fingerprintCredentialPart(credentials.token),
            fingerprintCredentialPart(credentials.secret),
        ].join('\u0000');
    }
    return [
        'data-key',
        fingerprintCredentialPart(credentials.token),
        fingerprintCredentialPart(credentials.encryption.publicKey),
        fingerprintCredentialPart(credentials.encryption.machineKey),
    ].join('\u0000');
}
