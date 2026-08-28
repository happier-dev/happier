import { describe, expect, it, vi } from 'vitest';
import { ProviderConnectionIdSchema } from '@happier-dev/protocol';
import type {
  AgentRuntimeFactoryContext,
  AgentSessionRuntime,
  AgentSessionRuntimeContext,
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

describe('Codex Provider-bound Sessions', () => {
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
    const connectedAccounts = {
      getBinding: vi.fn(),
      requestSelection: vi.fn(),
      materialize: vi.fn(),
      watch: vi.fn(),
    };
    const context = {
      signal: new AbortController().signal,
      services: { connectedAccounts },
    } as unknown as AgentSessionRuntimeContext;
    const launchEnvironment = {
      values: {
        HAPPIER_CODEX_BACKEND_MODE: 'appServer',
        CODEX_HOME: '/host/materialized/codex-home',
      },
      unset: ['OPENAI_API_KEY'],
    };

    const openedSession = await runtime.sessions?.open({
      kind: 'create',
      sessionId: 'run-provider-codex',
      cwd: '/repo',
      configuration,
      providerBinding,
      launchEnvironment,
    }, context);

    expect(openCodexNativeAppServerSession).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'create',
        sessionId: 'run-provider-codex',
        configuration,
        providerBinding,
        launchEnvironment,
      }),
      context,
    );
    expect(connectedAccounts.watch).not.toHaveBeenCalled();
    expect(connectedAccounts.getBinding).not.toHaveBeenCalled();
    expect(connectedAccounts.materialize).not.toHaveBeenCalled();
    await openedSession?.dispose();
  });
});
