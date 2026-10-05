import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installTokenStorageWebPlatformMocks } from '@/auth/storage/tokenStorage.testHelpers';
import { installLocalStorageMock, type LocalStorageMockHandle } from '@/auth/storage/tokenStorage.web.testHelpers';
import { AccountEncryptionMigrateRequestSchema, createAccountEncryptionMigrateRequestBindingDigestV1 } from '@happier-dev/protocol';
import { HappyError } from '@/utils/errors/errors';
import { buildContentKeyBinding } from '@/auth/oauth/contentKeyBinding';
import { deriveAccountSigningPublicKey } from '@/auth/flows/challenge';
import { encodeBase64 } from '@/encryption/base64';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { getActiveServerId, getActiveServerUrl } from '@/sync/domains/server/serverProfiles';
import * as owner from './accountEncryptionFirstKeyExternalAuth';

installTokenStorageWebPlatformMocks();
vi.mock('expo-web-browser', () => ({ openAuthSessionAsync: vi.fn() }));

describe('first-key Artifact upload custody at the real pending owner', () => {
    let storage: LocalStorageMockHandle;
    beforeEach(() => { storage = installLocalStorageMock(); });
    afterEach(() => { storage.restore(); vi.restoreAllMocks(); });

    async function fixture() {
        const seed = new Uint8Array(32).fill(7);
        const request = AccountEncryptionMigrateRequestSchema.parse({ toMode: 'e2ee', expectedAccountVersion: 8,
            expectedSigningKeyFingerprint: null, expectedContentKeyFingerprint: null, expectedSettingsVersion: 3,
            settingsContent: { t: 'encrypted', c: 'ciphertext' }, connectedServices: { action: 'assert_empty' },
            automations: { action: 'assert_empty' }, machines: { action: 'assert_empty' }, todos: { action: 'assert_empty' },
            artifacts: { action: 'assert_empty' }, sessions: { action: 'assert_empty' }, reviewComments: { action: 'assert_empty' },
            sessionOrganization: { action: 'assert_empty' }, pets: { action: 'assert_empty' },
            keyProof: { v: 1, publicKey: encodeBase64(deriveAccountSigningPublicKey(seed)), ...await buildContentKeyBinding(seed), signature: 'request-signature' },
        });
        const target = { serverId: getActiveServerId(), serverUrl: getActiveServerUrl() };
        const accountId = 'account-1';
        return { TokenStorage, owner, firstKey: { accountId, request, target }, seed };
    }

    it('discards stages after auth-entry failure with no retained request, but retains the exact pending request after close failure', async () => {
        const { TokenStorage, owner, firstKey, seed } = await fixture();
        const error = new Error('transport unavailable');
        await expect(owner.shouldRetainAccountEncryptionMigrationArtifactUploads({ error, migrationIssued: true, firstKey })).resolves.toBe(false);
        const now = Date.now();
        expect(await TokenStorage.setPendingExternalAuth({ provider: 'github', proof: 'proof', secret: Buffer.from(seed).toString('base64url'),
            ...firstKey.target,
            accountEncryptionFirstKey: { accountId: firstKey.accountId,
                requestDigest: createAccountEncryptionMigrateRequestBindingDigestV1({
                    accountId: firstKey.accountId, request: firstKey.request, sourceMode: 'plain' }), requestJson: JSON.stringify(firstKey.request),
                createdAt: now, expiresAt: now + 60_000 },
        }, firstKey.target)).toBe(true);
        await expect(owner.shouldRetainAccountEncryptionMigrationArtifactUploads({ error, migrationIssued: false, firstKey })).resolves.toBe(true);
        await expect(owner.shouldRetainAccountEncryptionMigrationArtifactUploads({ error, migrationIssued: true,
            firstKey: { ...firstKey, accountId: 'account-other' } })).resolves.toBe(false);
        await expect(owner.shouldRetainAccountEncryptionMigrationArtifactUploads({ error, migrationIssued: true,
            firstKey: { ...firstKey, request: { ...firstKey.request, expectedSettingsVersion: 4 } } })).resolves.toBe(false);
        await TokenStorage.clearPendingExternalAuth();
        await expect(owner.shouldRetainAccountEncryptionMigrationArtifactUploads({ error, migrationIssued: true, firstKey })).resolves.toBe(false);
    });

    it.each([408, 429])('retains uncertain signed submission status %s through the canonical refusal classifier', async status => {
        const { owner } = await fixture();
        await expect(owner.shouldRetainAccountEncryptionMigrationArtifactUploads({
            error: new HappyError('uncertain response', true, { status }), migrationIssued: true,
        })).resolves.toBe(true);
    });

    it('does not mistake unavailable secure custody for an absent request', async () => {
        const { owner, firstKey } = await fixture();
        storage.getItemMock.mockImplementation(() => { throw new Error('Storage unavailable'); });
        await expect(owner.shouldRetainAccountEncryptionMigrationArtifactUploads({
            error: new HappyError('refused', false, { status: 400 }), migrationIssued: true, firstKey,
        })).resolves.toBe(true);
    });
});
