import { agent, methods, PROTOCOL_VERSION, RequestError } from '@agentclientprotocol/sdk';
import { describe, expect, it } from 'vitest';

import { createAcpClientConnection } from '../createAcpClientConnection';
import {
  defineAcpExtensionNotification,
  defineAcpExtensionRequest,
} from '../types';

const objectWithStringValue = {
  parse(value: unknown): { value: string } {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('Expected object params');
    }
    const candidate = (value as Record<string, unknown>).value;
    if (typeof candidate !== 'string') {
      throw new Error('Expected string value');
    }
    return { value: candidate };
  },
};

describe('createAcpClientConnection', () => {
  it('uses the public app API for a long-lived standard ACP connection', async () => {
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
      });

    const connection = await createAcpClientConnection({
      name: 'connection-test-client',
      transport: testAgent,
      handlers: {
        requestPermission: () => ({ outcome: { outcome: 'cancelled' } }),
        sessionUpdate: (notification) => {
          const update = notification.update;
          if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
            updates.push(update.content.text);
          }
        },
      },
    });

    try {
      const initialized = await connection.peer.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      const session = await connection.peer.newSession({ cwd: '/workspace', mcpServers: [] });

      expect(initialized.protocolVersion).toBe(PROTOCOL_VERSION);
      expect(session.sessionId).toBe('session-1');
      expect(updates).toEqual(['ready']);
    } finally {
      connection.close();
      await connection.closed;
    }
  });

  it('registers bounded custom request and notification descriptors independently', async () => {
    const notifications: string[] = [];
    const contexts: Array<{ agentName: string; method: string }> = [];
    const testAgent = agent({ name: 'extension-test-agent' })
      .onRequest(methods.agent.session.prompt, async (context) => {
        const requestResult = await context.client.request<{ echoed: string }>(
          'example/dual',
          { value: 'request' },
        );
        await context.client.notify('example/dual', { value: 'notification' });
        return { stopReason: 'end_turn', _meta: requestResult };
      });

    const connection = await createAcpClientConnection({
      name: 'extension-test-client',
      transport: testAgent,
      handlers: {
        requestPermission: () => ({ outcome: { outcome: 'cancelled' } }),
        sessionUpdate: () => {},
      },
      extensions: [
        defineAcpExtensionRequest({
          method: 'example/dual',
          params: objectWithStringValue,
          handler: (params, context) => {
            contexts.push({ agentName: context.agentName, method: context.method });
            return { echoed: params.value };
          },
        }),
        defineAcpExtensionNotification({
          method: 'example/dual',
          params: objectWithStringValue,
          handler: (params, context) => {
            contexts.push({ agentName: context.agentName, method: context.method });
            notifications.push(params.value);
          },
        }),
      ],
      createExtensionContext: (method, signal) => ({
        method,
        signal,
        sessionId: 'session-1',
        agentName: 'extension-test-agent',
      }),
    });

    try {
      const response = await connection.peer.prompt({
        sessionId: 'session-1',
        prompt: [{ type: 'text', text: 'go' }],
      });
      expect(response._meta).toEqual({ echoed: 'request' });
      expect(notifications).toEqual(['notification']);
      expect(contexts).toEqual([
        { agentName: 'extension-test-agent', method: 'example/dual' },
        { agentName: 'extension-test-agent', method: 'example/dual' },
      ]);
    } finally {
      connection.close();
      await connection.closed;
    }
  });

  it('returns invalid params before invoking a custom request handler', async () => {
    let handlerCalls = 0;
    const testAgent = agent({ name: 'invalid-params-test-agent' })
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
    const connection = await createAcpClientConnection({
      name: 'invalid-params-test-client',
      transport: testAgent,
      handlers: {
        requestPermission: () => ({ outcome: { outcome: 'cancelled' } }),
        sessionUpdate: () => {},
      },
      extensions: [
        defineAcpExtensionRequest({
          method: 'example/strict',
          params: objectWithStringValue,
          handler: () => {
            handlerCalls += 1;
            return {};
          },
        }),
      ],
    });

    try {
      const response = await connection.peer.prompt({
        sessionId: 'session-1',
        prompt: [{ type: 'text', text: 'go' }],
      });
      expect(response._meta).toEqual({ code: -32602 });
      expect(handlerCalls).toBe(0);
    } finally {
      connection.close();
      await connection.closed;
    }
  });

  it('exposes one provider-neutral outgoing custom request peer', async () => {
    const testAgent = agent({ name: 'outgoing-extension-test-agent' })
      .onRequest('example/models', objectWithStringValue, (context) => ({
        model: context.params.value,
      }));
    const connection = await createAcpClientConnection({
      name: 'outgoing-extension-test-client',
      transport: testAgent,
      handlers: {
        requestPermission: () => ({ outcome: { outcome: 'cancelled' } }),
        sessionUpdate: () => {},
      },
    });

    try {
      await expect(connection.peer.requestExtension<{ model: string }>(
        'example/models',
        { value: 'model-1' },
      )).resolves.toEqual({ model: 'model-1' });
    } finally {
      connection.close();
      await connection.closed;
    }
  });

  it('returns method-not-found for an unregistered outgoing extension', async () => {
    const connection = await createAcpClientConnection({
      name: 'unknown-extension-test-client',
      transport: agent({ name: 'unknown-extension-test-agent' }),
      handlers: {
        requestPermission: () => ({ outcome: { outcome: 'cancelled' } }),
        sessionUpdate: () => {},
      },
    });

    try {
      await expect(connection.peer.requestExtension('example/missing', {}))
        .rejects.toMatchObject({ code: -32601 });
    } finally {
      connection.close();
      await connection.closed;
    }
  });

  it('aborts an in-flight inbound extension handler before connection close settles', async () => {
    let handlerAborted = false;
    let resolveStarted: (() => void) | null = null;
    const started = new Promise<void>((resolve) => { resolveStarted = resolve; });
    const testAgent = agent({ name: 'inbound-close-test-agent' })
      .onRequest(methods.agent.session.prompt, async (context) => {
        await context.client.request('example/client-slow', { value: 'request' });
        return { stopReason: 'end_turn' };
      });
    const connection = await createAcpClientConnection({
      name: 'inbound-close-test-client',
      transport: testAgent,
      handlers: {
        requestPermission: () => ({ outcome: { outcome: 'cancelled' } }),
        sessionUpdate: () => {},
      },
      extensions: [
        defineAcpExtensionRequest({
          method: 'example/client-slow',
          params: objectWithStringValue,
          handler: async (_params, context) => {
            resolveStarted?.();
            await new Promise<void>((_resolve, reject) => {
              context.signal.addEventListener('abort', () => {
                handlerAborted = true;
                reject(RequestError.requestCancelled());
              }, { once: true });
            });
            return {};
          },
        }),
      ],
    });

    const prompt = connection.peer.prompt({
      sessionId: 'session-1',
      prompt: [{ type: 'text', text: 'go' }],
    });
    await started;
    connection.close(new Error('test connection close'));

    await expect(prompt).rejects.toThrow();
    await connection.closed;
    expect(handlerAborted).toBe(true);
  });

  it('rejects duplicate registrations for the same extension direction and method', async () => {
    const duplicate = defineAcpExtensionRequest({
      method: 'example/duplicate',
      params: objectWithStringValue,
      handler: () => ({}),
    });

    await expect(createAcpClientConnection({
      name: 'duplicate-extension-test-client',
      transport: agent({ name: 'duplicate-extension-test-agent' }),
      handlers: {
        requestPermission: () => ({ outcome: { outcome: 'cancelled' } }),
        sessionUpdate: () => {},
      },
      extensions: [duplicate, duplicate],
    })).rejects.toThrow(/Duplicate ACP extension request registration/);
  });
});
