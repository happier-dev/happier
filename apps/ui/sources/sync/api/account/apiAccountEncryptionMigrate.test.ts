import { beforeEach, describe, expect, it, vi } from 'vitest';

import { HappyError } from '@/utils/errors/errors';

const mocks = vi.hoisted(() => {
  return {
    serverFetch: vi.fn(),
  };
});

vi.mock('@/sync/http/client', () => ({
  serverFetch: mocks.serverFetch,
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
    mocks.serverFetch.mockReset();
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
