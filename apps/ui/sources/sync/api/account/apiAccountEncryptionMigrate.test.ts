import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HappyError } from '@/utils/errors/errors';

import { isServerFetchConnectivityProbeRequest } from '@/dev/testkit/mocks/serverFetch';
import { getAccountEncryptionModeCacheRevision } from './apiAccountEncryptionMode';

const fetchBoundary = vi.fn<typeof fetch>();
let cacheRevision: number;

import {
  AccountEncryptionMigrateRequestSchema,
  migrateAccountEncryptionMode,
} from './apiAccountEncryptionMigrate';

const EMPTY_STORAGE_DIRECTIVES = {
  machines: { action: 'assert_empty' as const },
  todos: { action: 'assert_empty' as const },
  artifacts: { action: 'assert_empty' as const },
  sessions: { action: 'assert_empty' as const },
  reviewComments: { action: 'assert_empty' as const },
  sessionOrganization: { action: 'assert_empty' as const },
  pets: { action: 'assert_empty' as const },
};

const PLAIN_REQUEST = AccountEncryptionMigrateRequestSchema.parse({
  toMode: 'plain',
  expectedAccountVersion: 3,
  expectedSigningKeyFingerprint: 'aemk1_signing',
  expectedContentKeyFingerprint: 'aemk1_content',
  expectedSettingsVersion: 0,
  settingsContent: { t: 'plain', v: {} },
  connectedServices: { action: 'assert_empty' },
  automations: { action: 'assert_empty' },
  ...EMPTY_STORAGE_DIRECTIVES,
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('migrateAccountEncryptionMode', () => {
  beforeEach(async () => {
    fetchBoundary.mockReset();
    const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
    await upsertAndActivateServer({ serverUrl: 'https://migration.example.test' });
    cacheRevision = getAccountEncryptionModeCacheRevision();
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      if (isServerFetchConnectivityProbeRequest(input)) return Response.json({});
      return await fetchBoundary(input, init);
    });
  });

  afterEach(async () => {
    const { resetServerReachabilitySupervisors } = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
    await resetServerReachabilitySupervisors();
    const { stopAllEndpointSupervisorsForTests } = await import('@/sync/runtime/connectivity/endpointSupervisorPool');
    await stopAllEndpointSupervisorsForTests();
    vi.unstubAllGlobals();
  });

  it('invalidates cached account mode after a successful migration', async () => {
    fetchBoundary.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        mode: 'plain',
        accountVersion: 4,
        settingsVersion: 1,
      }, 200),
    );

    await expect(
      migrateAccountEncryptionMode(
        { token: 't' },
        PLAIN_REQUEST,
      ),
    ).resolves.toMatchObject({ success: true, mode: 'plain' });

    expect(getAccountEncryptionModeCacheRevision()).toBe(cacheRevision + 1);
  });

  it('retains committed authoring-memory rows through the canonical migration response adapter', async () => {
    const content = { t: 'plain' as const, v: 'profile-a' };
    const request = AccountEncryptionMigrateRequestSchema.parse({ ...PLAIN_REQUEST,
      authoringMemory: { items: [{ key: 'lastUsedProfile', expectedRevision: 3, content }] },
    });
    const result = { success: true, mode: 'plain', accountVersion: 4, settingsVersion: 1,
      authoringMemory: { rows: [{ key: 'lastUsedProfile', revision: 4, content }] },
    };
    fetchBoundary.mockResolvedValueOnce(jsonResponse(result));
    await expect(migrateAccountEncryptionMode({ token: 't' }, request)).resolves.toEqual(result);
    expect(JSON.parse(String(fetchBoundary.mock.calls[0]![1]?.body))).toEqual(request);
  });

  it('retries a lost response with byte-identical migration request bytes', async () => {
    const lostResponse = Object.assign(
      new Error('response was lost after the server committed'),
      { retryable: true },
    );
    fetchBoundary
      .mockImplementationOnce(async () => {
        expect(getAccountEncryptionModeCacheRevision()).toBe(cacheRevision);
        throw lostResponse;
      })
      .mockImplementationOnce(async () => {
        expect(getAccountEncryptionModeCacheRevision()).toBe(cacheRevision);
        return jsonResponse({
          success: true,
          mode: 'plain',
          accountVersion: 4,
          settingsVersion: 1,
        }, 200);
      });

    await expect(
      migrateAccountEncryptionMode({ token: 'migration-token' }, PLAIN_REQUEST),
    ).resolves.toEqual({
      success: true,
      mode: 'plain',
      accountVersion: 4,
      settingsVersion: 1,
    });

    expect(fetchBoundary).toHaveBeenCalledTimes(2);
    const firstRequest = fetchBoundary.mock.calls[0]?.[1];
    const secondRequest = fetchBoundary.mock.calls[1]?.[1];
    for (const [input, init] of fetchBoundary.mock.calls) {
      expect(String(input)).toBe('https://migration.example.test/v1/account/encryption/migrate');
      expect(init?.method).toBe('POST');
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer migration-token');
      expect(new Headers(init?.headers).get('Content-Type')).toBe('application/json');
    }
    expect(firstRequest?.body).toBe(JSON.stringify(PLAIN_REQUEST));
    expect(secondRequest?.body).toBe(firstRequest?.body);
    expect(getAccountEncryptionModeCacheRevision()).toBe(cacheRevision + 1);
  });

  it('performs one direct POST when the caller owns migration retries', async () => {
    const lostResponse = Object.assign(
      new Error('response was lost after the server committed'),
      { retryable: true },
    );
    fetchBoundary
      .mockRejectedValueOnce(lostResponse)
      .mockResolvedValueOnce(
        jsonResponse(
          { error: 'invalid-params', reason: 'account_version_conflict' },
          409,
        ),
      );

    await expect(
      migrateAccountEncryptionMode(
        { token: 'migration-token' },
        PLAIN_REQUEST,
        { retry: 'none' },
      ),
    ).rejects.toBe(lostResponse);

    expect(fetchBoundary).toHaveBeenCalledTimes(1);
    expect(fetchBoundary.mock.calls[0]?.[1]?.method).toBe('POST');
    expect(getAccountEncryptionModeCacheRevision()).toBe(cacheRevision);
  });

  it('rejects an incomplete success response without fabricating Account currentness', async () => {
    fetchBoundary.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        mode: 'plain',
        settingsVersion: 1,
      }, 200),
    );

    await expect(
      migrateAccountEncryptionMode(
        { token: 't' },
        PLAIN_REQUEST,
      ),
    ).rejects.toSatisfy((err: unknown) => {
      if (!(err instanceof HappyError)) return false;
      return err.code
        === 'account-encryption-migration-response-incompatible'
        && err.status === 200;
    });
    expect(getAccountEncryptionModeCacheRevision()).toBe(cacheRevision);
    expect(fetchBoundary).toHaveBeenCalledTimes(1);
  });

  it('submits the current migration without an older-server capability probe', async () => {
    fetchBoundary.mockResolvedValueOnce(jsonResponse({ success: true, mode: 'plain', accountVersion: 4, settingsVersion: 1 }));
    await expect(migrateAccountEncryptionMode({ token: 't' }, PLAIN_REQUEST)).resolves.toMatchObject({ success: true, mode: 'plain' });
    expect(fetchBoundary).toHaveBeenCalledTimes(1);
  });

  it('submits an E2EE migration through the same current transport', async () => {
    fetchBoundary.mockResolvedValueOnce(jsonResponse({ success: true, mode: 'e2ee', accountVersion: 4, settingsVersion: 1 }));
    await expect(
      migrateAccountEncryptionMode(
        { token: 't' },
        AccountEncryptionMigrateRequestSchema.parse({
          toMode: 'e2ee',
          expectedAccountVersion: 3,
          expectedSigningKeyFingerprint: 'aemk1_signing',
          expectedContentKeyFingerprint: 'aemk1_content',
          expectedSettingsVersion: 0,
          settingsContent: { t: 'encrypted', c: 'cipher' },
          connectedServices: { action: 'assert_empty' },
          automations: { action: 'assert_empty' },
          keyProof: {
            v: 1,
            publicKey: 'public-key',
            signature: 'request-signature',
            contentPublicKey: 'content-public-key',
            contentPublicKeySig: 'content-key-signature',
          },
          ...EMPTY_STORAGE_DIRECTIVES,
        }),
      ),
    ).resolves.toMatchObject({ success: true, mode: 'e2ee' });
    expect(fetchBoundary).toHaveBeenCalledTimes(1);
  });

  it('surfaces restore_required as a typed error code', async () => {
    fetchBoundary.mockResolvedValueOnce(
      jsonResponse({ error: 'invalid-params', reason: 'restore_required' }, 400),
    );

    await expect(
      migrateAccountEncryptionMode(
        { token: 't' },
        AccountEncryptionMigrateRequestSchema.parse({
          toMode: 'e2ee',
          expectedAccountVersion: 3,
          expectedSigningKeyFingerprint: 'aemk1_signing',
          expectedContentKeyFingerprint: 'aemk1_content',
          expectedSettingsVersion: 0,
          settingsContent: { t: 'encrypted', c: 'cipher' },
          connectedServices: { action: 'assert_empty' },
          automations: { action: 'assert_empty' },
          keyProof: {
            v: 1,
            publicKey: 'public-key',
            signature: 'request-signature',
            contentPublicKey: 'content-public-key',
            contentPublicKeySig: 'content-key-signature',
          },
          ...EMPTY_STORAGE_DIRECTIVES,
        }),
      ),
    ).rejects.toSatisfy((err: unknown) => {
      if (!(err instanceof HappyError)) return false;
      return err.code === 'restore_required' && err.status === 400;
    });
    expect(fetchBoundary).toHaveBeenCalledTimes(1);
  });

  it('surfaces metadata_privacy_upgrade_required as a typed error code', async () => {
    fetchBoundary.mockResolvedValueOnce(
      jsonResponse({ error: 'metadata_privacy_upgrade_required' }, 400),
    );

    await expect(
      migrateAccountEncryptionMode(
        { token: 't' },
        PLAIN_REQUEST,
      ),
    ).rejects.toSatisfy((err: unknown) => {
      if (!(err instanceof HappyError)) return false;
      return err.code === 'metadata_privacy_upgrade_required'
        && err.status === 400;
    });
    expect(fetchBoundary).toHaveBeenCalledTimes(1);
  });

});
