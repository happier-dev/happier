import type { RemoteHost } from '@/sync/domains/remoteHosts/remoteHostModel';
import { getRemoteHostLocalOverrides } from '@/sync/domains/remoteHosts/remoteHostLocalOverrides';

/**
 * A key-file host without either its device-local path or authorized managed
 * key material cannot execute the existing SSH task. Keep that unavailable
 * destination out of the Move Home menu instead of exposing a dead action.
 */
export function isEligiblePersonalHomeRelocationHost(
    host: RemoteHost,
    secretMaterialAllowed: boolean,
): boolean {
    if (!host.ssh.target.trim()) return false;
    if (host.ssh.authMode === 'password') {
        return secretMaterialAllowed && Boolean(host.ssh.passwordSecretRef);
    }
    if (host.ssh.authMode !== 'keyfile') return true;
    const localOverrides = getRemoteHostLocalOverrides(host.id);
    return Boolean(localOverrides?.identityFilePath?.trim())
        || (secretMaterialAllowed && Boolean(host.ssh.identityPrivateKeySecretRef));
}
