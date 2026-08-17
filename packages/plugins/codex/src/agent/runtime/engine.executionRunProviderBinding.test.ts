import { describe, expect, it, vi } from 'vitest';
import { ProviderConnectionIdSchema } from '@happier-dev/protocol';
import type {
  AgentRuntimeContext,
  AgentRuntimeFactoryContext,
  AgentSessionRuntime,
} from '@happier-dev/plugin-sdk/agents/runtime';

const { openCodexNativeAppServerSession } = vi.hoisted(() => ({
  openCodexNativeAppServerSession: vi.fn(),
}));

vi.mock('./appServer/native.js', () => ({
  openCodexNativeAppServerSession,
}));

import { createCodexAgentRuntime } from './engine.js';

function createSession(): AgentSessionRuntime {
  return {
    async send() { return { status: 'admitted' }; },
    watch() { return { dispose() {} }; },
    async dispose() {},
  };
}

describe('Codex Provider-bound execution runs', () => {
  it('carries the bounded configuration and Provider binding into the native session owner', async () => {
    const session = createSession();
    openCodexNativeAppServerSession.mockResolvedValueOnce(session);
    const providerConnectionId = ProviderConnectionIdSchema.parse('pc_codex');
    const configuration = {
      mode: { value: null, updatedAtMs: 0 },
      model: { value: 'gpt-5.1-codex', updatedAtMs: 5 },
      permissionIntent: { value: 'default' as const, updatedAtMs: 5 },
      options: { reasoning_effort: { value: 'high', updatedAtMs: 5 } },
    };
    const providerBinding = {
      connectionId: providerConnectionId,
      model: { id: 'gpt-5.1-codex', name: 'GPT-5.1 Codex' },
      materialization: {
        v: 1 as const,
        kind: 'engineConfig' as const,
        engineConfig: { provider: 'openai' },
      },
    };
    const runtime = await createCodexAgentRuntime({} as AgentRuntimeFactoryContext);
    const context = {
      signal: new AbortController().signal,
    } as unknown as AgentRuntimeContext;

    const run = await runtime.executionRuns?.open({
      kind: 'create',
      runId: 'run-provider-codex',
      cwd: '/repo',
      profile: { pluginId: 'happier.agent.codex', localId: 'default' },
      input: { text: 'Run it' },
      modelSelection: {
        agentTargetKey: 'backend:codex',
        providerConnectionId,
        modelId: 'gpt-5.1-codex',
      },
      configuration,
      providerBinding,
    }, context);

    expect(openCodexNativeAppServerSession).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'create',
        sessionId: 'run-provider-codex',
        configuration,
        providerBinding,
      }),
      context,
    );
    await run?.dispose();
  });
});
