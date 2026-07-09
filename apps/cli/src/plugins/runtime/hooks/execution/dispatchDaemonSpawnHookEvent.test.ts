import { describe, expect, it, vi } from 'vitest';

import type { ResolvedHookRegistration } from '@/plugins/projection/registry/types';

import { dispatchDaemonSpawnHookEvent } from './dispatchDaemonSpawnHookEvent';

function createBackendPrerequisiteHookRegistration(params: Readonly<{
  pluginId: string;
  exportName: string;
  agentIdFilter?: string;
}>): ResolvedHookRegistration {
  return {
    provenance: 'external',
    source: { kind: 'path' },
    pluginId: params.pluginId,
    manifestPath: `/plugins/${params.pluginId}/plugin.json`,
    manifestDigest: `sha256:${params.pluginId}`,
    daemonEntryPath: `/plugins/${params.pluginId}/daemon.mjs`,
    sourceSpec: {
      kind: 'path',
      locator: `/plugins/${params.pluginId}`,
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
    },
    definition: {
      hookApiVersion: 1,
      id: 'agent.resolvePrerequisites',
      category: 'decision',
      scope: 'agent',
      executionKind: 'decide',
      ...(params.agentIdFilter ? { filters: { agentId: params.agentIdFilter } } : {}),
      handler: {
        target: 'plugin',
        exportName: params.exportName,
      },
    },
  };
}

describe('dispatchDaemonSpawnHookEvent', () => {
  it('builds a spawn hook envelope and disposes the executable runtime registry after dispatch', async () => {
    const dispose = vi.fn().mockResolvedValue(undefined);
    const resolveRuntimeRegistry = vi.fn().mockResolvedValue({
      contributes: {
        agentRuntimeDefinitionsById: new Map([
          [
            'codex-localharness',
            {
              agentId: 'codex',
            },
          ],
        ]),
      },
      hookHandlersByHookId: new Map(),
      readHookEventEnvelopeV1: vi.fn(),
      dispose,
    });
    const dispatchEvent = vi.fn().mockResolvedValue({
      eventId: 'agent.spawnEnv.augment',
      matchedHandlerCount: 0,
      outcomes: [],
    });

    await dispatchDaemonSpawnHookEvent({
      happyHomeDir: '/tmp/happy-home',
      event: {
        eventId: 'agent.spawnEnv.augment',
        backendId: 'codex-localharness',
        backendTarget: {
          kind: 'backend',
          backendId: 'codex-localharness',
        },
        cwd: '/repo',
        payload: {
          backendId: 'codex-localharness',
          agentId: 'codex-localharness',
          runtimeSelection: {
            codexBackendMode: 'mcp',
          },
        },
      },
    }, {
      resolveRuntimeRegistry,
      dispatchEvent,
      nowMs: () => 123,
    });

    expect(resolveRuntimeRegistry).toHaveBeenCalledWith({ happyHomeDir: '/tmp/happy-home' });
    expect(dispatchEvent).toHaveBeenCalledWith({
      runtimeRegistry: expect.objectContaining({
        hookHandlersByHookId: expect.any(Map),
      }),
      event: expect.objectContaining({
        hookVersion: 1,
        eventId: 'agent.spawnEnv.augment',
        category: 'augmentation',
        scope: 'daemon',
        agentId: 'codex',
        backendTarget: 'backend:codex-localharness',
        cwd: '/repo',
        timestampMs: 123,
        payload: expect.objectContaining({
          backendId: 'codex-localharness',
          agentId: 'codex',
          runtimeSelection: {
            codexBackendMode: 'mcp',
          },
          runtimeTarget: {
            kind: 'backend',
            backendId: 'codex-localharness',
          },
        }),
      }),
    });
    const dispatchedEvent = dispatchEvent.mock.calls[0]?.[0]?.event;
    expect(dispatchedEvent).not.toHaveProperty('providerId');
    expect(dispatchedEvent).not.toHaveProperty('backendId');
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('fails closed when daemon spawn hook registry acquisition exceeds the dispatch timeout', async () => {
    const resolveRuntimeRegistry = vi.fn(async () => await new Promise<never>(() => {}));
    const dispatchEvent = vi.fn();

    const result = await dispatchDaemonSpawnHookEvent({
      happyHomeDir: '/tmp/happy-home',
      event: {
        eventId: 'agent.resolvePrerequisites',
        backendId: 'codex',
        backendTarget: {
          kind: 'backend',
          backendId: 'codex',
          sourceKind: 'built_in',
        },
        cwd: '/repo',
        payload: {
          backendId: 'codex',
          targetRef: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
          timestampMs: 123,
          cwd: '/repo',
          directory: '/repo',
          runtimeSelection: {
            providerRuntimeSelection: { codexBackendMode: 'appServer' },
          },
        },
      },
    }, {
      resolveRuntimeRegistry,
      dispatchEvent,
      nowMs: () => 123,
      timeoutMs: 5,
    });

    expect(result).toMatchObject({
      eventId: 'agent.resolvePrerequisites',
      matchedHandlerCount: 1,
      outcomes: [
        expect.objectContaining({
          pluginId: 'daemon.spawn-hooks',
          hookId: 'agent.resolvePrerequisites',
          status: 'rejected',
          error: expect.stringContaining('timed out'),
        }),
      ],
      aggregate: {
        executionKind: 'decide',
        result: {
          allowed: false,
        },
      },
    });
    expect(dispatchEvent).not.toHaveBeenCalled();
  });

  it('resolves spawn hook runtime state only for the backend owner and matching global hooks', async () => {
    const dispose = vi.fn().mockResolvedValue(undefined);
    const globalPolicyRegistration = createBackendPrerequisiteHookRegistration({
      pluginId: 'acme.spawn.policy',
      exportName: 'validateAnyBackend',
    });
    const ignoredRegistration = createBackendPrerequisiteHookRegistration({
      pluginId: 'acme.other.backend',
      exportName: 'validateOtherBackend',
      agentIdFilter: 'other',
    });
    const contributes = {
      agentRuntimeDefinitionsById: new Map([
        [
          'codex',
          {
            agentId: 'codex',
            pluginId: 'happier.agent.codex',
          },
        ],
      ]),
      hookRegistrations: Object.freeze([
        globalPolicyRegistration,
        ignoredRegistration,
      ]),
    };
    const resolveContributes = vi.fn().mockResolvedValue(contributes);
    const resolveRuntimeRegistry = vi.fn().mockResolvedValue({
      contributes,
      hookHandlersByHookId: new Map(),
      readHookEventEnvelopeV1: vi.fn(),
      dispose,
    });
    const dispatchEvent = vi.fn().mockResolvedValue({
      eventId: 'agent.resolvePrerequisites',
      matchedHandlerCount: 0,
      outcomes: [],
      aggregate: {
        executionKind: 'decide',
        result: {
          allowed: true,
        },
      },
    });

    await dispatchDaemonSpawnHookEvent({
      happyHomeDir: '/tmp/happy-home',
      event: {
        eventId: 'agent.resolvePrerequisites',
        backendId: 'codex',
        backendTarget: {
          kind: 'backend',
          backendId: 'codex',
          sourceKind: 'built_in',
        },
        cwd: '/repo',
        payload: {
          backendId: 'codex',
          targetRef: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
          timestampMs: 123,
          cwd: '/repo',
          directory: '/repo',
          runtimeSelection: {
            providerRuntimeSelection: { codexBackendMode: 'appServer' },
          },
        },
      },
    }, {
      resolveContributes,
      resolveRuntimeRegistry,
      dispatchEvent,
      nowMs: () => 123,
    });

    expect(resolveRuntimeRegistry).toHaveBeenCalledWith({
      happyHomeDir: '/tmp/happy-home',
      contributes,
      pluginIds: [
        'acme.spawn.policy',
        'happier.agent.codex',
      ],
    });
    expect(dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: expect.objectContaining({
        agentId: 'codex',
      }),
    }));
    const dispatchedEvent = dispatchEvent.mock.calls[0]?.[0]?.event;
    expect(dispatchedEvent).not.toHaveProperty('providerId');
    expect(dispatchedEvent).not.toHaveProperty('backendId');
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
