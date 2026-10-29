import { agent, methods, RequestError, type ClientContext } from '@agentclientprotocol/sdk';
import { describe, expect, it } from 'vitest';

import { createAcpClientConnection } from '../createAcpClientConnection';
import { AcpAgentPeer } from '../AcpAgentPeer';

const objectParams = { parse: (value: unknown) => value };

function createConnection(testAgent: ReturnType<typeof agent>) {
  return createAcpClientConnection({
    name: 'peer-test-client',
    transport: testAgent,
    handlers: {
      requestPermission: () => ({ outcome: { outcome: 'cancelled' } }),
      sessionUpdate: () => {},
    },
  });
}

describe('AcpAgentPeer', () => {
  it('preserves non-extensible SDK transport errors without a provider classifier', async () => {
    const failure = Object.preventExtensions(new Error('SDK transport unavailable'));
    const context = { request: async () => { throw failure; } } satisfies Pick<ClientContext, 'request'>;
    // SDK boundary fixture: this outgoing operation uses only request; unrelated SDK session builders are absent.
    const peer = new AcpAgentPeer(methods, context as unknown as ClientContext, new AbortController().signal);
    await expect(peer.loadSession({ sessionId: 'missing', cwd: '/tmp', mcpServers: [] }))
      .rejects.toBe(failure);
    expect(failure).not.toHaveProperty('authenticationSetupFailure');
  });

  it('owns the standard ACP list, close, and delete session methods', async () => {
    const observed: string[] = [];
    const testAgent = agent({ name: 'peer-session-controls-agent' })
      .onRequest('session/list', () => { observed.push('list'); return { sessions: [], nextCursor: null }; })
      .onRequest('session/close', () => { observed.push('close'); return {}; })
      .onRequest('session/delete', () => { observed.push('delete'); return {}; });
    const connection = await createConnection(testAgent);
    try {
      await connection.peer.listSessions({ cwd: '/tmp' });
      await connection.peer.closeSession({ sessionId: 'session-1' });
      await connection.peer.deleteSession({ sessionId: 'session-1' });
      expect(observed).toEqual(['list', 'close', 'delete']);
    } finally {
      connection.close();
      await connection.closed;
    }
  });

  it('cancels an outgoing extension request and rejects promptly when its signal aborts', async () => {
    let observedCancellation = false;
    let resolveStarted: (() => void) | null = null;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    const testAgent = agent({ name: 'peer-abort-test-agent' })
      .onRequest('example/slow', objectParams, async (context) => {
        resolveStarted?.();
        await new Promise<void>((_resolve, reject) => {
          context.signal.addEventListener('abort', () => {
            observedCancellation = true;
            reject(RequestError.requestCancelled());
          }, { once: true });
        });
        return {};
      });
    const connection = await createConnection(testAgent);
    const controller = new AbortController();

    try {
      const request = connection.peer.requestExtension(
        'example/slow',
        {},
        { signal: controller.signal },
      );
      await started;
      controller.abort(new Error('caller cancelled'));

      await expect(request).rejects.toMatchObject({ name: 'AbortError' });
      expect(observedCancellation).toBe(true);
    } finally {
      connection.close();
      await connection.closed;
    }
  });

  it('times out an outgoing extension request without leaving it active', async () => {
    let observedCancellation = false;
    const testAgent = agent({ name: 'peer-timeout-test-agent' })
      .onRequest('example/slow', objectParams, async (context) => {
        await new Promise<void>((_resolve, reject) => {
          context.signal.addEventListener('abort', () => {
            observedCancellation = true;
            reject(RequestError.requestCancelled());
          }, { once: true });
        });
        return {};
      });
    const connection = await createConnection(testAgent);

    try {
      await expect(connection.peer.requestExtension(
        'example/slow',
        {},
        { timeoutMs: 25 },
      )).rejects.toThrow(/timed out/i);
      expect(observedCancellation).toBe(true);
    } finally {
      connection.close();
      await connection.closed;
    }
  });

  it('rejects new requests after the connection is disposed', async () => {
    const connection = await createConnection(agent({ name: 'peer-dispose-test-agent' }));
    connection.close();
    await connection.closed;

    await expect(connection.peer.requestExtension('example/after-close', {}))
      .rejects.toThrow(/connection is closed/i);
  });

  it('rejects and cancels an in-flight extension request when the connection closes', async () => {
    let observedCancellation = false;
    let resolveStarted: (() => void) | null = null;
    const started = new Promise<void>((resolve) => { resolveStarted = resolve; });
    const connection = await createConnection(agent({ name: 'peer-close-test-agent' })
      .onRequest('example/slow', objectParams, async (context) => {
        resolveStarted?.();
        await new Promise<void>((_resolve, reject) => {
          context.signal.addEventListener('abort', () => {
            observedCancellation = true;
            reject(RequestError.requestCancelled());
          }, { once: true });
        });
        return {};
      }));

    const request = connection.peer.requestExtension('example/slow', {});
    await started;
    connection.close(new Error('test connection close'));

    await expect(request).rejects.toThrow();
    await connection.closed;
    expect(observedCancellation).toBe(true);
  });

  it('preserves bounded upstream diagnostic details on standard request failures', async () => {
    const testAgent = agent({ name: 'peer-error-details-agent' })
      .onRequest('session/load', async () => {
        throw RequestError.internalError({ details: 'No previous sessions found for this project.' });
      });
    const connection = await createConnection(testAgent);

    try {
      await expect(connection.peer.loadSession({
        sessionId: 'missing',
        cwd: '/tmp',
        mcpServers: [],
      })).rejects.toThrow(/No previous sessions found for this project/);
    } finally {
      connection.close();
      await connection.closed;
    }
  });

  it('redacts secrets from upstream diagnostic details before surfacing them', async () => {
    const testAgent = agent({ name: 'peer-secret-details-agent' })
      .onRequest('session/load', async () => {
        throw RequestError.internalError({
          details: 'Upstream rejected the request: token=provider-secret-value trace=trace-123',
        });
      });
    const connection = await createConnection(testAgent);

    try {
      const failure = await connection.peer.loadSession({
        sessionId: 'missing',
        cwd: '/tmp',
        mcpServers: [],
      }).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain('Upstream rejected the request');
      expect((failure as Error).message).toContain('[REDACTED]');
      expect((failure as Error).message).not.toContain('provider-secret-value');
      expect(JSON.stringify((failure as Error & { data?: unknown }).data))
        .not.toContain('provider-secret-value');
      expect((failure as Error).stack ?? '').not.toContain('provider-secret-value');
    } finally {
      connection.close();
      await connection.closed;
    }
  });

  it('redacts and bounds every upstream diagnostic data field before surfacing it', async () => {
    const testAgent = agent({ name: 'peer-secret-data-agent' })
      .onRequest('session/load', async () => {
        throw RequestError.internalError({
          details: 'Provider request failed',
          token: 'provider-secret-value',
          nested: {
            authorization: 'Bearer nested-secret-value',
            repeated: 'x'.repeat(100_000),
          },
        });
      });
    const connection = await createConnection(testAgent);

    try {
      const failure = await connection.peer.loadSession({
        sessionId: 'missing',
        cwd: '/tmp',
        mcpServers: [],
      }).catch((error: unknown) => error);
      const serializedData = JSON.stringify((failure as Error & { data?: unknown }).data);

      expect(serializedData).not.toContain('provider-secret-value');
      expect(serializedData).not.toContain('nested-secret-value');
      expect((failure as Error & { data?: unknown }).data).toEqual({
        details: 'Provider request failed',
      });
      expect(failure).toMatchObject({ code: -32603 });
      expect((failure as Error).message).toContain('Provider request failed');
      expect(serializedData.length).toBeLessThan(20_000);
    } finally {
      connection.close();
      await connection.closed;
    }
  });
});
