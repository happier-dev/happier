import { describe, expect, it, vi } from 'vitest';

import type { Metadata } from '@/api/types';
import type { TrackedSession } from '../types';
import { reconcileAgentRuntimeRestartDisposition } from './reconcileAgentRuntimeRestartDisposition';

function tracked(overrides: Partial<TrackedSession> = {}): TrackedSession {
  return {
    pid: 85855,
    startedBy: 'daemon',
    happySessionId: 'session-restarted',
    reattachedFromDiskMarker: true,
    spawnOptions: {
      directory: '/workspace',
      backendTarget: {
        kind: 'backend',
        backendId: 'grok',
        sourceKind: 'built_in',
      },
    },
    ...overrides,
  };
}

describe('reconcileAgentRuntimeRestartDisposition', () => {
  it('fails closed for a catalogued native Agent before its lazy runtime registration activates', async () => {
    const current = tracked();
    await reconcileAgentRuntimeRestartDisposition({
      trackedSessions: [current],
      acquireRegistryLease: (async () => ({
        registry: {
          contributes: {
            agentDefinitionsById: new Map([[
              'grok',
              {
                id: 'grok',
                provenance: 'first_party',
                source: { kind: 'bundled' },
                pluginId: 'happier.agent.grok',
                definition: {
                  kindVersion: 1,
                  id: 'grok',
                  ownedBackendIds: ['grok'],
                },
                richDefinition: {
                  provenance: 'first_party',
                  definition: {
                    id: 'grok',
                    title: 'Grok',
                    runtime: { kind: 'native' },
                    primary: 'sessions',
                    capabilities: {
                      sessions: {
                        open: ['create', 'resume'],
                        delivery: ['newTurn'],
                        cancel: true,
                        configuration: false,
                        compaction: { events: true },
                      },
                    },
                  },
                },
              },
            ]]),
          },
          agentRuntimesByAgentId: new Map(),
        },
        release: async () => undefined,
      })) as never,
    });

    expect(current.agentRuntimeRestartDisposition)
      .toBe('bridge_authority_unavailable');
  });

  it('marks only a current daemon-owned native Agent runtime unavailable after restart', async () => {
    const current = tracked();
    const release = vi.fn(async () => undefined);
    const acquireRegistryLease = vi.fn(async () => ({
      registry: {
        contributes: {
          agentDefinitionsById: new Map([[
            'grok',
            {
              id: 'grok',
              provenance: 'first_party',
              source: { kind: 'bundled' },
              pluginId: 'happier.agent.grok',
              definition: { kindVersion: 1, id: 'grok', ownedBackendIds: ['grok'] },
              richDefinition: {
                provenance: 'first_party',
                definition: {
                  id: 'grok',
                  title: 'Grok',
                  runtime: { kind: 'native' },
                  primary: 'sessions',
                  capabilities: {
                    sessions: {
                      open: ['create', 'resume'],
                      delivery: ['newTurn'],
                      cancel: true,
                      configuration: false,
                      compaction: { events: true },
                    },
                  },
                },
              },
            },
          ]]),
        },
        agentRuntimesByAgentId: new Map([[
          'grok',
          {
            hasPrimaryRuntime: true,
            pluginId: 'happier.agent.grok',
            agentId: 'grok',
            generation: 'current-generation',
            isCurrent: () => true,
          },
        ]]),
      },
      release,
    }));

    await reconcileAgentRuntimeRestartDisposition({
      trackedSessions: [current],
      acquireRegistryLease: acquireRegistryLease as never,
    });

    expect(current.agentRuntimeRestartDisposition).toBe('bridge_authority_unavailable');
    expect(release).toHaveBeenCalledOnce();
  });

  it('retires one exact stale session through the canonical stop owner after fencing every tracked pid', async () => {
    const first = tracked({
      pid: 85855,
      agentRuntimeRestartDisposition: 'bridge_authority_unavailable',
    });
    const sibling = tracked({
      pid: 85856,
      agentRuntimeRestartDisposition: 'bridge_authority_unavailable',
    });
    const trackedSessions = new Map([
      [first.pid, first],
      [sibling.pid, sibling],
    ]);
    const acquireRegistryLease = vi.fn();
    const retireSession = vi.fn(async (sessionId: string) => {
      expect(sessionId).toBe('session-restarted');
      expect(first.agentRuntimeRestartDisposition)
        .toBe('bridge_authority_unavailable');
      expect(sibling.agentRuntimeRestartDisposition)
        .toBe('bridge_authority_unavailable');
      trackedSessions.clear();
      return { status: 'stopped' as const };
    });

    await reconcileAgentRuntimeRestartDisposition({
      trackedSessions: trackedSessions.values(),
      acquireRegistryLease: acquireRegistryLease as never,
      retireSession,
    });

    expect(acquireRegistryLease).not.toHaveBeenCalled();
    expect(retireSession).toHaveBeenCalledTimes(1);
    expect(retireSession).toHaveBeenCalledWith('session-restarted');
    expect(trackedSessions.size).toBe(0);
  });

  it('does not start a second retirement after daemon quiescence begins during the first', async () => {
    let quiescing = false;
    const first = tracked({
      pid: 85855,
      happySessionId: 'session-restarted-first',
      agentRuntimeRestartDisposition: 'bridge_authority_unavailable',
    });
    const second = tracked({
      pid: 85856,
      happySessionId: 'session-restarted-second',
      agentRuntimeRestartDisposition: 'bridge_authority_unavailable',
    });
    const retireSession = vi.fn(async () => {
      quiescing = true;
      return { status: 'stopped' as const };
    });

    const results = await reconcileAgentRuntimeRestartDisposition({
      trackedSessions: [first, second],
      retireSession,
      isShuttingDown: () => quiescing,
    });

    expect(retireSession).toHaveBeenCalledOnce();
    expect(retireSession).toHaveBeenCalledWith('session-restarted-first');
    expect(results).toEqual([{
      sessionId: 'session-restarted-first',
      result: { status: 'stopped' },
    }]);
  });

  it('keeps an incompletely retired restart survivor fenced for a later exact stop or resume retry', async () => {
    const current = tracked();
    const retireSession = vi.fn(async () => ({
      status: 'incomplete' as const,
      reason: 'runner_exit_timeout' as const,
    }));

    await reconcileAgentRuntimeRestartDisposition({
      trackedSessions: [current],
      acquireRegistryLease: (async () => ({
        registry: {
          contributes: { agentDefinitionsById: new Map() },
          agentRuntimesByAgentId: new Map(),
        },
        release: async () => undefined,
      })) as never,
      retireSession,
    });

    expect(retireSession).toHaveBeenCalledOnce();
    expect(current.agentRuntimeRestartDisposition)
      .toBe('bridge_authority_unavailable');
  });

  it('fails closed from durable canonical runtime identity when the successor catalog entry is unavailable', async () => {
    const current = tracked({
      spawnOptions: undefined,
      happySessionMetadataFromLocalWebhook: {
        path: '/workspace',
        host: 'host',
        homeDir: '/home/user',
        happyHomeDir: '/home/user/.happier',
        happyLibDir: '/home/user/.happier/lib',
        happyToolsDir: '/home/user/.happier/tools',
        runtimeDescriptorV1: {
          v: 1,
          agentId: 'grok',
          agent: {},
        },
      } satisfies Metadata,
    });
    await reconcileAgentRuntimeRestartDisposition({
      trackedSessions: [current],
      acquireRegistryLease: (async () => ({
        registry: {
          contributes: { agentDefinitionsById: new Map() },
          agentRuntimesByAgentId: new Map(),
        },
        release: async () => undefined,
      })) as never,
    });

    expect(current.agentRuntimeRestartDisposition)
      .toBe('bridge_authority_unavailable');
  });

  it('leaves a generic reattached runner usable when the current registry has no primary Agent runtime', async () => {
    const generic = tracked({
      spawnOptions: {
        directory: '/workspace',
        backendTarget: {
          kind: 'backend',
          backendId: 'review-bot',
          configuredBackendId: 'review-bot',
          sourceKind: 'configured',
        },
      },
    });
    const retireSession = vi.fn();
    await reconcileAgentRuntimeRestartDisposition({
      trackedSessions: [generic],
      acquireRegistryLease: (async () => ({
        registry: {
          contributes: { agentDefinitionsById: new Map() },
          agentRuntimesByAgentId: new Map(),
        },
        release: async () => undefined,
      })) as never,
      retireSession,
    });

    expect(generic.agentRuntimeRestartDisposition).toBeUndefined();
    expect(retireSession).not.toHaveBeenCalled();
  });
});
