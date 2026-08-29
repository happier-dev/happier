import { deriveAccountMachineKeyFromRecoverySecret } from '@happier-dev/protocol';
import type { TerminalProvisioningV2Response } from '@happier-dev/protocol';

import {
    type AuthCredentials,
    isDataKeyAuthCredentials,
    isLegacyAuthCredentials,
    isTokenOnlyAuthCredentials,
} from '@/auth/storage/tokenStorage';
import { decodeBase64 } from '@/encryption/base64';

/**
 * Canonical credential-material decision for terminal/Home provisioning.
 * Plain accounts are token-only; keyed accounts retain the data key and never
 * collapse it into the legacy secret field.
 */
export function resolveProvisioningMaterial(credentials: AuthCredentials): TerminalProvisioningV2Response {
    if (isTokenOnlyAuthCredentials(credentials)) return { type: 'tokenOnly' };

    if (isDataKeyAuthCredentials(credentials)) {
        const key = decodeBase64(credentials.encryption.machineKey, 'base64');
        if (key.length !== 32) throw new Error('Invalid data-key credential key length');
        return { type: 'dataKey', key };
    }

    if (isLegacyAuthCredentials(credentials)) {
        const secret = decodeBase64(credentials.secret, 'base64url');
        if (secret.length !== 32) throw new Error('Invalid legacy credential key length');
        return { type: 'dataKey', key: deriveAccountMachineKeyFromRecoverySecret(secret) };
    }

    return { type: 'tokenOnly' };
}
