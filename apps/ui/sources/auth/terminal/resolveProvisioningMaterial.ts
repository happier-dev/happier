import {
    resolveTerminalProvisioningVariantV2,
    type TerminalProvisioningV2Response,
} from '@happier-dev/protocol';
import tweetnacl from 'tweetnacl';

import { createEncryptionFromAuthCredentials } from '@/auth/encryption/createEncryptionFromAuthCredentials';
import {
    type AuthCredentials,
    isDataKeyAuthCredentials,
    isLegacyAuthCredentials,
    isTokenOnlyAuthCredentials,
} from '@/auth/storage/tokenStorage';
import { decodeBase64 } from '@/encryption/base64';

function equalBytesConstantTime(left: Uint8Array, right: Uint8Array): boolean {
    if (left.length !== right.length) return false;
    let difference = 0;
    for (let index = 0; index < left.length; index += 1) {
        difference |= left[index]! ^ right[index]!;
    }
    return difference === 0;
}

/**
 * Canonical credential-material decision for terminal/Home provisioning.
 * Plain accounts are token-only. Keyed accounts — data-key or legacy-secret
 * credentials — both derive the same canonical content private key through
 * the existing encryption owner (`createEncryptionFromAuthCredentials`), so
 * secret-bearing credentials never mint a parallel derivation formula.
 */
export async function resolveProvisioningMaterial(credentials: AuthCredentials): Promise<TerminalProvisioningV2Response> {
    // Check the two key-bearing shapes first. `TokenOnlyAuthCredentials` is a
    // structural subset of both, so testing its guard first would make the
    // later data-key branch collapse to `never` under strict narrowing.
    if (!isDataKeyAuthCredentials(credentials) && !isLegacyAuthCredentials(credentials)) {
        if (!isTokenOnlyAuthCredentials(credentials)) {
            throw new Error('Unsupported provisioning credential shape');
        }
        const variant = resolveTerminalProvisioningVariantV2({ encryptionMode: 'plain' });
        if (variant !== 'tokenOnly') throw new Error('Invalid plain provisioning policy result');
        return { type: 'tokenOnly' };
    }

    const variant = resolveTerminalProvisioningVariantV2({ encryptionMode: 'e2ee' });
    if (variant !== 'dataKey') throw new Error('Invalid E2EE provisioning policy result');

    if (isDataKeyAuthCredentials(credentials)) {
        const key = decodeBase64(credentials.encryption.machineKey, 'base64');
        if (key.length !== 32) throw new Error('Invalid data-key credential key length');
        const publicKey = decodeBase64(credentials.encryption.publicKey, 'base64');
        if (publicKey.length !== 32) throw new Error('Invalid data-key credential public key length');
        const derivedPublicKey = tweetnacl.box.keyPair.fromSecretKey(key).publicKey;
        if (!equalBytesConstantTime(publicKey, derivedPublicKey)) {
            throw new Error('Data-key credential public key does not match its machine scalar');
        }
    }

    const encryption = await createEncryptionFromAuthCredentials(credentials);
    return { type: 'dataKey', key: encryption.getContentPrivateKey() };
}
