import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';

import {
    isDataKeyAuthCredentials,
    isLegacyAuthCredentials,
    readAccountE2eeCustody,
    type AuthCredentials,
} from './tokenStorage';

function fingerprintCredentialPart(value: string): string {
    return `sha256:${bytesToHex(sha256(utf8ToBytes(value)))}`;
}

// Credentials are immutable values and every Account RPC resolves their scope several times, so one
// object is fingerprinted once. A rotated credential is a new object and is fingerprinted afresh.
const scopeKeyByCredentials = new WeakMap<AuthCredentials, string>();

export function resolveAuthCredentialsScopeKey(credentials: AuthCredentials): string {
    const known = scopeKeyByCredentials.get(credentials);
    if (known !== undefined) return known;
    const scopeKey = fingerprintAuthCredentials(credentials);
    scopeKeyByCredentials.set(credentials, scopeKey);
    return scopeKey;
}

function fingerprintAuthCredentials(credentials: AuthCredentials): string {
    // Reclassified custody is a new Account mode admission scope for the same material.
    const custody = readAccountE2eeCustody(credentials) === 'historical' ? ['historical'] : [];
    if (isLegacyAuthCredentials(credentials)) {
        return [
            'legacy',
            fingerprintCredentialPart(credentials.token),
            fingerprintCredentialPart(credentials.secret),
            ...custody,
        ].join('\u0000');
    }
    if (!isDataKeyAuthCredentials(credentials)) {
        return [
            'token-only',
            fingerprintCredentialPart(credentials.token),
        ].join('\u0000');
    }
    return [
        'data-key',
        fingerprintCredentialPart(credentials.token),
        fingerprintCredentialPart(credentials.encryption.publicKey),
        fingerprintCredentialPart(credentials.encryption.machineKey),
        ...custody,
    ].join('\u0000');
}
