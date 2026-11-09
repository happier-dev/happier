import { describe, expect, it, vi } from 'vitest';
import { settingsParse } from '@/sync/domains/settings/settings';
import { resolveAccountScopedCryptoMaterialFromCredentials } from '@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials';
import { openAccountScopedBlobCiphertext, sealAccountScopedBlobCiphertext } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { createAccountEncryptionMigrateProofSigningInputV1 } from '@happier-dev/protocol/account/encryptionMigrate';
import { deriveSettingsSecretsKeySetV1, encryptSecretStringV1 } from '@happier-dev/protocol/crypto/settingsSecretStringsV1';
import { buildAccountEncryptionMigrateToE2eeRequest } from './buildAccountEncryptionMigrateToE2eeRequest';
import { buildAccountEncryptionMigrateToPlainRequest } from './buildAccountEncryptionMigrateToPlainRequest';

const credentials = { token: 'test-account', secret: Buffer.from(new Uint8Array(32).fill(19)).toString('base64url') };
const material = resolveAccountScopedCryptoMaterialFromCredentials(credentials);
const common = {
  expectedAccountVersion: 4, expectedSettingsVersion: 9,
  expectedSigningKeyFingerprint: null, expectedContentKeyFingerprint: null,
  settings: settingsParse({}), rawSettings: {}, connectedServiceProfiles: [], automations: [],
  storageDirectives: {
    machines: { action: 'assert_empty' as const }, todos: { action: 'assert_empty' as const },
    artifacts: { action: 'assert_empty' as const }, sessions: { action: 'assert_empty' as const },
    reviewComments: { action: 'assert_empty' as const }, sessionOrganization: { action: 'assert_empty' as const },
    pets: { action: 'assert_empty' as const },
  },
};
const keyProof = {
  v: 1 as const, publicKey: Buffer.from(new Uint8Array(32).fill(1)).toString('base64'),
  contentPublicKey: Buffer.from(new Uint8Array(32).fill(2)).toString('base64'),
  contentPublicKeySig: 'test-binding', sign: (_input: Uint8Array) => 'test-signature',
};
const unavailableRead = async (): Promise<never> => { throw new Error('Unexpected unrelated content read'); };
const createdAt = '2026-10-01T01:02:03.000Z';

describe('Account encryption Settings history', () => {
  it('reseals exact raw history through both existing request builders and binds history into the proof', async () => {
    // Unknown roots, retired local-only roots and missing defaults are historical restore data.
    const raw = { schemaVersion: 1, executionRunsGuidanceEnabled: 'retained', lastUsedAgent: 'historical-agent',
      unknownRoot: { nested: [false, null, { untouched: 2 }] }, dismissedCLIWarnings: { retained: true } };
    const settingsHistory = [{ version: 8, createdAt, encryptionMode: 'plain' as const,
      content: { t: 'plain' as const, v: raw } },
    { version: 7, createdAt, encryptionMode: 'plain' as const, content: null },
    { version: 6, createdAt, encryptionMode: 'plain' as const, content: { t: 'plain' as const, v: {} } }];
    const sign = vi.fn(keyProof.sign);
    const encrypted = await buildAccountEncryptionMigrateToE2eeRequest({ ...common, credentials,
      accountId: 'account-1', keyProof: { ...keyProof, sign }, settingsHistory,
      fetchConnectedServiceCredentialPlain: unavailableRead });
    expect(encrypted.settingsHistory !== undefined).toBe(true);
    const encryptedItems = encrypted.settingsHistory!.items;
    expect(encryptedItems.map(row => row.version)).toEqual([8, 7, 6]);
    expect(encryptedItems[1]).toEqual({ version: 7, expectedContent: null, content: null });
    for (const [index, payload] of [[0, raw], [2, {}]] as const) {
      const item = encryptedItems[index];
      expect(item.expectedContent).toEqual(settingsHistory[index].content);
      if (item.content?.t !== 'encrypted') throw new Error('Expected sealed history');
      const opened = openAccountScopedBlobCiphertext({ kind: 'account_settings', material, ciphertext: item.content.c });
      expect(JSON.stringify(opened?.value) === JSON.stringify(payload)).toBe(true);
    }
    expect(sign).toHaveBeenCalledWith(createAccountEncryptionMigrateProofSigningInputV1({
      accountId: 'account-1', sourceMode: 'plain', request: encrypted,
    }));
    const plain = await buildAccountEncryptionMigrateToPlainRequest({ ...common, credentials,
      settingsHistory: encryptedItems.map(row => ({ version: row.version, createdAt,
        encryptionMode: 'e2ee' as const, content: row.content })),
      fetchConnectedServiceCredentialSealed: unavailableRead, decryptAutomationTemplateRaw: unavailableRead });
    expect(JSON.stringify(plain.settingsHistory?.items.map(row => row.content))
      === JSON.stringify(settingsHistory.map(row => row.content))).toBe(true);
  });

  it.each(['record-mode', 'envelope-mode', 'corrupt'] as const)(
    'refuses %s historical content before producing a migration request', async failure => {
      const content = failure === 'corrupt' ? { t: 'encrypted' as const, c: 'invalid-ciphertext' }
        : { t: 'plain' as const, v: {} };
      const settingsHistory = [{ version: 8, createdAt,
        encryptionMode: failure === 'record-mode' ? 'plain' as const : 'e2ee' as const, content }];
      await expect(buildAccountEncryptionMigrateToPlainRequest({ ...common, credentials, settingsHistory,
        fetchConnectedServiceCredentialSealed: unavailableRead, decryptAutomationTemplateRaw: unavailableRead,
      })).rejects.toMatchObject({ code: 'migration_inventory_changed' });
    },
  );

  it('refuses encrypted history for a Plain source without attempting to create source keys', async () => {
    const settingsHistory = [{ version: 8, createdAt, encryptionMode: 'plain' as const,
      content: { t: 'encrypted' as const, c: sealAccountScopedBlobCiphertext({ kind: 'account_settings', material,
        payload: {}, randomBytes: length => new Uint8Array(length).fill(11) }) } }];
    const sign = vi.fn(keyProof.sign);
    await expect(buildAccountEncryptionMigrateToE2eeRequest({ ...common, credentials,
      accountId: 'account-1', keyProof: { ...keyProof, sign }, settingsHistory,
      fetchConnectedServiceCredentialPlain: unavailableRead,
    })).rejects.toMatchObject({ code: 'migration_inventory_changed' });
    expect(sign).not.toHaveBeenCalled();
  });

  it.each([false, true])('opens historical nested secrets with the existing source keys and refuses unavailable keys (%s)', async wrongKey => {
    const writeKey = wrongKey ? new Uint8Array(32).fill(99) : deriveSettingsSecretsKeySetV1(material).writeKey;
    const encryptedValue = encryptSecretStringV1('historical-test-value', writeKey, length => new Uint8Array(length).fill(12));
    const raw = { unknownRoot: { secret: { _isSecretValue: true as const, encryptedValue } } };
    const settingsHistory = [{ version: 8, createdAt, encryptionMode: 'e2ee' as const,
      content: { t: 'encrypted' as const, c: sealAccountScopedBlobCiphertext({ kind: 'account_settings', material,
        payload: raw, randomBytes: length => new Uint8Array(length).fill(13) }) } }];
    const pending = buildAccountEncryptionMigrateToPlainRequest({ ...common, credentials, settingsHistory,
      fetchConnectedServiceCredentialSealed: unavailableRead, decryptAutomationTemplateRaw: unavailableRead });
    if (wrongKey) await expect(pending).rejects.toMatchObject({ code: 'migration_inventory_changed' });
    else {
      const result = await pending;
      expect(JSON.stringify(result.settingsHistory?.items[0]?.content) === JSON.stringify({ t: 'plain',
        v: { unknownRoot: { secret: { _isSecretValue: true, value: 'historical-test-value' } } } })).toBe(true);
    }
  });
});
