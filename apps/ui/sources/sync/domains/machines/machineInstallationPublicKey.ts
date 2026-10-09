import { MachineInstallationPublicKeySchema } from '@happier-dev/protocol/machines/identity/installationIdentity';

import { decodeBase64, encodeBase64 } from '@/encryption/base64';

/** Adapt the incumbent Machine row's standard-base64 key to the installation identity owner. */
export function readMachineInstallationPublicKey(value: unknown): Uint8Array | null {
    if (typeof value !== 'string') return null;
    try {
        const bytes = decodeBase64(value, 'base64');
        if (encodeBase64(bytes, 'base64') !== value) return null;
        const parsed = MachineInstallationPublicKeySchema.safeParse(encodeBase64(bytes, 'base64url'));
        return parsed.success ? bytes : null;
    } catch { return null; }
}
