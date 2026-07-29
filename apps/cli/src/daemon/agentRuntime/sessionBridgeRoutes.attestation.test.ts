import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentSessionRuntime,
  AgentSessionRuntimeFactory,
} from '@happier-dev/plugin-sdk/agent-runtime';

const runtimeLeaseMock = vi.hoisted(() => ({
  acquire: vi.fn(),
}));

vi.mock('@/plugins/runtime/reload/runtimeLease', () => ({
  acquireAuthoritativePluginRuntimeRegistryLease: runtimeLeaseMock.acquire,
}));

import { createAgentRuntimeSessionBridgeRoutes } from './sessionBridgeRoutes';

describe('daemon Agent runtime session-open attestation', () => {
  beforeEach(() => {
    runtimeLeaseMock.acquire.mockReset();
  });

  it('reports only the exact request whose sessions.open call completed', async () => {
    let settleOpen = (_runtime: AgentSessionRuntime): void => {
      throw new Error('Agent runtime open promise was not initialized');
    };
    const openCompletion = new Promise<AgentSessionRuntime>((resolve) => {
      settleOpen = resolve;
    });
    const open = vi.fn<AgentSessionRuntimeFactory['open']>(
      async () => await openCompletion,
    );
    const resolveTerminalLaunch = vi.fn(async () => ({
      argv: ['agy', '--terminal'],
    }));
    runtimeLeaseMock.acquire.mockResolvedValue({
      registry: {
        permissionsByPluginId: new Map([['happier.agent.grok', new Set<string>()]]),
        runtimeCapabilitiesByPluginId: new Map([['happier.agent.grok', new Set<string>()]]),
        agentRuntimesByAgentId: new Map([['grok', {
          hasPrimaryRuntime: true,
          pluginId: 'happier.agent.grok',
          pluginVersion: '1.2.3',
          agentId: 'grok',
          generation: 'generation-attestation',
          isCurrent: () => true,
          retirementSignal: new AbortController().signal,
          createRuntime: async () => ({
            sessions: { open },
            surfaces: {
              terminal: {
                resolveLaunch: resolveTerminalLaunch,
              },
            },
          }),
        }]]),
        createAgentInvocationServices: () => Object.freeze({}),
      },
      release: vi.fn(async () => undefined),
    });
    const routes = createAgentRuntimeSessionBridgeRoutes();
    const descriptor = {
      v: 1 as const,
      pluginId: 'happier.agent.grok',
      pluginVersion: '1.2.3',
      agentId: 'grok',
      backendId: 'grok',
      generation: 'generation-attestation',
      runtimeAuthority: {
        permissions: [],
        runtimeCapabilities: [],
      },
      runtimeSurfaces: {
        terminal: true,
      },
      factoryControls: {
        continuation: false,
        goals: false,
        catalog: false,
        usageLimitRecovery: false,
      },
    };
    const request = {
      kind: 'fork' as const,
      sessionId: 'session-native-fork',
      cwd: '/child',
      source: {
        sessionId: 'session-parent',
        providerSessionId: 'provider-parent',
        cwd: '/parent',
        target: {
          turnId: 'turn-7',
          providerCheckpoint: { kind: 'prompt_index', promptIndex: 7 },
        },
      },
    };
    const context = {
      token: 'bridge-token',
      sessionId: request.sessionId,
      pluginId: descriptor.pluginId,
      agentId: descriptor.agentId,
      generation: descriptor.generation,
    };

    await expect(routes.dispatch({
      v: 1,
      context,
      operation: {
        kind: 'factory.prepare',
        requestId: 'prepare-attestation',
        descriptor,
        request,
      },
    })).resolves.toMatchObject({ ok: true });
    const opening = routes.dispatch({
      v: 1,
      context,
      operation: {
        kind: 'session.open',
        requestId: 'open-attestation',
        descriptor,
        request,
        featureDecisions: {},
      },
    });

    await expect(routes.awaitAgentSessionOpen({
      sessionId: request.sessionId,
      timeoutMs: 0,
    })).resolves.toEqual({ status: 'timeout' });

    settleOpen({
      send: async () => ({ status: 'admitted' }),
      watch: () => ({ dispose() {} }),
      async dispose() {},
    });
    await expect(opening).resolves.toMatchObject({ ok: true });
    await expect(routes.awaitAgentSessionOpen({
      sessionId: request.sessionId,
      timeoutMs: 0,
    })).resolves.toEqual({
      status: 'opened',
      request,
    });
    await expect(routes.dispatch({
      v: 1,
      context,
      operation: {
        kind: 'runtime.terminal.resolveLaunch',
        requestId: 'terminal-launch-attestation',
        request: {
          sessionId: request.sessionId,
          cwd: request.cwd,
          metadata: { providerSessionId: 'provider-parent' },
        },
      },
    })).resolves.toEqual({
      ok: true,
      result: {
        argv: ['agy', '--terminal'],
      },
    });
    expect(resolveTerminalLaunch).toHaveBeenCalledWith({
      sessionId: request.sessionId,
      cwd: request.cwd,
      metadata: { providerSessionId: 'provider-parent' },
    });
  });
});
