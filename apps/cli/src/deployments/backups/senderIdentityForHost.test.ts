import { describe, expect, it } from 'vitest';
import { readManagedBootstrapSshPublicKey } from '@happier-dev/cli-common/machines/managed';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { createSavedSecretsCliHttpFixture } from '@/cli/actions/adapters/savedSecretsCliHttpFixture';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { createBackupSenderIdentityForHost } from './senderIdentityForHost';

describe('backup sender identity custody', () => {
    it('saves independent sender credentials and exposes only refs/public key', async () => {
        const fixture = await createSavedSecretsCliHttpFixture();
        try {
            const credentials = await fixture.deps.readCredentialsFn?.();
            if (!credentials) throw new Error('Fixture credentials unavailable');
            const result = await fixture.inHome(() => createBackupSenderIdentityForHost({
                name: 'Backup to Home', audience: {}, expectedScopeKey: resolveAccountSettingsScopeKeyForToken(credentials.token),
                signal: new AbortController().signal, readCredentials: async () => credentials,
            }));
            expect(result.status).toBe('ready');
            if (result.status !== 'ready') throw new Error('Credentials were not saved');
            expect(fixture.writes).toHaveLength(2);
            const key = fixture.opened(fixture.writes[0]!)?.value;
            const password = fixture.opened(fixture.writes[1]!)?.value;
            expect(typeof key).toBe('string');
            expect(typeof password).toBe('string');
            if (typeof key !== 'string' || typeof password !== 'string') throw new Error('Saved credential unavailable');
            expect(result.publicKey).toBe(readManagedBootstrapSshPublicKey(key));
            expect(password).toMatch(/^[A-Za-z0-9_-]{43}$/u);
            expect(result.sshPrivateKey).not.toEqual(result.repositoryPassword);
            expect(JSON.stringify(result)).not.toContain(key);
            expect(JSON.stringify(result)).not.toContain(password);
        } finally { await fixture.close(); }
    });

    it('retains a saved key after password custody fails and resumes with that identity', async () => {
        const fixture = await createSavedSecretsCliHttpFixture();
        try {
            const credentials = await fixture.deps.readCredentialsFn?.();
            if (!credentials) throw new Error('Fixture credentials unavailable');
            let acquisitions = 0;
            const input = { name: 'Backup to Home', audience: {}, expectedScopeKey: resolveAccountSettingsScopeKeyForToken(credentials.token),
                signal: new AbortController().signal, readCredentials: async () => ++acquisitions === 1 ? credentials : null };
            const partial = await fixture.inHome(() => createBackupSenderIdentityForHost(input));
            expect(partial).toMatchObject({ status: 'partial', errorCode: 'plugin_secret_custody_unavailable',
                senderIdentity: { publicKey: expect.stringMatching(/^ssh-ed25519 /u), sshPrivateKey: { kind: 'secret' } } });
            if (partial.status !== 'partial' || !partial.senderIdentity) throw new Error('Retained identity unavailable');
            expect(fixture.writes).toHaveLength(1);
            const resumed = await fixture.inHome(() => createBackupSenderIdentityForHost({ ...input,
                readCredentials: async () => credentials, retained: partial.senderIdentity }));
            expect(resumed).toMatchObject({ status: 'ready', publicKey: partial.senderIdentity.publicKey,
                sshPrivateKey: partial.senderIdentity.sshPrivateKey });
            expect(fixture.writes).toHaveLength(2);
        } finally { await fixture.close(); }
    });

    it('retains the existing P42 candidate reference when creation loses its response', async () => {
        const fixture = await createSavedSecretsCliHttpFixture({ loseCreateResponse: true });
        try {
            const credentials = await fixture.deps.readCredentialsFn?.();
            if (!credentials) throw new Error('Fixture credentials unavailable');
            const failure = await fixture.inHome(() => createBackupSenderIdentityForHost({
                name: 'Backup to Home', audience: {}, expectedScopeKey: resolveAccountSettingsScopeKeyForToken(credentials.token),
                signal: new AbortController().signal, readCredentials: async () => credentials,
            })).catch((error: unknown) => error);
            expect(fixture.writes).toHaveLength(1);
            const resourceId = fixture.writes[0]?.resourceId;
            if (typeof resourceId !== 'string') throw new Error('Created resource identity unavailable');
            expect(failure).toMatchObject({ code: 'outcome_unknown', cause: {
                ok: false, errorCode: 'outcome_unknown', effectAttempted: true,
                details: { candidateRef: formatSharedSavedSecretRefV1(resourceId) },
            } });
        } finally { await fixture.close(); }
    });
});
