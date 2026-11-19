import { beforeEach, describe, expect, it, vi } from 'vitest';
import { deriveSavedSecretImportResourceIdV1 } from '@happier-dev/protocol/account/settings/savedSecretMutationOwner';
import { normalizeCliAccountSettingsHistoryAfterTransfer } from './accountSettingsHistoryNormalization';
import { emptyAccountSettingsHistoryCaptureResponse } from './emptyAccountSettingsHistoryCapture.testkit';

const boundary = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
// HTTP is the boundary; orchestration, envelope opening and normalization stay real.
vi.mock('axios', () => ({ default: { get: boundary.get, post: boundary.post, isAxiosError: () => false } }));

describe('captured CLI Account Settings history normalization', () => {
  beforeEach(() => { boundary.get.mockReset(); boundary.post.mockReset(); });

  it('reuses completed history only after fresh head and destination capture, and rescans a changed head', async () => {
    let settingsVersion = 7;
    let eventVersion = 1;
    let detailReads = 0;
    let currentnessReads = 0;
    boundary.get.mockImplementation(async (url: string) => {
      const path = new URL(url).pathname;
      if (path === '/v1/account/encryption/currentness') {
        currentnessReads++;
        return { status: 200, data: { mode: 'plain', version: eventVersion++, settingsVersion,
          signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      }
      const capture = emptyAccountSettingsHistoryCaptureResponse(path);
      if (capture) return capture;
      if (path === '/v1/account/entity-rows/provider-connections') return { status: 404, data: {} };
      if (path === '/v2/account/settings/history') return { status: 200, data: { snapshots: [{ version: 6,
        contentKind: 'plain', byteLength: 20, createdAt: '2026-01-01T00:00:00.000Z' }] } };
      if (path === '/v2/account/settings/history/6') {
        detailReads++;
        return { status: 200, data: { version: 6, content: { t: 'plain', v: { preferredLanguage: 'de' } },
          createdAt: '2026-01-01T00:00:00.000Z' } };
      }
      throw new Error(`Unexpected request ${url}`);
    });
    const input = { credentials: { token: 'checkpoint-fixture', encryption: null }, serverBaseUrl: 'https://captured.home',
      isCurrent: async () => true, destinationAuthority: { activeTransferredRoots: [] } } satisfies Parameters<typeof normalizeCliAccountSettingsHistoryAfterTransfer>[0];
    expect(await normalizeCliAccountSettingsHistoryAfterTransfer(input)).toEqual({ status: 'complete' });
    expect(await normalizeCliAccountSettingsHistoryAfterTransfer({ ...input, serverBaseUrl: 'https://captured.home/' }))
      .toEqual({ status: 'complete' });
    expect(detailReads).toBe(1);
    expect(currentnessReads).toBe(2);
    settingsVersion++;
    expect(await normalizeCliAccountSettingsHistoryAfterTransfer(input)).toEqual({ status: 'complete' });
    expect(detailReads).toBe(2);
    expect(await normalizeCliAccountSettingsHistoryAfterTransfer({ ...input, serverBaseUrl: 'https://another.home' }))
      .toEqual({ status: 'complete' });
    expect(await normalizeCliAccountSettingsHistoryAfterTransfer({ ...input, credentials: { token: 'other-checkpoint-fixture', encryption: null } }))
      .toEqual({ status: 'complete' });
    expect(detailReads).toBe(4);
    input.credentials.token = 'rotated-checkpoint-fixture';
    expect(await normalizeCliAccountSettingsHistoryAfterTransfer(input)).toEqual({ status: 'complete' });
    expect(detailReads).toBe(5);
    expect(boundary.post).not.toHaveBeenCalled();
  });

  it('retries incomplete history and refuses a retired credential lifetime before reusing completion', async () => {
    let unavailable = true;
    let current = true;
    let detailReads = 0;
    boundary.get.mockImplementation(async (url: string) => {
      const path = new URL(url).pathname;
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: { mode: 'plain', version: 1,
        settingsVersion: 7, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      const capture = emptyAccountSettingsHistoryCaptureResponse(path);
      if (capture) return capture;
      if (path === '/v1/account/entity-rows/provider-connections') return { status: 404, data: {} };
      if (path === '/v2/account/settings/history') return { status: 200, data: { snapshots: [{ version: 6,
        contentKind: 'plain', byteLength: 20, createdAt: '2026-01-01T00:00:00.000Z' }] } };
      if (path === '/v2/account/settings/history/6') {
        detailReads++;
        return unavailable ? { status: 503, data: {} } : { status: 200, data: { version: 6,
          content: { t: 'plain', v: {} }, createdAt: '2026-01-01T00:00:00.000Z' } };
      }
      throw new Error(`Unexpected request ${url}`);
    });
    const input = { credentials: { token: 'pending-checkpoint-fixture', encryption: null }, serverBaseUrl: 'https://captured.home',
      isCurrent: async () => current, destinationAuthority: { activeTransferredRoots: [] } } satisfies Parameters<typeof normalizeCliAccountSettingsHistoryAfterTransfer>[0];
    expect(await normalizeCliAccountSettingsHistoryAfterTransfer(input)).toEqual({ status: 'cleanup-pending', versions: [6] });
    unavailable = false;
    expect(await normalizeCliAccountSettingsHistoryAfterTransfer(input)).toEqual({ status: 'complete' });
    expect(await normalizeCliAccountSettingsHistoryAfterTransfer(input)).toEqual({ status: 'complete' });
    expect(detailReads).toBe(2);
    current = false;
    await expect(normalizeCliAccountSettingsHistoryAfterTransfer(input)).rejects.toThrow();
    expect(detailReads).toBe(2);
  });

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
      const capture = emptyAccountSettingsHistoryCaptureResponse(new URL(url).pathname);
      if (capture) return capture;
      if (url === 'https://captured.home/v1/account/entity-rows/provider-connections') return { status: 404, data: {} };
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
