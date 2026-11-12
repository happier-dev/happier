import { describe, expect, it, vi } from 'vitest';
import type { AgentExecutionRunRuntimeContextV1 } from '@happier-dev/plugin-sdk/agents/runtime';
import type { ConnectedAccountBindingEvent } from '@happier-dev/plugin-sdk/connected-accounts';
import { createOpenCodeAgentRuntime } from './nativeRuntime.js';

describe('OpenCode finite-run admission lifetime', () => {
  it('keeps an admitted run alive through account changes and refuses invalidation before the next open', async () => {
    const listeners = new Set<(event: ConnectedAccountBindingEvent) => unknown>();
    const notify = () => { for (const listener of listeners) listener({ kind: 'resync', authorityChanged: true }); };
    let invalidateBeforeOpen = false;
    const dispose = vi.fn(async () => {});
    const native = { send: vi.fn(async () => ({ status: 'admitted' as const })),
      stop: vi.fn(async () => ({ status: 'requested' as const })),
      watch: () => ({ dispose() {} }), dispose };
    // Host account transport and native ACP process are the only substituted boundaries.
    const open = vi.fn(async () => { notify(); return native; });
    const context = { signal: new AbortController().signal, services: { connectedAccounts: {
      async getBinding() { if (invalidateBeforeOpen) notify(); return null; },
      async materialize() { throw new Error('No selected account'); },
      watch(_purpose: string, listener: (event: ConnectedAccountBindingEvent) => unknown) {
        listeners.add(listener);
        queueMicrotask(() => listener({ kind: 'resync', authorityChanged: false }));
        return { dispose() { listeners.delete(listener); } };
      },
    } }, protocols: { acp: { openExecutionRunV1: open } } } as unknown as AgentExecutionRunRuntimeContextV1;
    const runtime = await createOpenCodeAgentRuntime({ plugin: { id: 'happier.agent.opencode', version: '0.0.0' },
      agent: { id: 'opencode' }, signal: context.signal });
    const request = { kind: 'create' as const, runId: 'admitted-run', cwd: '/workspace',
      profile: { pluginId: 'happier.agent.opencode', localId: 'default' }, input: { text: 'Work.' },
      runtimeDescriptorV1: { v: 1 as const, agentId: 'opencode', agent: { backendMode: 'acp' } } };
    const run = await runtime.sessions!.executionRunContextV1!.open(request, context);
    try {
      expect(dispose).not.toHaveBeenCalled();
      await expect(run.send({ text: 'Continue.' })).resolves.toMatchObject({ status: 'admitted' });
      invalidateBeforeOpen = true;
      await expect(runtime.sessions!.executionRunContextV1!.open({ ...request, runId: 'next-run' }, context))
        .rejects.toThrow('invalidated before opening');
      expect(open).toHaveBeenCalledOnce();
    } finally { await run.dispose(); }
    expect(dispose).toHaveBeenCalledOnce();
    expect(listeners.size).toBe(0);
  });
});
