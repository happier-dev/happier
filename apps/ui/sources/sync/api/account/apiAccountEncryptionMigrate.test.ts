import { beforeEach, describe, expect, it, vi } from 'vitest';

import { HappyError } from '@/utils/errors/errors';

const mocks = vi.hoisted(() => {
  return {
    invalidateAccountEncryptionModeCache: vi.fn(),
    serverFetch: vi.fn(),
  };
});

vi.mock('@/sync/http/client', () => ({
  serverFetch: mocks.serverFetch,
}));

vi.mock('./apiAccountEncryptionMode', () => ({
  invalidateAccountEncryptionModeCache: mocks.invalidateAccountEncryptionModeCache,
}));

import { migrateAccountEncryptionMode } from './apiAccountEncryptionMigrate';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('migrateAccountEncryptionMode', () => {
  beforeEach(() => {
    mocks.invalidateAccountEncryptionModeCache.mockReset();
    mocks.serverFetch.mockReset();
  });

  it('invalidates cached account mode after a successful migration', async () => {
    mocks.serverFetch.mockResolvedValueOnce(
      jsonResponse({ success: true, mode: 'plain', settingsVersion: 1 }, 200),
    );

    await expect(
      migrateAccountEncryptionMode(
        { token: 't', encryption: { publicKey: 'pk', machineKey: 'mk' } } as any,
        {
          toMode: 'plain',
          expectedSettingsVersion: 0,
          settingsContent: { t: 'plain', v: {} },
          connectedServices: { action: 'assert_empty' },
          automations: { action: 'assert_empty' },
        } as any,
      ),
    ).resolves.toMatchObject({ success: true, mode: 'plain' });

    expect(mocks.invalidateAccountEncryptionModeCache).toHaveBeenCalledTimes(1);
  });

  it('surfaces restore_required as a typed error code', async () => {
    mocks.serverFetch.mockResolvedValueOnce(
      jsonResponse({ error: 'invalid-params', reason: 'restore_required' }, 400),
    );

    await expect(
      migrateAccountEncryptionMode(
        { token: 't', encryption: { publicKey: 'pk', machineKey: 'mk' } } as any,
        {
          toMode: 'e2ee',
          expectedSettingsVersion: 0,
          settingsContent: { t: 'encrypted', c: 'cipher' },
          connectedServices: { action: 'assert_empty' },
          automations: { action: 'assert_empty' },
          keyProof: { publicKey: 'pk', challenge: 'c', signature: 's' },
        } as any,
      ),
    ).rejects.toSatisfy((err: unknown) => {
      if (!(err instanceof HappyError)) return false;
      return (err as any).code === 'restore_required' && err.status === 400;
    });
  });
});
