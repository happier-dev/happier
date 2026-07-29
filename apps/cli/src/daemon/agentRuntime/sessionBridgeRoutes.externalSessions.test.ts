import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type {
  AgentSessionRuntimeContext,
  AgentSessionRuntimeFactory,
} from '@happier-dev/plugin-sdk/agent-runtime';

import { createExternalSessionHostOperationOwner } from '@/session/external/hostOperationOwner';

const runtimeLeaseMock = vi.hoisted(() => ({
  acquire: vi.fn(),
}));
const controlClientMock = vi.hoisted(() => ({
  dispatch: vi.fn(),
}));

vi.mock('@/plugins/runtime/reload/runtimeLease', () => ({
  acquireAuthoritativePluginRuntimeRegistryLease: runtimeLeaseMock.acquire,
}));
vi.mock('@/daemon/controlClient', () => ({
  dispatchDaemonAgentRuntimeBridgeRequest: controlClientMock.dispatch,
}));

import { tryCreateDaemonAgentRuntimeCarrier } from '@/agent/runtime/session/process/agentRuntimeDaemonBridgeClient';
import { HAPPIER_AGENT_RUNTIME_DAEMON_BRIDGE_TOKEN_FILE_ENV_KEY } from '@/agent/runtime/session/process/agentRuntimeDaemonBridgeProtocol';
import { createAgentRuntimeSessionBridgeRoutes } from './sessionBridgeRoutes';

describe('daemon Agent runtime External Session operation bridge', () => {
  it('binds after authoritative open and retains one follow effect until the child acknowledges it', async () => {
    const owner = createExternalSessionHostOperationOwner();
    const takeover = vi.fn(async () => ({
      sessionId: 'linked-session-1',
      status: 'takenOver' as const,
    }));
    let disposeFollowAttempts = 0;
    const disposeFollow = vi.fn(async () => {
      disposeFollowAttempts += 1;
      if (disposeFollowAttempts === 1) {
        throw new Error('source follow dispose failed');
      }
    });
    const disposeRetiringFollow = vi.fn(async () => {
      throw new Error('retiring source follow dispose failed');
    });
    const disposeProvisionalFollow = vi.fn(async () => undefined);
    let emitFollowEvent!: () => Promise<void>;
    let resolveProvisionalFollow!: (value: {
      status: 'following';
      startingCursor: null;
      subscription: { dispose(): Promise<void> };
    }) => void;
    let markProvisionalFollowStarted!: () => void;
    const provisionalFollowStarted = new Promise<void>((resolve) => {
      markProvisionalFollowStarted = resolve;
    });
    const provisionalFollowResult = new Promise<{
      status: 'following';
      startingCursor: null;
      subscription: { dispose(): Promise<void> };
    }>((resolve) => {
      resolveProvisionalFollow = resolve;
    });
    const follow = vi.fn(async (request) => {
      if (request.ref.remoteSessionId === 'remote-session-retiring') {
        return {
          status: 'following' as const,
          startingCursor: null,
          subscription: { dispose: disposeRetiringFollow },
        };
      }
      if (request.ref.remoteSessionId === 'remote-session-provisional') {
        markProvisionalFollowStarted();
        return await provisionalFollowResult;
      }
      emitFollowEvent = async () => await request.listener({
        kind: 'data',
        items: [{
          id: 'item-1',
          kind: 'agent',
          data: { text: 'hello' },
        }],
        fromCursor: null,
        nextCursor: 'cursor-1',
      });
      return {
        status: 'following' as const,
        startingCursor: null,
        subscription: { dispose: disposeFollow },
      };
    });
    const installation = await owner.install({
      takeoverOperation: { execute: takeover },
      followOperation: { execute: follow },
    });
    const disposeRuntime = vi.fn(async () => undefined);
    const open = vi.fn<AgentSessionRuntimeFactory['open']>(async () => ({
      send: async () => ({ status: 'admitted' }),
      watch: () => ({ dispose() {} }),
      dispose: disposeRuntime,
    }));
    const release = vi.fn(async () => undefined);
    const retirement = new AbortController();
    runtimeLeaseMock.acquire.mockResolvedValue({
      registry: {
        permissionsByPluginId: new Map([['happier.agent.codex', new Set<string>()]]),
        runtimeCapabilitiesByPluginId: new Map([['happier.agent.codex', new Set<string>()]]),
        agentRuntimesByAgentId: new Map([['codex', {
          hasPrimaryRuntime: true,
          pluginId: 'happier.agent.codex',
          pluginVersion: '1.2.3',
          agentId: 'codex',
          generation: 'generation-1',
          isCurrent: () => true,
          retirementSignal: retirement.signal,
          createRuntime: async () => ({ sessions: { open } }),
        }]]),
        createAgentInvocationServices: () => Object.freeze({}),
      },
      release,
    });
    const routes = createAgentRuntimeSessionBridgeRoutes({
      externalSessionHostOperationOwner: owner,
      externalSessionHostBindingContext: {
        machineId: 'machine-1',
        readAccountRevision: () => 'account-revision-1',
      },
    });
    const descriptor = {
      v: 1 as const,
      pluginId: 'happier.agent.codex',
      pluginVersion: '1.2.3',
      agentId: 'codex',
      backendId: 'codex',
      generation: 'generation-1',
      runtimeAuthority: { permissions: [], runtimeCapabilities: [] },
      factoryControls: {
        continuation: false,
        goals: false,
        catalog: false,
        usageLimitRecovery: false,
      },
    };
    const context = {
      token: 'bridge-token',
      sessionId: 'session-1',
      pluginId: descriptor.pluginId,
      agentId: descriptor.agentId,
      generation: descriptor.generation,
    };
    const request = {
      kind: 'create' as const,
      sessionId: context.sessionId,
      cwd: '/workspace',
    };
    const ref = {
      agentId: 'codex',
      sourceId: 'default',
      remoteSessionId: 'remote-session-1',
    };
    const source = { kind: 'codexHome' as const, home: 'user' as const };

    await expect(routes.dispatch({
      v: 1,
      context,
      operation: {
        kind: 'factory.prepare',
        requestId: 'prepare-1',
        descriptor,
        request,
      },
    })).resolves.toMatchObject({ ok: true });
    await expect(routes.dispatch({
      v: 1,
      context,
      operation: {
        kind: 'session.open',
        requestId: 'open-1',
        descriptor,
        request,
        featureDecisions: {},
      },
    })).resolves.toMatchObject({ ok: true });
    await expect(routes.dispatch({
      v: 1,
      context,
      operation: {
        kind: 'session.externalSession.takeover',
        requestId: 'takeover-1',
        ref,
        source,
      },
    })).resolves.toEqual({
      ok: true,
      result: { sessionId: 'linked-session-1', status: 'takenOver' },
    });
    expect(takeover).toHaveBeenCalledWith(expect.objectContaining({
      pluginId: descriptor.pluginId,
      contributionId: descriptor.agentId,
      generationId: descriptor.generation,
      sessionId: context.sessionId,
      machineId: 'machine-1',
      ref,
      source,
    }));

    await expect(routes.dispatch({
      v: 1,
      context,
      operation: {
        kind: 'session.externalSession.follow.open',
        requestId: 'follow-open-1',
        followId: 'follow-1',
        ref,
        source,
      },
    })).resolves.toEqual({
      ok: true,
      result: { status: 'following', startingCursor: null },
    });
    const delivery = emitFollowEvent();
    const firstPoll = await routes.dispatch({
      v: 1,
      context,
      operation: {
        kind: 'channel.poll',
        requestId: 'poll-follow-1',
        afterSequence: -1,
      },
    });
    const secondPoll = await routes.dispatch({
      v: 1,
      context,
      operation: {
        kind: 'channel.poll',
        requestId: 'poll-follow-redelivery',
        afterSequence: -1,
      },
    });
    if (!firstPoll.ok || !secondPoll.ok) throw new Error('Expected follow effects');
    const firstEffect = (
      firstPoll.result as { effects: Array<{ effectId: string; kind: string }> }
    ).effects[0];
    const secondEffect = (
      secondPoll.result as { effects: Array<{ effectId: string; kind: string }> }
    ).effects[0];
    expect(firstEffect).toMatchObject({
      kind: 'session.externalSession.follow.event',
    });
    expect(secondEffect).toEqual(firstEffect);
    await routes.dispatch({
      v: 1,
      context,
      operation: {
        kind: 'effect.complete',
        requestId: 'complete-follow-event',
        effectId: firstEffect!.effectId,
        result: null,
      },
    });
    await delivery;

    await expect(routes.dispatch({
      v: 1,
      context,
      operation: {
        kind: 'session.externalSession.follow.close',
        requestId: 'follow-close-1',
        followId: 'follow-1',
      },
    })).resolves.toMatchObject({
      ok: false,
      error: {
        code: 'agent_runtime_daemon_bridge_failed',
        message: 'source follow dispose failed',
      },
    });
    expect(disposeFollow).toHaveBeenCalledOnce();
    await expect(routes.dispatch({
      v: 1,
      context,
      operation: {
        kind: 'session.externalSession.follow.close',
        requestId: 'follow-close-dispose-retry',
        followId: 'follow-1',
      },
    })).resolves.toEqual({ ok: true, result: null });
    expect(disposeFollow).toHaveBeenCalledTimes(2);
    await expect(routes.dispatch({
      v: 1,
      context,
      operation: {
        kind: 'session.externalSession.follow.close',
        requestId: 'follow-close-lost-ack-retry',
        followId: 'follow-1',
      },
    })).resolves.toMatchObject({ ok: true });
    expect(disposeFollow).toHaveBeenCalledTimes(2);

    const provisionalOpen = routes.dispatch({
      v: 1,
      context,
      operation: {
        kind: 'session.externalSession.follow.open',
        requestId: 'follow-open-provisional',
        followId: 'follow-provisional',
        ref: {
          ...ref,
          remoteSessionId: 'remote-session-provisional',
        },
        source,
      },
    });
    await provisionalFollowStarted;
    await expect(routes.dispatch({
      v: 1,
      context,
      operation: {
        kind: 'session.externalSession.follow.close',
        requestId: 'follow-close-provisional',
        followId: 'follow-provisional',
      },
    })).resolves.toMatchObject({ ok: true });
    resolveProvisionalFollow({
      status: 'following',
      startingCursor: null,
      subscription: { dispose: disposeProvisionalFollow },
    });
    await expect(provisionalOpen).resolves.toEqual({
      ok: true,
      result: {
        status: 'unavailable',
        code: 'plugin_operation_aborted',
      },
    });
    expect(disposeProvisionalFollow).toHaveBeenCalledOnce();

    await expect(routes.dispatch({
      v: 1,
      context,
      operation: {
        kind: 'session.externalSession.follow.open',
        requestId: 'follow-open-retiring',
        followId: 'follow-retiring',
        ref: {
          ...ref,
          remoteSessionId: 'remote-session-retiring',
        },
        source,
      },
    })).resolves.toMatchObject({ ok: true });
    await expect(routes.dispatch({
      v: 1,
      context,
      operation: {
        kind: 'session.externalSession.follow.close',
        requestId: 'follow-close-retiring-rejects',
        followId: 'follow-retiring',
      },
    })).resolves.toMatchObject({
      ok: false,
      error: {
        code: 'agent_runtime_daemon_bridge_failed',
        message: 'retiring source follow dispose failed',
      },
    });
    expect(disposeRetiringFollow).toHaveBeenCalledOnce();

    retirement.abort('test retirement');
    await vi.waitFor(() => {
      expect(disposeRuntime).toHaveBeenCalledOnce();
    });
    expect(disposeRetiringFollow).toHaveBeenCalledTimes(2);

    await routes.dispose();
    expect(disposeRetiringFollow).toHaveBeenCalledTimes(2);
    await installation.dispose();
    await owner.retire();
  });

  it('composes the real child carrier with the authenticated daemon route for takeover and follow', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-external-session-bridge-'));
    const tokenFilePath = join(root, 'handoff.json');
    const descriptor = {
      v: 1 as const,
      pluginId: 'happier.agent.codex',
      pluginVersion: '1.2.3',
      agentId: 'codex',
      backendId: 'codex',
      generation: 'generation-composed',
      runtimeAuthority: { permissions: [], runtimeCapabilities: [] },
      factoryControls: {
        continuation: false,
        goals: false,
        catalog: false,
        usageLimitRecovery: false,
      },
    };
    await writeFile(tokenFilePath, JSON.stringify({
      v: 1,
      token: 'bridge-token-composed',
      descriptor,
    }), 'utf8');
    const owner = createExternalSessionHostOperationOwner();
    const takeover = vi.fn(async () => ({
      sessionId: 'linked-session-composed',
      status: 'takenOver' as const,
    }));
    const disposeFollow = vi.fn(async () => undefined);
    let emitFollowEvent!: () => Promise<void>;
    const follow = vi.fn(async (request) => {
      emitFollowEvent = async () => await request.listener({
        kind: 'data',
        items: [{
          id: 'item-composed',
          kind: 'agent',
          data: { text: 'composed' },
        }],
        fromCursor: null,
        nextCursor: 'cursor-composed',
      });
      return {
        status: 'following' as const,
        startingCursor: null,
        subscription: { dispose: disposeFollow },
      };
    });
    const installation = await owner.install({
      takeoverOperation: { execute: takeover },
      followOperation: { execute: follow },
    });
    const open = vi.fn<AgentSessionRuntimeFactory['open']>(async () => ({
      send: async () => ({ status: 'admitted' }),
      watch: () => ({ dispose() {} }),
      async dispose() {},
    }));
    const retirement = new AbortController();
    runtimeLeaseMock.acquire.mockResolvedValue({
      registry: {
        permissionsByPluginId: new Map([[descriptor.pluginId, new Set<string>()]]),
        runtimeCapabilitiesByPluginId: new Map([[descriptor.pluginId, new Set<string>()]]),
        agentRuntimesByAgentId: new Map([[descriptor.agentId, {
          hasPrimaryRuntime: true,
          pluginId: descriptor.pluginId,
          pluginVersion: descriptor.pluginVersion,
          agentId: descriptor.agentId,
          generation: descriptor.generation,
          isCurrent: () => true,
          retirementSignal: retirement.signal,
          createRuntime: async () => ({ sessions: { open } }),
        }]]),
        createAgentInvocationServices: () => Object.freeze({}),
      },
      release: async () => undefined,
    });
    const routes = createAgentRuntimeSessionBridgeRoutes({
      externalSessionHostOperationOwner: owner,
      externalSessionHostBindingContext: {
        machineId: 'machine-composed',
        readAccountRevision: () => 'account-composed',
      },
    });
    controlClientMock.dispatch.mockImplementation(async (request) =>
      await routes.dispatch(request));
    const carrier = tryCreateDaemonAgentRuntimeCarrier({
      [HAPPIER_AGENT_RUNTIME_DAEMON_BRIDGE_TOKEN_FILE_ENV_KEY]: tokenFilePath,
    });
    if (!carrier?.runtime.sessions) {
      throw new Error('Expected composed daemon Agent runtime carrier');
    }
    const runtimeContext = {
      signal: new AbortController().signal,
      session: {
        services: {
          features: { isEnabled: () => false },
        },
      },
    } as unknown as AgentSessionRuntimeContext;
    const sessionId = 'session-composed';
    const runtime = await carrier.runtime.sessions.open({
      kind: 'create',
      sessionId,
      cwd: root,
    }, runtimeContext);
    const port = carrier.externalSessionHostOperations.bindSession(sessionId);
    const ref = {
      agentId: descriptor.agentId,
      sourceId: 'default',
      remoteSessionId: 'remote-composed',
    };
    const source = { kind: 'codexHome' as const, home: 'user' as const };
    const listener = vi.fn(async () => undefined);

    try {
      await expect(port.executeTakeover({ ref, source })).resolves.toEqual({
        sessionId: 'linked-session-composed',
        status: 'takenOver',
      });
      const result = await port.executeFollow({
        ref,
        source,
        options: {},
        listener,
      });
      expect(result).toMatchObject({
        status: 'following',
        startingCursor: null,
      });
      await emitFollowEvent();
      expect(listener).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'data',
        nextCursor: 'cursor-composed',
      }));
      if (result.status === 'following') await result.subscription.dispose();
      await vi.waitFor(() => expect(disposeFollow).toHaveBeenCalledOnce());
      expect(takeover).toHaveBeenCalledOnce();
      expect(follow).toHaveBeenCalledOnce();
    } finally {
      await port.retire();
      await runtime.dispose('session_closed');
      await routes.dispose();
      await installation.dispose();
      await owner.retire();
      await rm(root, { recursive: true, force: true });
    }
  });
});
