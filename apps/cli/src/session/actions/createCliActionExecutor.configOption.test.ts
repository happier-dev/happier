import { describe, expect, it, vi } from 'vitest';
import type { Credentials } from '@/persistence';
import { decodeBase64, decrypt, encodeBase64, encrypt } from '@/api/encryption';
import { createApiSessionSocketStub, resolveApiSessionSocketDefaultAck } from '@/testkit/backends/apiSessionSocketHarness';
import { createCliActionExecutorFromCredentials } from './createCliActionExecutorFromCredentials';

const boundary = vi.hoisted(() => ({
  fetchSessionById: vi.fn(),
  socket: null as ReturnType<typeof createApiSessionSocketStub> | null,
}));

vi.mock('@/session/transport/http/sessionsHttp', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/session/transport/http/sessionsHttp')>(),
  fetchSessionById: boundary.fetchSessionById,
}));
vi.mock('@/api/session/sockets', () => ({
  createSessionScopedSocket: () => boundary.socket,
}));

describe('CLI live config Action (real metadata control plane)', () => {
  it.each(['plain', 'e2ee'] as const)('writes the canonical override through %s transport', async (mode) => {
    const key = new Uint8Array(32).fill(7);
    const credentials: Credentials = { token: 'test-token', encryption: { type: 'legacy', secret: key } };
    const sessionId = 'c123456789012345678901234';
    const metadata = { path: '/tmp/project', host: 'localhost' };
    boundary.fetchSessionById.mockResolvedValue({
      id: sessionId, active: true, encryptionMode: mode, metadataVersion: 1,
      metadata: mode === 'plain' ? JSON.stringify(metadata) : encodeBase64(encrypt(key, 'legacy', metadata)),
    });
    const socket = createApiSessionSocketStub({
      connected: true,
      emit: (event, args) => {
        const callback = args.at(-1);
        if (typeof callback === 'function') callback(resolveApiSessionSocketDefaultAck(event, args[0]));
      },
    });
    boundary.socket = socket;
    const result = await createCliActionExecutorFromCredentials({ credentials, processEnv: {} }).execute(
      'session.config_option.set',
      { sessionId, configId: ' effort ', valueId: ' high ' },
      { surface: 'session_agent', defaultSessionId: sessionId },
    );
    expect(result).toMatchObject({ ok: true, result: { ok: true, sessionId, configId: ' effort ', valueId: ' high ' } });
    const writes = socket.emit.mock.calls.filter(([event]) => event === 'update-metadata');
    expect(writes).toHaveLength(1);
    const payload: unknown = writes[0]?.[1];
    if (!payload || typeof payload !== 'object' || !('metadata' in payload) || typeof payload.metadata !== 'string') {
      throw new Error('Missing metadata transport payload');
    }
    const written: unknown = mode === 'plain' ? JSON.parse(payload.metadata) : decrypt(key, 'legacy', decodeBase64(payload.metadata));
    expect(written).toMatchObject({
      ...metadata,
      sessionConfigOptionOverridesV1: { overrides: { ' effort ': { value: ' high ' } } },
      acpConfigOptionOverridesV1: { overrides: { ' effort ': { value: ' high ' } } },
    });
    expect(socket.disconnect).toHaveBeenCalled();
    expect(socket.close).toHaveBeenCalled();
  });
});
