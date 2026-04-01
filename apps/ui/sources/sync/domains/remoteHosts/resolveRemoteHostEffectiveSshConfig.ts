import type { SecretString } from '@/sync/encryption/secretSettings';

import type { RemoteHost, RemoteHostAuthMode, RemoteHostId } from './remoteHostModel';
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
            code: 'identity_file_required';
            message: string;
        }>;
    }>;

type SecretDecryptor = (input: SecretString | null | undefined) => string | null;

export async function resolveRemoteHostEffectiveSshConfig(params: Readonly<{
    remoteHost: RemoteHost;
    localOverrides: RemoteHostLocalOverrides | null;
    secretMaterialAllowed: boolean;
    decryptSecretValue: SecretDecryptor;
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
        } else if (params.secretMaterialAllowed) {
            const enc = ssh.identityPrivateKeyEnc;
            const privateKey = params.decryptSecretValue(enc);
            if (privateKey) {
                identityPrivateKey = String(privateKey).trim();
            }
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
    if (sshAuth === 'password') {
        if (params.secretMaterialAllowed) {
            password = String(params.decryptSecretValue(ssh.passwordEnc) ?? '');
        }
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
