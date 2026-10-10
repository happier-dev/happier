import type { RemoteHost, RemoteHostAuthMode } from './remoteHostModel';
import type { RemoteHostLocalOverrides } from './remoteHostLocalOverrides';

export type RemoteHostEffectiveSshConfig = Readonly<{
    sshTarget: string;
    sshPort: number | null;
    sshAuth: RemoteHostAuthMode;
    identityFilePath: string;
    identityPrivateKey: string;
    sshConfigFilePath: string;
    password: string;
}>;

export type ResolveRemoteHostEffectiveSshConfigResult =
    | Readonly<{
        ok: true;
        value: RemoteHostEffectiveSshConfig;
    }>
    | Readonly<{
        ok: false;
        error: Readonly<{
            code: 'identity_file_required' | 'saved_secret_unavailable' | 'saved_secret_changed';
            message: string;
        }>;
    }>;

export type RemoteHostSavedSecretValueReader = (reference: string) => Promise<
    | Readonly<{ ok: true; value: string }>
    | Readonly<{ ok: false; reason: 'unavailable' | 'changed' }>
>;

function secretFailure(reason: 'unavailable' | 'changed'): ResolveRemoteHostEffectiveSshConfigResult {
    return { ok: false, error: { code: reason === 'changed' ? 'saved_secret_changed' : 'saved_secret_unavailable',
        message: reason === 'changed' ? 'The Account changed before the SSH credential could be used.' : 'The saved SSH credential is unavailable.' } };
}

export async function resolveRemoteHostEffectiveSshConfig(params: Readonly<{
    remoteHost: RemoteHost;
    localOverrides: RemoteHostLocalOverrides | null;
    secretMaterialAllowed: boolean;
    readSavedSecretValue: RemoteHostSavedSecretValueReader;
}>): Promise<ResolveRemoteHostEffectiveSshConfigResult> {
    const ssh = params.remoteHost.ssh;
    const sshTarget = String(ssh.target ?? '').trim();
    const sshPort = typeof ssh.port === 'number' && Number.isInteger(ssh.port) && ssh.port > 0 ? ssh.port : null;
    const sshConfigFilePath = String(params.localOverrides?.sshConfigFilePath ?? '').trim();

    const sshAuth = ssh.authMode;

    let identityFilePath = '';
    let identityPrivateKey = '';
    if (sshAuth === 'keyfile') {
        const localIdentityFilePath = String(params.localOverrides?.identityFilePath ?? '').trim();
        if (localIdentityFilePath) {
            identityFilePath = localIdentityFilePath;
        } else if (ssh.identityPrivateKeySecretRef) {
            if (!params.secretMaterialAllowed) return secretFailure('unavailable');
            const material = await params.readSavedSecretValue(ssh.identityPrivateKeySecretRef);
            if (!material.ok) return secretFailure(material.reason);
            identityPrivateKey = material.value.trim();
        }

        if (!identityFilePath && !identityPrivateKey) {
            return {
                ok: false,
                error: {
                    code: 'identity_file_required',
                    message: 'An SSH identity file is required for key file authentication.',
                },
            };
        }
    }

    let password = '';
    if (sshAuth === 'password' && ssh.passwordSecretRef) {
        if (!params.secretMaterialAllowed) return secretFailure('unavailable');
        const material = await params.readSavedSecretValue(ssh.passwordSecretRef);
        if (!material.ok) return secretFailure(material.reason);
        password = material.value;
    }

    return {
        ok: true,
        value: {
            sshTarget,
            sshPort,
            sshAuth,
            identityFilePath,
            identityPrivateKey,
            sshConfigFilePath,
            password,
        },
    };
}
