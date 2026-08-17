import { beforeEach, describe, expect, it, vi } from 'vitest';

import { HappyError } from '@/utils/errors/errors';

vi.mock('@/utils/timing/time', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/timing/time')>();
  return {
    ...actual,
    backoff: actual.createBackoff({
      minDelay: 0,
      maxDelay: 0,
      maxFailureCount: 2,
    }),
  };
});

const mocks = vi.hoisted(() => {
  return {
    invalidateAccountEncryptionModeCache: vi.fn(),
    getServerFeaturesSnapshot: vi.fn(),
    serverFetch: vi.fn(),
  };
});

vi.mock('@/sync/http/client', () => ({
  serverFetch: mocks.serverFetch,
}));

vi.mock('@/sync/api/capabilities/serverFeaturesClient', () => ({
  getServerFeaturesSnapshot: mocks.getServerFeaturesSnapshot,
}));

vi.mock('./apiAccountEncryptionMode', () => ({
  invalidateAccountEncryptionModeCache: mocks.invalidateAccountEncryptionModeCache,
}));

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
  beforeEach(() => {
    mocks.invalidateAccountEncryptionModeCache.mockReset();
    mocks.getServerFeaturesSnapshot.mockReset();
    mocks.serverFetch.mockReset();
    mocks.getServerFeaturesSnapshot.mockResolvedValue({
      status: 'ready',
      features: {
        capabilities: {
          accountStoredContentCompatibility: {
            v: 1,
            minimumProtocolVersion: 2,
            currentProtocolVersion: 3,
            declarationTransport: 'http-header-and-socket-auth-v1',
          },
        },
      },
    });
  });

  it('invalidates cached account mode after a successful migration', async () => {
    mocks.serverFetch.mockResolvedValueOnce(
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

    expect(mocks.invalidateAccountEncryptionModeCache).toHaveBeenCalledTimes(1);
  });

  it('retries a lost response with byte-identical migration request bytes', async () => {
    const lostResponse = Object.assign(
      new Error('response was lost after the server committed'),
      { retryable: true },
    );
    mocks.serverFetch
      .mockImplementationOnce(async () => {
        expect(
          mocks.invalidateAccountEncryptionModeCache,
        ).not.toHaveBeenCalled();
        throw lostResponse;
      })
      .mockImplementationOnce(async () => {
        expect(
          mocks.invalidateAccountEncryptionModeCache,
        ).not.toHaveBeenCalled();
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

    expect(mocks.serverFetch).toHaveBeenCalledTimes(2);
    const firstRequest = mocks.serverFetch.mock.calls[0]?.[1];
    const secondRequest = mocks.serverFetch.mock.calls[1]?.[1];
    expect(firstRequest).toEqual({
      method: 'POST',
      headers: {
        Authorization: 'Bearer migration-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(PLAIN_REQUEST),
    });
    expect(secondRequest).toEqual(firstRequest);
    expect(secondRequest?.body).toBe(firstRequest?.body);
    expect(mocks.serverFetch.mock.calls[0]?.[2]).toEqual({
      includeAuth: false,
    });
    expect(mocks.serverFetch.mock.calls[1]?.[2]).toEqual({
      includeAuth: false,
    });
    expect(mocks.invalidateAccountEncryptionModeCache).toHaveBeenCalledTimes(1);
  });

  it('performs one direct POST when the caller owns migration retries', async () => {
    const lostResponse = Object.assign(
      new Error('response was lost after the server committed'),
      { retryable: true },
    );
    mocks.serverFetch
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

    expect(mocks.serverFetch).toHaveBeenCalledTimes(1);
    expect(mocks.serverFetch.mock.calls[0]?.[2]).toEqual({
      includeAuth: false,
      retry: 'none',
    });
    expect(
      mocks.invalidateAccountEncryptionModeCache,
    ).not.toHaveBeenCalled();
  });

  it('rejects a predecessor success response without fabricating Account currentness', async () => {
    mocks.serverFetch.mockResolvedValueOnce(
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
    expect(
      mocks.invalidateAccountEncryptionModeCache,
    ).not.toHaveBeenCalled();
    expect(mocks.serverFetch).toHaveBeenCalledTimes(1);
  });

  it('refuses a marker-producing migration before POST against an immutable old-server capability snapshot', async () => {
    mocks.getServerFeaturesSnapshot.mockResolvedValue({
      status: 'ready',
      features: {
        capabilities: {
          encryption: {
            storagePolicy: 'optional',
          },
        },
      },
    });

    await expect(
      migrateAccountEncryptionMode({ token: 't' }, PLAIN_REQUEST),
    ).rejects.toMatchObject({
      code: 'client-upgrade-required',
      retryable: false,
    });
    expect(mocks.serverFetch).not.toHaveBeenCalled();
  });

  it('refuses the expanded migration before POST when the server only declares protocol v1', async () => {
    mocks.getServerFeaturesSnapshot.mockResolvedValue({
      status: 'ready',
      features: {
        capabilities: {
          accountStoredContentCompatibility: {
            v: 1,
            minimumProtocolVersion: 1,
            currentProtocolVersion: 1,
            declarationTransport: 'http-header-and-socket-auth-v1',
          },
        },
      },
    });

    await expect(
      migrateAccountEncryptionMode({ token: 't' }, PLAIN_REQUEST),
    ).rejects.toMatchObject({
      code: 'client-upgrade-required',
      retryable: false,
    });
    expect(mocks.serverFetch).not.toHaveBeenCalled();
  });

  it('refuses an E2EE migration before POST against an immutable old-server capability snapshot', async () => {
    mocks.getServerFeaturesSnapshot.mockResolvedValue({
      status: 'ready',
      features: {
        capabilities: {
          encryption: {
            storagePolicy: 'optional',
          },
        },
      },
    });

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
    ).rejects.toMatchObject({
      code: 'client-upgrade-required',
      retryable: false,
    });
    expect(mocks.serverFetch).not.toHaveBeenCalled();
  });

  it('surfaces restore_required as a typed error code', async () => {
    mocks.serverFetch.mockResolvedValueOnce(
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
    expect(mocks.serverFetch).toHaveBeenCalledTimes(1);
  });

  it('surfaces metadata_privacy_upgrade_required as a typed error code', async () => {
    mocks.serverFetch.mockResolvedValueOnce(
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
    expect(mocks.serverFetch).toHaveBeenCalledTimes(1);
  });

});
