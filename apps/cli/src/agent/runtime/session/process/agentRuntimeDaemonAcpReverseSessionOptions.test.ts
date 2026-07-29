import { describe, expect, it, vi } from 'vitest';

import type { AgentAcpRuntimeOptions } from '@happier-dev/plugin-sdk/agent-runtime';

import {
  createAgentRuntimeDaemonAcpCallbackRegistry,
  encodeAgentRuntimeDaemonAcpOptionsV1,
} from './agentRuntimeDaemonAcpReverseSessionOptions';

function stdioTransport(): AgentAcpRuntimeOptions['transport'] {
  return {
    kind: 'stdio',
    executable: { kind: 'systemTool', id: 'agent-acp' },
  };
}

describe('encodeAgentRuntimeDaemonAcpOptionsV1', () => {
  it('keeps a static Auggie-shaped definition data-only', () => {
    const registry = createAgentRuntimeDaemonAcpCallbackRegistry();
    const encoded = encodeAgentRuntimeDaemonAcpOptionsV1({
      transport: stdioTransport(),
      definition: {
        modelConfigOptionId: 'model',
        timeouts: { initMs: 10_000 },
        toolNameInference: {
          patterns: [{ name: 'search', patterns: ['search'] }],
        },
        stderrRules: {
          suppress: [{ includes: ['ready'] }],
        },
        mcp: { policy: 'pass_through' },
      },
    }, registry);

    expect(encoded).toEqual({
      transport: stdioTransport(),
      definition: {
        modelConfigOptionId: 'model',
        timeouts: { initMs: 10_000 },
        toolNameInference: {
          patterns: [{ name: 'search', patterns: ['search'] }],
        },
        stderrRules: {
          suppress: [{ includes: ['ready'] }],
        },
        mcp: { policy: 'pass_through' },
      },
    });
    expect(registry.size).toBe(0);
  });

  it('preserves ordered history-fork methods while registering its callbacks', () => {
    const registry = createAgentRuntimeDaemonAcpCallbackRegistry();
    const buildParams = vi.fn(() => ({}));
    const readProviderSessionId = vi.fn(() => 'provider-forked');

    const encoded = encodeAgentRuntimeDaemonAcpOptionsV1({
      transport: stdioTransport(),
      definition: {
        history: {
          projectUserMessageProviderCheckpoint: () => null,
          fork: {
            methods: ['x.ai/session/fork', '_x.ai/session/fork'],
            buildParams,
            readProviderSessionId,
          },
        },
        mcp: { policy: 'drop' },
      },
    }, registry);

    expect(encoded.definition?.history?.fork?.methods).toEqual([
      'x.ai/session/fork',
      '_x.ai/session/fork',
    ]);
    expect(registry.get(
      'history.fork.buildParams',
      encoded.definition!.history!.fork!.buildParamsCallbackId,
    )).toBe(buildParams);
    expect(registry.get(
      'history.fork.readProviderSessionId',
      encoded.definition!.history!.fork!.readProviderSessionIdCallbackId,
    )).toBe(readProviderSessionId);
  });

  it('registers Codex/Grok-shaped callbacks by exact callback kind and disposes them', () => {
    const projectModel = vi.fn((_raw, normalized) => normalized);
    const resolveToolName = vi.fn(() => 'search');
    const extension = vi.fn(async () => ({ ok: true }));
    const registry = createAgentRuntimeDaemonAcpCallbackRegistry();
    const encoded = encodeAgentRuntimeDaemonAcpOptionsV1({
      transport: stdioTransport(),
      definition: {
        auth: { selectMethod: async () => ({ methodId: 'oauth' }) },
        models: { projectModel },
        toolNameResolver: resolveToolName,
        mcp: { policy: 'pass_through' },
      },
      extensions: {
        requests: { 'x.test/request': extension },
      },
    }, registry);

    const modelCallbackId = encoded.definition?.models?.projectModelCallbackId;
    const toolCallbackId = encoded.definition?.toolNameResolverCallbackId;
    const extensionCallbackId = encoded.extensions?.[0]?.callbackId;
    expect(modelCallbackId).toBeTruthy();
    expect(toolCallbackId).toBeTruthy();
    expect(extensionCallbackId).toBeTruthy();
    expect(registry.get('model.project', modelCallbackId!)).toBe(projectModel);
    expect(registry.get('tool.resolveName', toolCallbackId!)).toBe(resolveToolName);
    expect(registry.get('extension.request', extensionCallbackId!)).toBe(extension);
    expect(() => registry.get('tool.resolveName', modelCallbackId!))
      .toThrow(/callback kind/i);

    registry.dispose();
    expect(registry.size).toBe(0);
    expect(() => registry.get('model.project', modelCallbackId!))
      .toThrow(/disposed/i);
  });

  it('preserves underscore-prefixed provider ACP extension methods', () => {
    const question = vi.fn(async () => ({ outcome: 'cancelled' }));
    const promptComplete = vi.fn();
    const registry = createAgentRuntimeDaemonAcpCallbackRegistry();

    const encoded = encodeAgentRuntimeDaemonAcpOptionsV1({
      transport: stdioTransport(),
      extensions: {
        requests: { '_x.ai/ask_user_question': question },
        notifications: { '_x.ai/session/prompt_complete': promptComplete },
      },
    }, registry);

    expect(encoded.extensions?.map(({ kind, method }) => ({ kind, method })))
      .toEqual([
        { kind: 'request', method: '_x.ai/ask_user_question' },
        { kind: 'notification', method: '_x.ai/session/prompt_complete' },
      ]);
  });
});
