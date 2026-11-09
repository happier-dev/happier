import { expect, it, vi } from 'vitest';
import type { AgentExecutionRunRuntime, AgentExecutionRunRuntimeContextV1, AgentSessionRuntime, AgentSessionRuntimeContext } from '@happier-dev/plugin-sdk/agents/runtime';
import type { ConnectedAccountBindingEvent } from '@happier-dev/plugin-sdk/connected-accounts';
import { createOhMyPiAgentRuntime } from './engine.js';

it('keeps admitted finite native work alive across account resync until explicit disposal', async () => {
  const listeners = new Set<(event: ConnectedAccountBindingEvent) => void | Promise<void>>();
  const disposeNative = vi.fn(async () => {});
  const native = {
    send: async () => ({ status: 'admitted' as const }),
    stop: async () => ({ status: 'requested' as const }),
    watch: () => ({ dispose() {} }), dispose: disposeNative,
  } satisfies AgentExecutionRunRuntime;
  // Native ACP and the host Connected Accounts service are external plugin boundaries.
  const context = {
    signal: new AbortController().signal,
    services: { connectedAccounts: {
      getBinding: async () => null,
      watch(_purpose: string, listener: (event: ConnectedAccountBindingEvent) => void | Promise<void>) {
        listeners.add(listener);
        queueMicrotask(() => void listener({ kind: 'resync', authorityChanged: false }));
        return { dispose() { listeners.delete(listener); } };
      },
    } },
    protocols: { acp: { openExecutionRunV1: async () => native } },
  } as unknown as AgentExecutionRunRuntimeContextV1;
  const agent = await createOhMyPiAgentRuntime({
    plugin: { id: 'happier.agent.ohmypi', version: '0.0.0' },
    agent: { id: 'ohmypi' }, signal: context.signal,
  });
  const run = await agent.sessions.executionRunContextV1!.open({
    kind: 'create', runId: 'omp-account-continuity', cwd: '/workspace',
    profile: { pluginId: 'happier.agent.ohmypi', localId: 'default' }, input: { text: 'Keep working.' },
  }, context);
  try {
    for (const listener of listeners) await listener({ kind: 'resync', authorityChanged: true });
    expect(disposeNative).not.toHaveBeenCalled();
  } finally { await run.dispose(); }
  expect(disposeNative).toHaveBeenCalledOnce();
});


it('keeps a session alive for presentation resync and recovers it for an authority change', async () => {
  const listeners = new Set<(event: ConnectedAccountBindingEvent) => void | Promise<void>>();
  const disposeNative = vi.fn(async () => {});
  const native = { watch: () => ({ dispose() {} }), dispose: disposeNative } as unknown as AgentSessionRuntime;
  // The ACP session and Connected Accounts service are external host boundaries.
  const context = {
    signal: new AbortController().signal,
    services: { connectedAccounts: {
      getBinding: async () => null,
      watch(_purpose: string, listener: (event: ConnectedAccountBindingEvent) => void | Promise<void>) {
        listeners.add(listener);
        queueMicrotask(() => void listener({ kind: 'resync', authorityChanged: false }));
        return { dispose() { listeners.delete(listener); } };
      },
    } },
    protocols: { acp: { open: async () => native } },
  } as unknown as AgentSessionRuntimeContext;
  const agent = await createOhMyPiAgentRuntime({
    plugin: { id: 'happier.agent.ohmypi', version: '0.0.0' },
    agent: { id: 'ohmypi' }, signal: context.signal,
  });
  const session = await agent.sessions.open({ kind: 'create', sessionId: 'omp-presentation-continuity', cwd: '/workspace' }, context);
  try {
    for (const listener of listeners) await listener({ kind: 'resync', authorityChanged: false });
    expect(disposeNative).not.toHaveBeenCalled();
    for (const listener of listeners) await listener({ kind: 'resync', authorityChanged: true });
    expect(disposeNative).toHaveBeenCalledWith('runtime_recovery');
  } finally { await session.dispose(); }
  expect(disposeNative).toHaveBeenCalledOnce();
});
