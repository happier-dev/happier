import { describe, expect, it, vi } from 'vitest';

import { AcpBackend } from '../AcpBackend';

function backendWithPeer(input: Readonly<{
  capabilities?: Readonly<{
    listSessions?: boolean;
    closeSession?: boolean;
    deleteSession?: boolean;
  }>;
  peer: Record<string, unknown>;
}>): AcpBackend {
  const backend = new AcpBackend({
    agentName: 'test',
    cwd: '/workspace',
    command: 'noop',
  });
  (backend as any).connection = { peer: input.peer };
  (backend as any).negotiatedSessionCapabilities = Object.freeze({
    loadSession: false,
    listSessions: input.capabilities?.listSessions === true,
    forkSession: false,
    closeSession: input.capabilities?.closeSession === true,
    deleteSession: input.capabilities?.deleteSession === true,
  });
  return backend;
}

describe('AcpBackend negotiated session lifecycle', () => {
  it('reports unsupported fork when the connection has no peer', async () => {
    const backend = new AcpBackend({ agentName: 'test', cwd: '/workspace', command: 'noop' });
    Reflect.set(backend, 'connection', { close: () => {}, closed: Promise.resolve() });
    await expect(backend.forkSession({ sessionId: 'source-session' }))
      .rejects.toThrow('test does not support ACP session/fork');
  });

  it('lists through the standard peer method with cwd and cursor unchanged', async () => {
    const listSessions = vi.fn(async () => ({
      sessions: [{
        sessionId: ' session\nid ',
        cwd: '/workspace/project',
        title: 'Project',
        updatedAt: '2026-09-13T08:30:00.000Z',
      }],
      nextCursor: ' cursor\n2 ',
    }));
    const backend = backendWithPeer({
      capabilities: { listSessions: true },
      peer: { listSessions },
    });

    await expect(backend.listSessions({ cwd: '/workspace/project', cursor: ' cursor\n1 ' }))
      .resolves.toEqual({
        sessions: [{
          sessionId: ' session\nid ',
          cwd: '/workspace/project',
          title: 'Project',
          updatedAt: '2026-09-13T08:30:00.000Z',
        }],
        nextCursor: ' cursor\n2 ',
      });
    expect(listSessions).toHaveBeenCalledWith({
      cwd: '/workspace/project',
      cursor: ' cursor\n1 ',
    });
  });

  it('defaults the listing filter to its own workspace but sends no filter for an explicit null', async () => {
    const listSessions = vi.fn(async () => ({ sessions: [], nextCursor: null }));
    const backend = backendWithPeer({
      capabilities: { listSessions: true },
      peer: { listSessions },
    });

    await backend.listSessions();
    expect(listSessions).toHaveBeenLastCalledWith({ cwd: '/workspace' });

    await backend.listSessions({ cwd: null, cursor: ' cursor\n1 ' });
    // `cwd` filters the Agent's sessions, so a caller that owns no workspace must
    // be able to ask for all of them rather than inherit an unrelated directory.
    expect(listSessions).toHaveBeenLastCalledWith({ cursor: ' cursor\n1 ' });
  });

  it.each([
    ['closeSession', 'closeSession'],
    ['deleteSession', 'deleteSession'],
  ] as const)('sends the exact opaque id through negotiated %s', async (method, capability) => {
    const operation = vi.fn(async () => ({}));
    const backend = backendWithPeer({
      capabilities: { [capability]: true },
      peer: { [method]: operation },
    });

    await expect(backend[method](' session\nid ')).resolves.toBeUndefined();
    expect(operation).toHaveBeenCalledWith({ sessionId: ' session\nid ' });
  });

  it.each([
    ['listSessions', (): unknown => ({})],
    ['closeSession', (): unknown => 'session-id'],
    ['deleteSession', (): unknown => 'session-id'],
  ] as const)('refuses %s before invoking an unnegotiated peer method', async (method, buildArgument) => {
    const operation = vi.fn(async () => ({}));
    const backend = backendWithPeer({ peer: { [method]: operation } });

    const argument = buildArgument();
    await expect((backend[method] as (value: unknown) => Promise<unknown>)(argument))
      .rejects.toThrow(/did not negotiate ACP session\/(?:list|close|delete) support during initialize/);
    expect(operation).not.toHaveBeenCalled();
  });

  it('re-enters an adopted held Session without the Agent negotiating session/load', async () => {
    // The adopt contract answers the held Session's load from the stored handshake.
    // Only a fresh Agent without load support is refused.
    const outcomes = await Promise.all([false, true].map(async (adopted) => {
      const loadSession = vi.fn(async () => ({}));
      const backend = backendWithPeer({ peer: { loadSession } });
      (backend as any).sessionHolderAdoption = adopted ? { adopted: Promise.resolve(true) } : null;
      const load = (backend as any).loadSessionOnCurrentConnection('acp-held-1', 1_000) as Promise<unknown>;
      return await load.then(() => loadSession.mock.calls.length, () => 'refused' as const);
    }));
    expect(outcomes).toEqual(['refused', 1]);
  });

  it.each(['closeSession', 'deleteSession'] as const)('rejects a blank id before %s', async (method) => {
    const operation = vi.fn(async () => ({}));
    const backend = backendWithPeer({
      capabilities: { [method]: true },
      peer: { [method]: operation },
    });

    await expect(backend[method]('   ')).rejects.toThrow(/Session ID is required/);
    expect(operation).not.toHaveBeenCalled();
  });
});
