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
  afterEach(async () => {
    runtimeFetchMock.mockReset();
    resetScopedSessionDataKeyCacheForTests();
    try {
      const { resetServerReachabilitySupervisors } = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
      await resetServerReachabilitySupervisors();
    } catch {
      // ignore
    }
  });

  it('loads and decrypts the session data encryption key from a valid by-id response', async () => {
    runtimeFetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : String(input);
      if (url.endsWith('/health') || url.endsWith('/v1/auth/ping')) {
        return { ok: true, status: 200, json: async () => ({}) };
      }
      return { ok: true, status: 200, json: async () => ({ session: validSessionById }) };
    });
    const decrypt = vi.fn(async () => new Uint8Array([9, 9]));

    const key = await resolveScopedSessionDataKey({
      serverId: 's-id',
      serverUrl: 'https://server.example.test',
      token: 'token',
      sessionId: 'session-1',
      decryptEncryptionKey: decrypt,
    });

    expect(runtimeFetchMock.mock.calls.some(([input]) => String(input).includes('/v2/sessions/session-1'))).toBe(true);
    expect(decrypt).toHaveBeenCalledWith('k1');
    expect(key).toEqual(new Uint8Array([9, 9]));
  });

  it('returns null and does not call decryption for an invalid by-id shape', async () => {
    runtimeFetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : String(input);
      if (url.endsWith('/health') || url.endsWith('/v1/auth/ping')) {
        return { ok: true, status: 200, json: async () => ({}) };
      }
      return { ok: true, status: 200, json: async () => ({ session: { id: 'session-1', dataEncryptionKey: 'k1' } }) };
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

  it('does not cache transient failures', async () => {
    runtimeFetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : String(input);
      if (url.endsWith('/health') || url.endsWith('/v1/auth/ping')) {
        return { ok: true, status: 200, json: async () => ({}) };
      }
      return { ok: false, status: 500, json: async () => ({}) };
    });
    const decrypt = vi.fn(async () => new Uint8Array([9]));

    const first = await resolveScopedSessionDataKey({
      serverId: 's-id',
      serverUrl: 'https://server.example.test',
      token: 'token',
      sessionId: 'session-1',
      decryptEncryptionKey: decrypt,
      timeoutMs: 10,
    });
    const second = await resolveScopedSessionDataKey({
      serverId: 's-id',
      serverUrl: 'https://server.example.test',
      token: 'token',
      sessionId: 'session-1',
      decryptEncryptionKey: decrypt,
      timeoutMs: 10,
    });

    expect(first).toBeNull();
    expect(second).toBeNull();
    expect(decrypt).not.toHaveBeenCalled();
    expect(runtimeFetchMock.mock.calls.filter(([input]) => String(input).includes('/v2/sessions/session-1')).length).toBe(2);
  });

  it('throws terminal auth instead of returning an unknown key for scoped 401 responses', async () => {
    runtimeFetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : String(input);
      if (url.endsWith('/health') || url.endsWith('/v1/auth/ping')) {
        return { ok: true, status: 200, json: async () => ({}) };
      }
      return { ok: false, status: 401, json: async () => ({}) };
    });
    const decrypt = vi.fn(async () => new Uint8Array([9]));

    await expect(resolveScopedSessionDataKey({
      serverId: 's-id',
      serverUrl: 'https://server.example.test',
      token: 'token',
      sessionId: 'session-1',
      decryptEncryptionKey: decrypt,
      timeoutMs: 10,
    })).rejects.toMatchObject({
      name: 'HappyError',
      kind: 'auth',
      code: 'not_authenticated',
    });

    expect(decrypt).not.toHaveBeenCalled();
  });
});
