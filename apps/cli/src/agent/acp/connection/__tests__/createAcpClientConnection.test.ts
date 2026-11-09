import { agent, methods, PROTOCOL_VERSION, RequestError, type ClientContext } from '@agentclientprotocol/sdk';
import { describe, expect, it } from 'vitest';

import { createAcpClientConnection } from '../createAcpClientConnection';
import { AcpAgentPeer } from '../AcpAgentPeer';
import { defineAcpExtensionNotification, defineAcpExtensionRequest } from '../types';
import { createAcpClientHandlers } from '../../createAcpClientHandlers';
import { createLegacyHandlerContextFixture } from '../../__tests__/legacyToolRuntimeFixture';
import { createPublicAcpPermissionHandler } from '../../runtime/publicSession/createPublicAcpPermissionHandler';
import { ProviderEnforcedPermissionHandler } from '@/agent/permissions/providerEnforced/handler';
import { createNativeAgentCurrentSessionUiServices } from '@/agent/runtime/registry/engineRegistry/nativeAgentSessionInteractions';
import { ServerBoundPermissionRpcHandlerManager } from '@/agent/permissions/testkit/serverBoundPermissionRpcHandlerManager';
import type { AgentState } from '@/api/types';
import type { ApiSessionClient } from '@/api/session/sessionClient';

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
  it('preserves the standard tool name through SDK notification decoding', async () => {
    // fx 0.0.14 raw frame, 2026-10-27: E-fx-live-probe.md §3.
    const update = { sessionUpdate: 'tool_call', toolCallId: '<T1>', name: 'write_file',
      title: 'file_mutation', kind: 'edit', status: 'pending',
      rawInput: { path: 'probe-ok.txt', content: 'ok' } };
    const received: unknown[] = [];
    const testAgent = agent({ name: 'standard-tool-name-agent' })
      .onRequest(methods.agent.session.new, async context => {
        await context.client.notify('session/update', {
          sessionId: 'session-1', update: { ...update, toolCallId: undefined },
        });
        await context.client.notify('session/update', { sessionId: 'session-1', update });
        return { sessionId: 'session-1' };
      });
    const connection = createAcpClientConnection({
      name: 'standard-tool-name-client', transport: testAgent,
      handlers: {
        requestPermission: () => ({ outcome: { outcome: 'cancelled' } }),
        sessionUpdate: notification => { received.push(notification.update); },
      },
    });
    try {
      await connection.peer.newSession({ cwd: '/workspace', mcpServers: [] });
      expect(received).toMatchObject([update]);
    } finally {
      connection.close();
      await connection.closed;
    }
  });
  it('withdraws cancellation and returns explicit decline without cancelling the active turn', async () => {
    let resolvePresented!: () => void;
    const presented = new Promise<void>((resolve) => { resolvePresented = resolve; });
    // The Session state/RPC transport is external; all permission and interaction owners stay real.
    const session = {
      sessionId: 'elicitation-cancellation',
      rpcHandlerManager: new ServerBoundPermissionRpcHandlerManager('elicitation-cancellation'),
      state: { requests: {}, completedRequests: {} } as AgentState,
      getAgentStateSnapshot() { return this.state; },
      getMetadataSnapshot() { return null; },
      updateAgentState(update: (state: AgentState) => AgentState) {
        this.state = update(this.state);
        if (Object.keys(this.state.requests ?? {}).length > 0) resolvePresented();
        return this.state;
      },
    };
    const hostPermissionHandler = new ProviderEnforcedPermissionHandler(
      session as unknown as ApiSessionClient,
      { logPrefix: '[ACP cancellation test]', getWorkspaceWrites: () => 'allow' },
    );
    const lifetime = new AbortController();
    const currentSession = createNativeAgentCurrentSessionUiServices({
      permissionHandler: hostPermissionHandler,
      pluginId: 'happier.agent.test', contributionId: 'test', runtimeId: 'test',
      sessionId: session.sessionId, occurrenceId: 'occurrence-1',
      isCurrent: () => true, signal: lifetime.signal,
    });
    const permissionHandler = createPublicAcpPermissionHandler({
      interactions: currentSession.interactions,
      signal: lifetime.signal,
      resolveRequestId: (toolCallId) => `turn-1:${toolCallId}`,
      resolveTurnId: () => 'turn-1',
      resolveCausalPermissionAuthority: () => ({
        kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'default',
      }),
    });
    const handlerContext = createLegacyHandlerContextFixture();
    const handlers = createAcpClientHandlers({
      onSessionUpdate() {}, transport: handlerContext.transport, emit() {},
      permissionHandler, createHandlerContext: () => handlerContext,
      getToolNameContext: () => ({ recentPromptHadChangeTitle: false, toolCallCountSincePrompt: 0 }),
      getActiveSessionId: () => session.sessionId,
      capturePermissionRequest: () => ({
        scope: 'turn', isCurrent: () => true,
        cancel: async () => { throw new Error('Individual cancellation must preserve the turn'); },
      }),
      emitPermissionResponse: async () => undefined, clearTrackedToolCall() {},
      incrementToolCallCountSincePrompt() {}, toolCalls: handlerContext.toolCalls,
      lastSelectedPermissionOptionIdByToolCallId: new Map(),
    });
    const testAgent = agent({ name: 'elicitation-cancellation-agent' })
      .onRequest('test/elicit', (params) => params, async (context) => {
        const response = context.client.request(methods.client.elicitation.create, {
          mode: 'form', sessionId: session.sessionId, message: 'Continue?',
          requestedSchema: { type: 'object', properties: {} },
        });
        try {
          await presented;
          await context.client.notify(methods.protocol.cancelRequest, { requestId: 0 });
          await expect.poll(() => Object.keys(session.state.requests ?? {})).toEqual([]);
          await expect(response).resolves.toEqual({ action: 'cancel' });
          expect(lifetime.signal.aborted).toBe(false);

          for (const choice of ['decline', 'confirm'] as const) {
            const nextResponse = context.client.request(methods.client.elicitation.create, {
              mode: 'form', sessionId: session.sessionId, message: 'Try again?',
              requestedSchema: { type: 'object', properties: {} },
            });
            await expect.poll(() => Object.keys(session.state.requests ?? {}).length).toBe(1);
            const [id] = Object.keys(session.state.requests ?? {});
            const respond = session.rpcHandlerManager.handlers.get('session.user_action.answer');
            expect(respond).toBeDefined();
            expect(await respond?.({ id, approved: true, answers: { confirmation: [choice] } })).toBeUndefined();
            await expect(nextResponse).resolves.toEqual(choice === 'confirm'
              ? { action: 'accept', content: {} }
              : { action: 'decline' });
            expect(lifetime.signal.aborted).toBe(false);
            expect(Object.keys(session.state.requests ?? {})).toHaveLength(0);
          }
          return {};
        } finally {
          await permissionHandler.abortPendingRequestsAndFlush?.('test cleanup');
          await response.catch(() => undefined);
        }
      });
    const connection = createAcpClientConnection({
      name: 'elicitation-cancellation-client', transport: testAgent, handlers,
    });
    try {
      await expect(connection.peer.requestExtension('test/elicit', {})).resolves.toEqual({});
    } finally {
      lifetime.abort();
      connection.close();
      await connection.closed;
    }
  });

  it('preserves non-extensible SDK transport errors without a provider classifier', async () => {
    const failure = Object.preventExtensions(new Error('SDK transport unavailable'));
    const context = { request: async () => { throw failure; } } satisfies Pick<ClientContext, 'request'>;
    // SDK boundary fixture: this operation uses only request; unrelated SDK session builders are absent.
    const peer = new AcpAgentPeer(context as unknown as ClientContext, new AbortController().signal);
    await expect(peer.loadSession({ sessionId: 'missing', cwd: '/tmp', mcpServers: [] })).rejects.toBe(failure);
    expect(failure).not.toHaveProperty('authenticationSetupFailure');
  });

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
