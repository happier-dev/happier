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


it.each(['create', 'resume'] as const)('keeps the %s Session usable for another turn after account resync', async kind => {
  const listeners = new Set<(event: ConnectedAccountBindingEvent) => void | Promise<void>>();
  let disposed = false;
  const disposeNative = vi.fn(async () => { disposed = true; });
  const native = {
    async send() { return disposed
      ? { status: 'unavailable' as const, diagnostic: { code: 'acp_runtime_unavailable', message: 'Session disposed.' }, retryable: false }
      : { status: 'admitted' as const }; },
    watch: () => ({ dispose() {} }), dispose: disposeNative,
  } satisfies AgentSessionRuntime;
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
  const common = { sessionId: 'omp-presentation-continuity', cwd: '/workspace' };
  const session = await agent.sessions.open(kind === 'resume'
    ? { ...common, kind, providerSessionId: 'retained-native-session' }
    : { ...common, kind }, context);
  try {
    expect(listeners.size).toBeGreaterThan(0);
    await expect(session.send({ inputIds: ['first'], input: { text: 'First turn.' },
      delivery: { kind: 'newTurn', turnId: 'first' } })).resolves.toMatchObject({ status: 'admitted' });
    for (const listener of listeners) await listener({ kind: 'resync', authorityChanged: false });
    expect(disposeNative).not.toHaveBeenCalled();
    for (const listener of listeners) await listener({ kind: 'resync', authorityChanged: true });
    await expect(session.send({ inputIds: ['next'], input: { text: 'Next turn.' },
      delivery: { kind: 'newTurn', turnId: 'next' } })).resolves.toMatchObject({ status: 'admitted' });
    expect(disposeNative).not.toHaveBeenCalled();
  } finally { await session.dispose(); }
  expect(disposeNative).toHaveBeenCalledOnce();
  expect(listeners.size).toBe(0);
});
