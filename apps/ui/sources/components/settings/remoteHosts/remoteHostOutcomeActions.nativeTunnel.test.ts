import { describe, expect, it } from 'vitest';

import {
    buildNativeSshTunnelCredentialsFromRemoteHostConfig,
    buildNativeSshTunnelRequestFromRemoteHostConfig,
} from './remoteHostOutcomeActions';

describe('remote host native tunnel outcome actions', () => {
    it('builds native tunnel requests and credentials from password-based remote host config', () => {
        const config = {
            sshTarget: 'dev@10.0.0.5',
            sshPort: 2222,
            sshAuth: 'password' as const,
            identityFilePath: '',
            identityPrivateKey: '',
            sshConfigFilePath: '',
            password: 'secret',
        };

        expect(buildNativeSshTunnelRequestFromRemoteHostConfig({
            remoteHostId: 'host-a',
            config,
        })).toEqual({
            remoteHostId: 'host-a',
            sshTarget: 'dev@10.0.0.5',
            sshPort: 2222,
            destinationHost: '127.0.0.1',
            destinationPort: 3005,
            purpose: 'server-http',
            credentialsRef: {
                remoteHostId: 'host-a',
                credentialId: 'remote-host:host-a:ssh',
                storage: 'session-memory',
            },
        });
        expect(buildNativeSshTunnelCredentialsFromRemoteHostConfig(config)).toEqual({
            auth: {
                username: 'dev',
                password: 'secret',
            },
        });
    });

    it('does not claim native tunnel support for SSH agent or device-local identity-file paths', () => {
        expect(buildNativeSshTunnelCredentialsFromRemoteHostConfig({
            sshTarget: 'dev@10.0.0.5',
            sshPort: null,
            sshAuth: 'agent',
            identityFilePath: '',
            identityPrivateKey: '',
            sshConfigFilePath: '',
            password: '',
        })).toBeNull();
        expect(buildNativeSshTunnelCredentialsFromRemoteHostConfig({
            sshTarget: 'dev@10.0.0.5',
            sshPort: null,
            sshAuth: 'keyfile',
            identityFilePath: '/Users/dev/.ssh/id_ed25519',
            identityPrivateKey: '',
            sshConfigFilePath: '',
            password: '',
        })).toBeNull();
    });

    it('passes encrypted private keys to native tunnel auth so native passphrase prompts can complete the connection', () => {
        const encryptedOpenSshPrivateKey = [
            '-----BEGIN OPENSSH PRIVATE KEY-----',
            'Proc-Type: 4,ENCRYPTED',
            'private-key-body',
            '-----END OPENSSH PRIVATE KEY-----',
        ].join('\n');
        expect(buildNativeSshTunnelCredentialsFromRemoteHostConfig({
            sshTarget: 'dev@10.0.0.5',
            sshPort: null,
            sshAuth: 'keyfile',
            identityFilePath: '',
            identityPrivateKey: encryptedOpenSshPrivateKey,
            sshConfigFilePath: '',
            password: '',
        })).toEqual({
            auth: {
                username: 'dev',
                privateKeyPem: encryptedOpenSshPrivateKey,
            },
        });

        const encryptedPkcs8PrivateKey = [
            '-----BEGIN ENCRYPTED PRIVATE KEY-----',
            'private-key-body',
            '-----END ENCRYPTED PRIVATE KEY-----',
        ].join('\n');
        expect(buildNativeSshTunnelCredentialsFromRemoteHostConfig({
            sshTarget: 'dev@10.0.0.5',
            sshPort: null,
            sshAuth: 'keyfile',
            identityFilePath: '',
            identityPrivateKey: encryptedPkcs8PrivateKey,
            sshConfigFilePath: '',
            password: '',
        })).toEqual({
            auth: {
                username: 'dev',
                privateKeyPem: encryptedPkcs8PrivateKey,
            },
        });
    });
});
