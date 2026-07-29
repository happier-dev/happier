import { agent, methods, PROTOCOL_VERSION, RequestError } from '@agentclientprotocol/sdk';
import { describe, expect, it } from 'vitest';

import { createAcpClientConnection } from '../createAcpClientConnection';
import { defineAcpExtensionNotification, defineAcpExtensionRequest } from '../types';

const stringValueParams = {
  parse(value: unknown): { value: string } {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('Expected object params');
    }
    const candidate = (value as Record<string, unknown>).value;
    if (typeof candidate !== 'string') throw new Error('Expected string value');
    return { value: candidate };
  },
};

describe('createAcpClientConnection', () => {
  it('uses one public app connection for standard requests and notifications', async () => {
    const updates: string[] = [];
    const testAgent = agent({ name: 'connection-test-agent' })
      .onRequest(methods.agent.initialize, () => ({
        protocolVersion: PROTOCOL_VERSION,
        agentCapabilities: {},
        authMethods: [],
      }))
      .onRequest(methods.agent.session.new, async (context) => {
        await context.client.notify(methods.client.session.update, {
          sessionId: 'session-1',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'ready' },
          },
        });
        return { sessionId: 'session-1' };
      })
      .onRequest(methods.agent.session.fork, (context) => ({
        sessionId: `${context.params.sessionId}-fork`,
      }));

    const connection = createAcpClientConnection({
      name: 'connection-test-client',
      transport: testAgent,
      handlers: {
        requestPermission: () => ({ outcome: { outcome: 'cancelled' } }),
        sessionUpdate: (notification) => {
          if (
            notification.update.sessionUpdate === 'agent_message_chunk'
            && notification.update.content.type === 'text'
          ) {
            updates.push(notification.update.content.text);
          }
        },
      },
    });

    try {
      await expect(connection.peer.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {},
      })).resolves.toMatchObject({ protocolVersion: PROTOCOL_VERSION });
      await expect(connection.peer.newSession({ cwd: '/workspace', mcpServers: [] }))
        .resolves.toEqual({ sessionId: 'session-1' });
      await expect(connection.peer.forkSession({
        sessionId: 'session-1',
        cwd: '/workspace',
        mcpServers: [],
      })).resolves.toEqual({ sessionId: 'session-1-fork' });
      expect(updates).toEqual(['ready']);
    } finally {
      connection.close();
      await connection.closed;
    }
  });

  it('registers bounded custom request and notification descriptors by direction', async () => {
    const observed: string[] = [];
    const testAgent = agent({ name: 'extension-test-agent' })
      .onRequest(methods.agent.session.prompt, async (context) => {
        const response = await context.client.request<{ echoed: string }>(
          'example/dual',
          { value: 'request' },
        );
        await context.client.notify('example/dual', { value: 'notification' });
        return { stopReason: 'end_turn', _meta: response };
      });

    const connection = createAcpClientConnection({
      name: 'extension-test-client',
      transport: testAgent,
      handlers: {
        requestPermission: () => ({ outcome: { outcome: 'cancelled' } }),
        sessionUpdate: () => {},
      },
      extensions: [
        defineAcpExtensionRequest({
          method: 'example/dual',
          params: stringValueParams,
          handler: (params) => ({ echoed: params.value }),
        }),
        defineAcpExtensionNotification({
          method: 'example/dual',
          params: stringValueParams,
          handler: (params) => { observed.push(params.value); },
        }),
      ],
    });

    try {
      await expect(connection.peer.prompt({
        sessionId: 'session-1',
        prompt: [{ type: 'text', text: 'go' }],
      })).resolves.toMatchObject({ _meta: { echoed: 'request' } });
      expect(observed).toEqual(['notification']);
    } finally {
      connection.close();
      await connection.closed;
    }
  });

  it('maps invalid custom params to JSON-RPC invalid params without invoking the handler', async () => {
    let calls = 0;
    const testAgent = agent({ name: 'invalid-params-agent' })
      .onRequest(methods.agent.session.prompt, async (context) => {
        try {
          await context.client.request('example/strict', { value: 42 });
          return { stopReason: 'end_turn', _meta: { code: 0 } };
        } catch (error) {
          return {
            stopReason: 'end_turn',
            _meta: { code: error instanceof RequestError ? error.code : null },
          };
        }
      });
    const connection = createAcpClientConnection({
      name: 'invalid-params-client',
      transport: testAgent,
      handlers: {
        requestPermission: () => ({ outcome: { outcome: 'cancelled' } }),
        sessionUpdate: () => {},
      },
      extensions: [defineAcpExtensionRequest({
        method: 'example/strict',
        params: stringValueParams,
        handler: () => { calls += 1; return {}; },
      })],
    });

    try {
      await expect(connection.peer.prompt({
        sessionId: 'session-1',
        prompt: [{ type: 'text', text: 'go' }],
      })).resolves.toMatchObject({ _meta: { code: -32602 } });
      expect(calls).toBe(0);
    } finally {
      connection.close();
      await connection.closed;
    }
  });

  it('closes deterministically and rejects requests after close', async () => {
    const connection = createAcpClientConnection({
      name: 'close-test-client',
      transport: agent({ name: 'close-test-agent' }),
      handlers: {
        requestPermission: () => ({ outcome: { outcome: 'cancelled' } }),
        sessionUpdate: () => {},
      },
    });

    connection.close();
    await connection.closed;
    await expect(connection.peer.requestExtension('example/after-close', {}))
      .rejects.toThrow(/connection is closed/i);
  });

  it('cancels an outgoing extension request from the caller signal', async () => {
    const testAgent = agent({ name: 'caller-cancel-agent' })
      .onRequest('example/wait', stringValueParams, async (context) => {
        await new Promise<void>((_resolve, reject) => {
          const rejectCancelled = (): void => reject(context.signal.reason);
          if (context.signal.aborted) rejectCancelled();
          else context.signal.addEventListener('abort', rejectCancelled, { once: true });
        });
        return { unreachable: true };
      });
    const connection = createAcpClientConnection({
      name: 'caller-cancel-client',
      transport: testAgent,
      handlers: {
        requestPermission: () => ({ outcome: { outcome: 'cancelled' } }),
        sessionUpdate: () => {},
      },
    });
    const caller = new AbortController();

    try {
      const request = connection.peer.requestExtension('example/wait', { value: 'caller' }, {
        signal: caller.signal,
      });
      caller.abort();
      await expect(request).rejects.toMatchObject({ name: 'AbortError' });
    } finally {
      connection.close();
      await connection.closed;
    }
  });

  it('rejects an in-flight extension request when the connection closes', async () => {
    let resolveRequestStarted: (() => void) | null = null;
    const requestStarted = new Promise<void>((resolve) => {
      resolveRequestStarted = resolve;
    });
    const testAgent = agent({ name: 'connection-close-agent' })
      .onRequest('example/wait', stringValueParams, async (context) => {
        resolveRequestStarted?.();
        await new Promise<void>((_resolve, reject) => {
          const rejectCancelled = (): void => reject(context.signal.reason);
          if (context.signal.aborted) rejectCancelled();
          else context.signal.addEventListener('abort', rejectCancelled, { once: true });
        });
        return { unreachable: true };
      });
    const connection = createAcpClientConnection({
      name: 'connection-close-client',
      transport: testAgent,
      handlers: {
        requestPermission: () => ({ outcome: { outcome: 'cancelled' } }),
        sessionUpdate: () => {},
      },
    });

    const request = connection.peer.requestExtension('example/wait', { value: 'close' });
    await requestStarted;
    connection.close();

    await expect(request).rejects.toBeDefined();
    await connection.closed;
  });

  it('bounds an outgoing extension request with a timeout without closing the connection', async () => {
    const testAgent = agent({ name: 'timeout-agent' })
      .onRequest('example/wait', stringValueParams, async (context) => {
        await new Promise<void>((_resolve, reject) => {
          const rejectCancelled = (): void => reject(context.signal.reason);
          if (context.signal.aborted) rejectCancelled();
          else context.signal.addEventListener('abort', rejectCancelled, { once: true });
        });
        return { unreachable: true };
      })
      .onRequest('example/ping', stringValueParams, (context) => ({ echoed: context.params.value }));
    const connection = createAcpClientConnection({
      name: 'timeout-client',
      transport: testAgent,
      handlers: {
        requestPermission: () => ({ outcome: { outcome: 'cancelled' } }),
        sessionUpdate: () => {},
      },
    });

    try {
      await expect(connection.peer.requestExtension('example/wait', { value: 'timeout' }, {
        timeoutMs: 10,
      })).rejects.toThrow(/timed out after 10ms/i);
      await expect(connection.peer.requestExtension('example/ping', { value: 'still-open' }))
        .resolves.toEqual({ echoed: 'still-open' });
    } finally {
      connection.close();
      await connection.closed;
    }
  });

  it('rejects duplicate extension registrations before connecting', () => {
    const duplicate = defineAcpExtensionNotification({
      method: 'example/duplicate',
      params: stringValueParams,
      handler: () => {},
    });

    expect(() => createAcpClientConnection({
      name: 'duplicate-client',
      transport: agent({ name: 'duplicate-agent' }),
      handlers: {
        requestPermission: () => ({ outcome: { outcome: 'cancelled' } }),
        sessionUpdate: () => {},
      },
      extensions: [duplicate, duplicate],
    })).toThrow(/duplicate ACP extension notification registration/i);
  });

  it('preserves bounded upstream diagnostic details on standard request failures', async () => {
    const connection = createAcpClientConnection({
      name: 'diagnostic-client',
      transport: agent({ name: 'diagnostic-agent' }).onRequest('session/load', async () => {
        throw RequestError.internalError({ details: 'No previous sessions found for this project.' });
      }),
      handlers: {
        requestPermission: () => ({ outcome: { outcome: 'cancelled' } }),
        sessionUpdate: () => {},
      },
    });

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

  it('redacts secrets and discards arbitrary upstream diagnostic data fields', async () => {
    const connection = createAcpClientConnection({
      name: 'redaction-client',
      transport: agent({ name: 'redaction-agent' }).onRequest('session/load', async () => {
        throw RequestError.internalError({
          details: 'Upstream rejected the request: token=provider-secret-value',
          token: 'provider-secret-value',
          nested: { authorization: 'Bearer nested-secret-value', repeated: 'x'.repeat(100_000) },
        });
      }),
      handlers: {
        requestPermission: () => ({ outcome: { outcome: 'cancelled' } }),
        sessionUpdate: () => {},
      },
    });

    try {
      const failure = await connection.peer.loadSession({
        sessionId: 'missing',
        cwd: '/tmp',
        mcpServers: [],
      }).catch((error: unknown) => error) as Error & { code?: number; data?: unknown };
      const serialized = JSON.stringify(failure.data);

      expect(failure.message).toContain('Upstream rejected the request');
      expect(failure.message).toContain('[REDACTED]');
      expect(failure.message).not.toContain('provider-secret-value');
      expect(serialized).not.toContain('provider-secret-value');
      expect(serialized).not.toContain('nested-secret-value');
      expect(failure.data).toMatchObject({ details: expect.stringContaining('[REDACTED]') });
      expect(failure.code).toBe(-32603);
      expect(serialized.length).toBeLessThan(20_000);
    } finally {
      connection.close();
      await connection.closed;
    }
  });
});
