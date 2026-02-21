import { afterEach, describe, expect, it, vi } from 'vitest';

import { resetScopedSessionDataKeyCacheForTests, resolveScopedSessionDataKey } from './resolveScopedSessionDataKey';

const runtimeFetchMock = vi.hoisted(() => vi.fn());

vi.mock('@/utils/system/runtimeFetch', () => ({
  runtimeFetch: (...args: unknown[]) => runtimeFetchMock(...args),
}));

const validSessionById = {
  id: 'session-1',
  seq: 1,
  createdAt: 1,
  updatedAt: 1,
  active: true,
  activeAt: 1,
  archivedAt: null,
  metadata: 'metadata',
  metadataVersion: 1,
  agentState: null,
  agentStateVersion: 0,
  pendingCount: 0,
  pendingVersion: 0,
  dataEncryptionKey: 'k1',
};

describe('resolveScopedSessionDataKey', () => {
  afterEach(() => {
    runtimeFetchMock.mockReset();
    resetScopedSessionDataKeyCacheForTests();
  });

  it('loads and decrypts the session data encryption key from a valid by-id response', async () => {
    runtimeFetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ session: validSessionById }),
    });
    const decrypt = vi.fn(async () => new Uint8Array([9, 9]));

    const key = await resolveScopedSessionDataKey({
      serverId: 's-id',
      serverUrl: 'https://server.example.test',
      token: 'token',
      sessionId: 'session-1',
      decryptEncryptionKey: decrypt,
    });

    expect(runtimeFetchMock).toHaveBeenCalledTimes(1);
    expect(decrypt).toHaveBeenCalledWith('k1');
    expect(key).toEqual(new Uint8Array([9, 9]));
  });

  it('returns null and does not call decryption for an invalid by-id shape', async () => {
    runtimeFetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ session: { id: 'session-1', dataEncryptionKey: 'k1' } }),
    });

    const decrypt = vi.fn(async () => new Uint8Array([9]));

    const key = await resolveScopedSessionDataKey({
      serverId: 's-id',
      serverUrl: 'https://server.example.test',
      token: 'token',
      sessionId: 'session-1',
      decryptEncryptionKey: decrypt,
      timeoutMs: 10,
    });

    expect(key).toBeNull();
    expect(decrypt).not.toHaveBeenCalled();
  });
});
