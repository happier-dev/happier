import { describe, expect, it } from 'vitest';

import type { SshCredentialsDraft } from '@/components/ssh/SshCredentialsFields';

import { resolveRemoteSshBootstrapFormState } from './resolveRemoteSshBootstrapFormState';

describe('resolveRemoteSshBootstrapFormState', () => {
    it('includes pasted private key material even when it is not being saved', async () => {
        const draft: SshCredentialsDraft = {
            username: 'ubuntu',
            host: 'example.test',
            port: '22',
            authMode: 'keyfile',
            identityFilePath: '',
            password: '',
        };

        await expect(resolveRemoteSshBootstrapFormState({
            draft,
            usingSavedHost: false,
            selectedSavedHost: null,
            privateKeyMaterialDraft: '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----',
            saveSecretMaterial: false,
            installRelayRuntime: true,
            remoteHostsSecretMaterialEnabled: false,
            decryptSecretValue: () => null,
        })).resolves.toEqual(expect.objectContaining({
            sshAuth: 'keyfile',
            identityPrivateKey: expect.stringContaining('BEGIN OPENSSH PRIVATE KEY'),
        }));
    });
});
