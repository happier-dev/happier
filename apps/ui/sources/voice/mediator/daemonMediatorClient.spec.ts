import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/sync/apiSocket', () => ({
  apiSocket: {
    sessionRPC: vi.fn(),
  },
}));

describe('DaemonMediatorClient', () => {
  beforeEach(async () => {
    const { apiSocket } = await import('@/sync/apiSocket');
    vi.mocked(apiSocket.sessionRPC).mockReset();
  });

  it('throws RPC errors with rpcErrorCode for fallback handling', async () => {
    const { apiSocket } = await import('@/sync/apiSocket');
    vi.mocked(apiSocket.sessionRPC).mockResolvedValueOnce({
      error: 'unsupported',
      errorCode: 'VOICE_MEDIATOR_UNSUPPORTED',
    });

    const { DaemonMediatorClient } = await import('./daemonMediatorClient');
    const client = new DaemonMediatorClient();

    await expect(
      client.start({
        sessionId: 's1',
        agentSource: 'session',
        verbosity: 'short',
        chatModelId: 'fast',
        commitModelId: 'fast',
      permissionPolicy: 'read_only',
      idleTtlSeconds: 300,
      initialContext: 'ctx',
    }),
    ).rejects.toMatchObject({ message: 'unsupported', rpcErrorCode: 'VOICE_MEDIATOR_UNSUPPORTED' });
  });

  it('throws invalid_rpc_response for malformed start payloads', async () => {
    const { apiSocket } = await import('@/sync/apiSocket');
    vi.mocked(apiSocket.sessionRPC).mockResolvedValueOnce({ mediatorId: 123 });

    const { DaemonMediatorClient } = await import('./daemonMediatorClient');
    const client = new DaemonMediatorClient();

    await expect(
      client.start({
        sessionId: 's1',
        agentSource: 'session',
        verbosity: 'short',
        chatModelId: 'fast',
        commitModelId: 'fast',
        permissionPolicy: 'read_only',
        idleTtlSeconds: 300,
        initialContext: 'ctx',
      }),
    ).rejects.toThrow('invalid_rpc_response');
  });

  it('maps getModels response fields', async () => {
    const { apiSocket } = await import('@/sync/apiSocket');
    vi.mocked(apiSocket.sessionRPC).mockResolvedValueOnce({
      availableModels: [{ id: 'm1', name: 'Model 1' }],
      supportsFreeform: true,
    });

    const { DaemonMediatorClient } = await import('./daemonMediatorClient');
    const client = new DaemonMediatorClient();
    await expect(client.getModels({ sessionId: 's1' })).resolves.toEqual({
      availableModels: [{ id: 'm1', name: 'Model 1' }],
      supportsFreeform: true,
    });
  });
});
