import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  AGENT_RUNTIME_DAEMON_ACP_REVERSE_SESSION_LOSS_DISPOSE_REASON,
  AgentRuntimeDaemonAcpChildOperationV1Schema,
  AgentRuntimeDaemonAcpDaemonOperationV1Schema,
  AgentRuntimeDaemonAcpOpenResultV1Schema,
  AgentRuntimeDaemonAcpOptionsV1Schema,
  createAgentRuntimeDaemonAcpOpenOperationV1Schema,
  parseAgentRuntimeDaemonAcpChildOperationResultV1,
  parseAgentRuntimeDaemonAcpDaemonOperationResultV1,
} from './agentRuntimeDaemonAcpReverseSessionProtocol';

const callbackId = 'callback-1';

describe('AgentRuntimeDaemonAcpOptionsV1Schema', () => {
  it('carries strict ACP data and explicit session-scoped callback handles', () => {
    const options = {
      transport: {
        kind: 'stdio',
        executable: {
          kind: 'systemTool',
          id: { pluginId: 'happier.agent.grok', localId: 'grok' },
        },
        args: ['acp'],
      },
      definition: {
        auth: { kind: 'callback', callbackId: 'auth' },
        parameterizedModelPicker: true,
        modelConfigOptionId: 'model',
        models: {
          projectModelCallbackId: 'model-project',
          projectUpdateCallbackId: 'model-update',
          projectSetModelResponseCallbackId: 'model-response',
        },
        acceptsVerifiedImageInput: true,
        toolNameResolverCallbackId: 'tool-name',
        sanitizeToolUpdateContentCallbackId: 'tool-sanitize',
        generatedMedia: { projectTerminalOutputCallbackId: 'generated-media' },
        history: {
          projectUserMessageProviderCheckpointCallbackId: 'checkpoint',
          fork: {
            methods: ['x.ai/session/fork', '_x.ai/session/fork'],
            buildParamsCallbackId: 'fork-params',
            readProviderSessionIdCallbackId: 'fork-session',
          },
          createConversationRollbackCallbackId: 'rollback-control',
        },
        mcp: { policy: 'pass_through' },
      },
      extensions: [
        { kind: 'request', method: 'x.ai/session/custom', callbackId: 'extension-request' },
        { kind: 'notification', method: 'x.ai/session/prompt_complete', callbackId: 'extension-notification' },
      ],
    } as const;

    expect(AgentRuntimeDaemonAcpOptionsV1Schema.parse(options)).toEqual(options);
    expect(AgentRuntimeDaemonAcpOptionsV1Schema.safeParse({
      ...options,
      definition: {
        ...options.definition,
        selectMethod() {
          return null;
        },
      },
    }).success).toBe(false);
    expect(AgentRuntimeDaemonAcpOptionsV1Schema.safeParse({
      ...options,
      extensions: [...options.extensions, options.extensions[0]],
    }).success).toBe(false);
    expect(AgentRuntimeDaemonAcpOptionsV1Schema.safeParse({
      ...options,
      definition: {
        ...options.definition,
        history: {
          ...options.definition.history,
          fork: {
            ...options.definition.history.fork,
            methods: [],
          },
        },
      },
    }).success).toBe(false);
    expect(AgentRuntimeDaemonAcpOptionsV1Schema.safeParse({
      ...options,
      definition: {
        ...options.definition,
        history: {
          ...options.definition.history,
          fork: {
            ...options.definition.history.fork,
            methods: ['x.ai/session/fork', 'not-namespaced'],
          },
        },
      },
    }).success).toBe(false);
    expect(AgentRuntimeDaemonAcpOptionsV1Schema.safeParse({
      ...options,
      definition: {
        ...options.definition,
        history: {
          ...options.definition.history,
          fork: {
            ...options.definition.history.fork,
            methods: Array.from(
              { length: 9 },
              (_, index) => `x.ai/session/fork-${index}`,
            ),
          },
        },
      },
    }).success).toBe(false);
    expect(AgentRuntimeDaemonAcpOptionsV1Schema.safeParse({
      ...options,
      definition: {
        ...options.definition,
        history: {
          ...options.definition.history,
          fork: {
            method: 'x.ai/session/fork',
            buildParamsCallbackId: 'fork-params',
            readProviderSessionIdCallbackId: 'fork-session',
          },
        },
      },
    }).success).toBe(false);
  });
});

describe('AgentRuntimeDaemonAcp reverse-session operations', () => {
  it('uses strict callback-response envelopes for extension completion evidence', () => {
    const context = {
      method: 'x.test/completion',
      providerSessionId: 'provider-1',
      currentTurn: {
        turnId: 'turn-1',
        completionEvidenceId: 'evidence-1',
      },
    };
    const requestOperation = AgentRuntimeDaemonAcpDaemonOperationV1Schema.parse({
      kind: 'acp.callback.extension.request',
      requestId: 'request-1',
      reverseSessionId: 'reverse-1',
      callbackId,
      params: {},
      context,
    });
    const notificationOperation =
      AgentRuntimeDaemonAcpDaemonOperationV1Schema.parse({
        kind: 'acp.callback.extension.notification',
        requestId: 'notification-1',
        reverseSessionId: 'reverse-1',
        callbackId,
        params: {},
        context,
      });
    const completionEvidence = {
      providerSessionId: 'provider-1',
      promptId: 'turn-1',
      outcome: { kind: 'completed' as const },
    };

    expect(parseAgentRuntimeDaemonAcpDaemonOperationResultV1(
      requestOperation,
      { value: { accepted: true }, completionEvidence },
    )).toEqual({ value: { accepted: true }, completionEvidence });
    expect(parseAgentRuntimeDaemonAcpDaemonOperationResultV1(
      notificationOperation,
      { completionEvidence },
    )).toEqual({ completionEvidence });
    expect(() => parseAgentRuntimeDaemonAcpDaemonOperationResultV1(
      requestOperation,
      { value: { accepted: true } },
    )).toThrow();
    expect(() => parseAgentRuntimeDaemonAcpDaemonOperationResultV1(
      notificationOperation,
      { completionEvidence, extra: true },
    )).toThrow();
    expect(() => parseAgentRuntimeDaemonAcpDaemonOperationResultV1(
      notificationOperation,
      {
        completionEvidence: {
          ...completionEvidence,
          outcome: { kind: 'future' },
        },
      },
    )).toThrow();
  });

  it('covers the child-owned AgentSessionRuntime surface without generic invoke or replay', () => {
    const operations = [
      {
        kind: 'acp.session.send',
        effectId: 'call-send',
        reverseSessionId: 'reverse-1',
        request: {
          inputIds: ['input-1'],
          input: { text: 'hello' },
          delivery: { kind: 'newTurn', turnId: 'turn-1' },
        },
      },
      {
        kind: 'acp.session.cancel',
        effectId: 'call-cancel',
        reverseSessionId: 'reverse-1',
        turnId: 'turn-1',
        reason: 'user',
      },
      {
        kind: 'acp.session.updateConfiguration',
        effectId: 'call-configuration',
        reverseSessionId: 'reverse-1',
        request: {
          mode: { value: null, updatedAtMs: 1 },
          model: { value: 'gpt-5', updatedAtMs: 2 },
          permissionIntent: { value: null, updatedAtMs: 1 },
          options: {},
          providerBinding: {
            connectionId: 'pc_gateway',
            model: { id: 'gpt-5', name: 'GPT-5' },
            materialization: { v: 1, kind: 'spawnEnv' },
          },
        },
      },
      {
        kind: 'acp.session.dispose',
        effectId: 'call-dispose',
        reverseSessionId: 'reverse-1',
        reason: 'runtime_recovery',
      },
      {
        kind: 'acp.historySession.requestExtension',
        effectId: 'call-history',
        reverseSessionId: 'reverse-1',
        historySessionId: 'history-1',
        methods: ['x.ai/rewind/execute', '_x.ai/rewind/execute'],
        params: {},
        timeoutMs: 5_000,
      },
    ] as const;

    for (const operation of operations) {
      expect(AgentRuntimeDaemonAcpChildOperationV1Schema.safeParse(operation).success).toBe(true);
    }
    expect(AgentRuntimeDaemonAcpChildOperationV1Schema.safeParse({
      kind: 'acp.invoke',
      effectId: 'call-1',
      reverseSessionId: 'reverse-1',
      path: ['send'],
      replay: true,
    }).success).toBe(false);
    expect(AGENT_RUNTIME_DAEMON_ACP_REVERSE_SESSION_LOSS_DISPOSE_REASON)
      .toBe('runtime_recovery');
  });

  it('composes reverse open with the existing canonical session-open schema', () => {
    const openSchema = createAgentRuntimeDaemonAcpOpenOperationV1Schema(
      z.object({
        kind: z.literal('create'),
        sessionId: z.string().min(1),
        cwd: z.string().min(1),
      }).strict(),
    );
    expect(openSchema.safeParse({
      kind: 'acp.session.open',
      effectId: 'open-1',
      reverseSessionId: 'reverse-1',
      request: { kind: 'create', sessionId: 'session-1', cwd: '/repo' },
      options: {
        transport: {
          kind: 'stdio',
          executable: {
            kind: 'systemTool',
            id: { pluginId: 'happier.agent.grok', localId: 'grok' },
          },
        },
        resolvedExecutable: {
          kind: 'systemTool',
          toolId: 'grok',
          command: '/resolved/bin/grok',
        },
      },
    }).success).toBe(true);
    expect(openSchema.safeParse({
      kind: 'acp.session.open',
      effectId: 'open-invalid-launch',
      reverseSessionId: 'reverse-1',
      request: { kind: 'create', sessionId: 'session-1', cwd: '/repo' },
      options: {
        transport: {
          kind: 'stdio',
          executable: { kind: 'systemTool', id: 'grok' },
        },
        resolvedExecutable: {
          kind: 'systemTool',
          toolId: 'grok',
          command: 'bad\0command',
        },
      },
    }).success).toBe(false);
    expect(openSchema.safeParse({
      kind: 'acp.session.open',
      effectId: 'open-1',
      reverseSessionId: 'reverse-1',
      request: {
        kind: 'create',
        sessionId: 'session-1',
        cwd: '/repo',
        hostContext: {},
      },
      options: {},
    }).success).toBe(false);
  });

  it('carries bounded plugin callbacks, completion handles, history controls, events, and cancellation', () => {
    const extension = {
      kind: 'acp.callback.extension.request',
      requestId: 'call-extension',
      reverseSessionId: 'reverse-1',
      callbackId,
      params: { prompt: 'hello' },
      context: {
        method: 'x.ai/session/custom',
        requestId: 'provider-request-1',
        providerSessionId: 'provider-1',
        currentTurn: {
          turnId: 'turn-1',
          completionEvidenceId: 'evidence-1',
        },
      },
    } as const;
    expect(AgentRuntimeDaemonAcpDaemonOperationV1Schema.parse(extension)).toEqual(extension);
    expect(AgentRuntimeDaemonAcpDaemonOperationV1Schema.safeParse({
      ...extension,
      context: {
        ...extension.context,
        signal: {},
        hostContext: {},
      },
    }).success).toBe(false);
    expect(AgentRuntimeDaemonAcpDaemonOperationV1Schema.safeParse({
      kind: 'acp.callback.cancel',
      requestId: 'cancel-1',
      reverseSessionId: 'reverse-1',
      targetRequestId: '',
    }).success).toBe(false);
  });

  it('parses results against the initiating operation instead of a generic JSON result', () => {
    const send = AgentRuntimeDaemonAcpChildOperationV1Schema.parse({
      kind: 'acp.session.send',
      effectId: 'send-1',
      reverseSessionId: 'reverse-1',
      request: {
        inputIds: ['input-1'],
        input: { text: 'hello' },
        delivery: { kind: 'newTurn', turnId: 'turn-1' },
      },
    });
    expect(parseAgentRuntimeDaemonAcpChildOperationResultV1(send, {
      status: 'admitted',
    })).toEqual({ status: 'admitted' });
    expect(() => parseAgentRuntimeDaemonAcpChildOperationResultV1(send, {
      status: 'requested',
      turnId: 'turn-1',
    })).toThrow();

    const resolver = AgentRuntimeDaemonAcpDaemonOperationV1Schema.parse({
      kind: 'acp.callback.tool.resolveName',
      requestId: 'tool-1',
      reverseSessionId: 'reverse-1',
      callbackId,
      request: {
        toolName: 'unknown',
        toolCallId: 'tool-call-1',
        input: {},
        context: { toolCallCountSincePrompt: 1 },
      },
    });
    expect(parseAgentRuntimeDaemonAcpDaemonOperationResultV1(resolver, 'search')).toBe('search');
    expect(() => parseAgentRuntimeDaemonAcpDaemonOperationResultV1(resolver, {
      name: 'search',
    })).toThrow();
  });

  it('publishes only the optional runtime method set returned by the child open', () => {
    expect(AgentRuntimeDaemonAcpOpenResultV1Schema.parse({
      reverseSessionId: 'reverse-1',
      methods: ['cancel', 'updateConfiguration', 'compact', 'rollback', 'reconcileRollback'],
    })).toEqual({
      reverseSessionId: 'reverse-1',
      methods: ['cancel', 'updateConfiguration', 'compact', 'rollback', 'reconcileRollback'],
    });
    expect(AgentRuntimeDaemonAcpOpenResultV1Schema.safeParse({
      reverseSessionId: 'reverse-1',
      methods: ['send', 'watch', 'dispose'],
    }).success).toBe(false);
  });
});
