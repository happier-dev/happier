import { beforeEach, describe, expect, it, vi } from 'vitest';

const runtimeLeaseMock = vi.hoisted(() => ({
  acquire: vi.fn(),
}));

vi.mock('@/plugins/runtime/reload/runtimeLease', () => ({
  acquireAuthoritativePluginRuntimeRegistryLease: runtimeLeaseMock.acquire,
}));

import { createAgentRuntimeSessionBridgeRoutes } from './sessionBridgeRoutes';

describe('daemon Agent runtime carrier authority attestation', () => {
  beforeEach(() => {
    runtimeLeaseMock.acquire.mockReset();
  });

  it.each([
    {
      name: 'widened',
      runtimeAuthority: {
        permissions: ['process.spawn', 'session.hooks.control'],
        runtimeCapabilities: ['sessionHooks'],
      },
    },
    {
      name: 'narrowed',
      runtimeAuthority: {
        permissions: [],
        runtimeCapabilities: ['sessionHooks'],
      },
    },
    {
      name: 'capability-only widened',
      runtimeAuthority: {
        permissions: ['session.hooks.control'],
        runtimeCapabilities: ['agents', 'sessionHooks'],
      },
    },
    {
      name: 'capability-only narrowed',
      runtimeAuthority: {
        permissions: ['session.hooks.control'],
        runtimeCapabilities: [],
      },
    },
    {
      name: 'missing',
      runtimeAuthority: undefined,
    },
  ] as const)(
    'rejects $name carrier authority before runtime construction or effects',
    async ({ runtimeAuthority }) => {
      const createRuntime = vi.fn(async () => ({
        sessions: {
          open: async () => {
            throw new Error('session open must not be reached');
          },
        },
      }));
      const createAgentInvocationServices = vi.fn(() => Object.freeze({}));
      const release = vi.fn(async () => undefined);
      runtimeLeaseMock.acquire.mockResolvedValue({
        registry: {
          agentRuntimesByAgentId: new Map([['grok', {
            hasPrimaryRuntime: true,
            pluginId: 'happier.agent.grok',
            pluginVersion: '1.2.3',
            agentId: 'grok',
            generation: 'generation-authority',
            isCurrent: () => true,
            retirementSignal: new AbortController().signal,
            createRuntime,
          }]]),
          permissionsByPluginId: new Map([[
            'happier.agent.grok',
            new Set(['session.hooks.control']),
          ]]),
          runtimeCapabilitiesByPluginId: new Map([[
            'happier.agent.grok',
            new Set(['sessionHooks']),
          ]]),
          createAgentInvocationServices,
        },
        release,
      });
      const descriptor = {
        v: 1 as const,
        pluginId: 'happier.agent.grok',
        pluginVersion: '1.2.3',
        agentId: 'grok',
        backendId: 'grok',
        generation: 'generation-authority',
        ...(runtimeAuthority ? { runtimeAuthority } : {}),
        factoryControls: {
          continuation: false,
          goals: false,
          catalog: false,
          usageLimitRecovery: false,
        },
      };
      const routes = createAgentRuntimeSessionBridgeRoutes();

      try {
        await expect(routes.dispatch({
          v: 1,
          context: {
            token: 'bridge-token',
            sessionId: `session-authority-${runtimeAuthority ? 'different' : 'missing'}`,
            pluginId: descriptor.pluginId,
            agentId: descriptor.agentId,
            generation: descriptor.generation,
          },
          operation: {
            kind: 'factory.prepare',
            requestId: 'prepare-authority-attestation',
            descriptor,
            request: {
              kind: 'create',
              sessionId: `session-authority-${runtimeAuthority ? 'different' : 'missing'}`,
              cwd: '/workspace',
            },
          },
        } as never)).resolves.toMatchObject({ ok: false });
        expect(createRuntime).not.toHaveBeenCalled();
        expect(createAgentInvocationServices).not.toHaveBeenCalled();
        expect(release).toHaveBeenCalledOnce();
      } finally {
        await routes.dispose();
      }
    },
  );
});
