import { describe, expect, it } from 'vitest';

import { AcpBackend } from '../AcpBackend';

describe('AcpBackend forkSession', () => {
  it('calls ACP unstable_forkSession and returns the new session id', async () => {
    const backend = new AcpBackend({
      agentName: 'test',
      cwd: '/test/cwd',
      command: 'noop',
    });

    const captured: any[] = [];
    const connection: any = {};
    connection.unstable_forkSession = async function unstable_forkSession(req: unknown) {
      if (this !== connection) {
        throw new Error('unstable_forkSession called with wrong this');
      }
      captured.push(req);
      return { sessionId: 'sess_child' };
    };
    (backend as any).connection = connection;

    const res = await (backend as any).forkSession({ sessionId: 'sess_parent' });
    expect(res).toEqual({ sessionId: 'sess_child' });
    expect((backend as any).acpSessionId).toBe('sess_child');
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({ sessionId: 'sess_parent', cwd: '/test/cwd' });
  });

  it('throws when the agent does not support session/fork', async () => {
    const backend = new AcpBackend({
      agentName: 'test',
      cwd: '/test/cwd',
      command: 'noop',
    });

    (backend as any).connection = {};

    await expect((backend as any).forkSession({ sessionId: 'sess_parent' })).rejects.toThrow(/does not support ACP session\/fork/i);
  });

  it('throws when the session id is empty', async () => {
    const backend = new AcpBackend({
      agentName: 'test',
      cwd: '/test/cwd',
      command: 'noop',
    });

    await expect((backend as any).forkSession({ sessionId: '   ' })).rejects.toThrow(/Session ID is required/);
  });
});
