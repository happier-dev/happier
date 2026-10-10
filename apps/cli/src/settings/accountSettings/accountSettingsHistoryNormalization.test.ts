import { beforeEach, describe, expect, it, vi } from 'vitest';
import { deriveSavedSecretImportResourceIdV1 } from '@happier-dev/protocol/account/settings/savedSecretMutationOwner';
import { normalizeCliAccountSettingsHistoryAfterTransfer } from './accountSettingsHistoryNormalization';

const boundary = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
// HTTP is the boundary; orchestration, envelope opening and normalization stay real.
vi.mock('axios', () => ({ default: { get: boundary.get, post: boundary.post, isAxiosError: () => false } }));

describe('captured CLI Account Settings history normalization', () => {
  beforeEach(() => { boundary.get.mockReset(); boundary.post.mockReset(); });

  it('cleans only proved items on the captured Home and retains exact unknown or locked versions pending', async () => {
    const migrated = { id: 'migrated', name: 'Old', kind: 'token', encryptedValue: {
      _isSecretValue: true, value: 'old-fixture' }, createdAt: 1, updatedAt: 1 };
    const untransferred = { ...migrated, id: 'not-migrated' };
    const unknown = { ...migrated, futureCredential: 'retained-fixture' };
    const recorded = { t: 'plain', v: { secrets: [migrated, untransferred, unknown], futurePreference: { keep: true } } };
    const resourceId = deriveSavedSecretImportResourceIdV1({ accountId: 'account-fixture',
      source: { kind: 'personal-saved-secret', secretId: migrated.id } });
    boundary.get.mockImplementation(async (url: string) => {
      if (url === 'https://captured.home/v1/account/encryption/currentness') return { status: 200, data: {
        mode: 'plain', version: 2, settingsVersion: 7, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      if (url === 'https://captured.home/v1/account/entity-rows/profiles/transfer') return { status: 200, data: { status: 'absent' } };
      if (url === 'https://captured.home/v1/account/entity-rows/prompt-library') return { status: 404, data: {} };
      if (url === 'https://captured.home/v2/account/settings/history') return { status: 200, data: { snapshots: [6, 5].map(version => ({
        version, contentKind: version === 6 ? 'plain' : 'encrypted', byteLength: 100, createdAt: '2026-01-01T00:00:00.000Z' })) } };
      if (url === 'https://captured.home/v2/account/settings/history/6') return { status: 200, data: {
        version: 6, content: recorded, createdAt: '2026-01-01T00:00:00.000Z' } };
      if (url === 'https://captured.home/v2/account/settings/history/5') return { status: 200, data: {
        version: 5, content: { t: 'encrypted', c: 'locked-fixture' }, createdAt: '2026-01-01T00:00:00.000Z' } };
      throw new Error(`Unexpected request ${url}`);
    });
    boundary.post.mockResolvedValue({ status: 200, data: { status: 'applied' } });
    const result = await normalizeCliAccountSettingsHistoryAfterTransfer({ credentials: { token: 'bearer-fixture', encryption: null },
      serverBaseUrl: 'https://captured.home', isCurrent: async () => true, destinationAuthority: { activeTransferredRoots: [],
        savedSecretTransfers: [{ savedSecretId: migrated.id, resourceId, expectedRevision: 1 }] } });
    expect(result).toEqual({ status: 'cleanup-pending', versions: [5, 6] });
    expect(boundary.post.mock.calls.map(([url, body]) => ({ url, body }))).toEqual([{
      url: 'https://captured.home/v2/account/settings/history/6/mutate', body: {
        expectedSettingsVersion: 7, expectedProfileTransferRevision: 'absent',
        expectedEncryptionCurrentness: { mode: 'plain', signingKeyFingerprint: null, contentKeyFingerprint: null },
        expectedContent: recorded, operation: { kind: 'normalize', removedRoots: [],
          savedSecretTransfers: [{ savedSecretId: migrated.id, resourceId, expectedRevision: 1 }],
          content: { t: 'plain', v: { secrets: [untransferred, unknown], futurePreference: { keep: true } } } },
      },
    }]);
  });
});
