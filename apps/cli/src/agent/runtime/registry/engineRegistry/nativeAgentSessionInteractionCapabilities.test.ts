import { describe, expect, it, vi } from 'vitest';

import type {
  AgentSessionRuntime,
  AgentSessionRuntimeContext,
} from '@happier-dev/plugin-sdk/agents/runtime';
import type { AgentSessionCapabilities } from '@/plugins/projection/registry/agentContributionDefinition';

import { createNativeAgentSessionInteractionOperations } from './nativeAgentSession';

/**
 * A Session runtime that implements every optional control. The declared
 * capabilities — not the presence of these methods — decide what the host may
 * offer, so this fixture is deliberately more capable than any declaration
 * under test.
 */
function createFullyCapableSessionRuntime(): AgentSessionRuntime {
  return {
    watch: () => ({ dispose() {} }),
    send: vi.fn(async () => undefined),
    cancel: vi.fn(async () => ({ status: 'requested' as const })),
    updateConfiguration: vi.fn(async () => ({ status: 'applied' as const })),
    compact: vi.fn(async () => ({ status: 'admitted' as const })),
    dispose: vi.fn(async () => undefined),
  } as unknown as AgentSessionRuntime;
}

function createSessionRuntimeWithLiveManualCompaction(
  manual: 'supported' | 'unsupported',
): AgentSessionRuntime {
  return {
    ...createFullyCapableSessionRuntime(),
    runtimeCapabilities: {
      sessionCapabilities: {
        sessionListing: 'unsupported',
        sessionFork: {
          conversation: 'unsupported',
          fromMessage: 'unsupported',
        },
        sessionRollback: { conversation: 'unsupported' },
        usageLimitRecovery: { checkNow: 'unsupported' },
        compaction: manual === 'supported' ? { events: true, manual: true } : null,
      },
    },
  } as unknown as AgentSessionRuntime;
}

function createContext(): AgentSessionRuntimeContext {
  return {
    agent: { id: 'acp:review-bot' },
    session: { id: 'host-session-1' },
  } as unknown as AgentSessionRuntimeContext;
}

function createOperations(
  capabilities: AgentSessionCapabilities,
  session: AgentSessionRuntime = createFullyCapableSessionRuntime(),
) {
  return createNativeAgentSessionInteractionOperations({
    session,
    sessionId: 'host-session-1',
    cwd: '/tmp/interaction-capabilities',
    context: createContext(),
    capabilities,
  });
}

describe('native Agent Session interaction capability ownership', () => {
  it('exposes the resolved host idle descriptor and a bound idle control without requiring manual support', async () => {
    const session = createFullyCapableSessionRuntime();
    const operations = createOperations({ open: ['create'], delivery: ['newTurn'], cancel: true,
      compaction: { events: true, idle: { mode: 'host', defaultEnabled: false } },
    }, session);
    expect(operations.readSessionCompactionCapability?.()).toEqual({ events: true, idle: { mode: 'host', defaultEnabled: false } });
    expect(operations.compactContext).toBeUndefined();
    const signal = new AbortController().signal;
    await operations.compact?.({ compactionId: 'idle-admission', trigger: 'idle' }, { signal });
    expect(session.compact).toHaveBeenCalledWith({ compactionId: 'idle-admission', trigger: 'idle' }, { signal });
  });
  it('uses the live Session runtime fact for dialect-dependent manual compaction', () => {
    expect('compactContext' in createOperations({
      open: ['create'],
      delivery: ['newTurn'],
      cancel: true,
    })).toBe(false);

    expect('compactContext' in createOperations({
      open: ['create'],
      delivery: ['newTurn'],
      cancel: true,
      compaction: { events: true },
    }, createSessionRuntimeWithLiveManualCompaction('supported'))).toBe(true);

    expect('compactContext' in createOperations({
      open: ['create'],
      delivery: ['newTurn'],
      cancel: true,
      compaction: { events: true, manual: true },
    }, createSessionRuntimeWithLiveManualCompaction('unsupported'))).toBe(false);
  });

  it('refuses to compose when a declaration promises a control the runtime does not implement', () => {
    const session = {
      watch: () => ({ dispose() {} }),
      send: vi.fn(async () => undefined),
      dispose: vi.fn(async () => undefined),
    } as unknown as AgentSessionRuntime;

    expect(() => createOperations(
      { open: ['create'], delivery: ['newTurn'], cancel: true },
      session,
    )).toThrow(/does not implement cancel/);
  });

  it('refuses a live manual-compaction claim when the Session runtime omits compact', () => {
    const capable = createSessionRuntimeWithLiveManualCompaction('supported');
    const session = {
      ...capable,
      compact: undefined,
    } as AgentSessionRuntime;

    expect(() => createOperations({
      open: ['create'],
      delivery: ['newTurn'],
      cancel: true,
      compaction: { events: true },
    }, session)).toThrow(/publishes manual compaction support/);
  });
});
