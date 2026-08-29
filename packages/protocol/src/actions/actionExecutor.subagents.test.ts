import { describe, expect, it, vi } from 'vitest';

import { ActionIdSchema } from './actionIds.js';
import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';

function createDeps(overrides: Partial<ActionExecutorDeps> = {}): ActionExecutorDeps {
  return {
    executionRunStart: vi.fn(async () => ({})),
    executionRunList: vi.fn(async () => ({})),
    executionRunGet: vi.fn(async () => ({})),
    executionRunSend: vi.fn(async () => ({})),
    executionRunStop: vi.fn(async () => ({})),
    executionRunAction: vi.fn(async () => ({})),
    executionRunWait: vi.fn(async () => ({})),
    sessionOpen: vi.fn(async () => ({})),
    sessionFork: vi.fn(async () => ({})),
    sessionRollback: vi.fn(async () => ({})),
    sessionSpawnNew: vi.fn(async () => ({})),
    pathsListRecent: vi.fn(async () => ({ items: [] })),
    machinesList: vi.fn(async () => ({ items: [] })),
    serversList: vi.fn(async () => ({ items: [] })),
    reviewEnginesList: vi.fn(async () => ({ items: [] })),
    agentsBackendsList: vi.fn(async () => ({ items: [] })),
    agentsModelsList: vi.fn(async () => ({ items: [] })),
    sessionSendMessage: vi.fn(async () => ({})),
    sessionPermissionRespond: vi.fn(async () => ({})),
    sessionUserActionAnswer: vi.fn(async () => ({})),
    sessionModeSet: vi.fn(async () => ({})),
    sessionModesList: vi.fn(async () => ({ items: [] })),
    sessionTargetPrimarySet: vi.fn(async () => ({})),
    sessionTargetTrackedSet: vi.fn(async () => ({})),
    sessionList: vi.fn(async () => ({})),
    sessionActivityGet: vi.fn(async () => ({})),
    sessionRecentMessagesGet: vi.fn(async () => ({})),
    resetGlobalVoiceAgent: vi.fn(),
    teleportVoiceAgentToSessionRoot: vi.fn(async () => ({ ok: true })),
    ...overrides,
  };
}

describe('ActionExecutor subagent registry actions', () => {
  it('delegates subagent registry actions through provider-neutral deps and projects valid output', async () => {
    const calls: unknown[] = [];
    const deps = createDeps({
      subagentsList: async (args) => {
        calls.push({ kind: 'list', args });
        return [{
          id: 'subagent-1',
          parentSessionId: args.parentSessionId,
          origin: 'agent' as const,
          kind: 'native' as const,
          agentRef: { agentId: ' codex ' },
          status: 'pending' as const,
          createdAt: 123,
        }];
      },
      subagentsUpsert: async (args) => {
        calls.push({ kind: 'upsert', args });
        return {
          ...args.input,
          status: args.input.status ?? 'pending',
          createdAt: args.input.createdAt ?? 123,
        };
      },
    });
    const executor = createActionExecutor(deps);

    const listResult = await executor.execute(ActionIdSchema.parse('sessions.subagents.list'), {
      parentSessionId: 'session-1',
    }, { surface: 'rpc' });
    const upsertResult = await executor.execute(ActionIdSchema.parse('sessions.subagents.upsert'), {
      id: 'subagent-1',
      parentSessionId: 'session-1',
      origin: 'plugin',
      kind: 'custom',
    }, { surface: 'rpc' });

    expect(listResult).toEqual({
      ok: true,
      result: [{
        id: 'subagent-1',
        parentSessionId: 'session-1',
        origin: 'agent',
        kind: 'native',
        agentRef: { agentId: 'codex' },
        status: 'pending',
        createdAt: 123,
      }],
    });
    expect(upsertResult).toEqual({
      ok: true,
      result: {
        id: 'subagent-1',
        parentSessionId: 'session-1',
        origin: 'plugin',
        kind: 'custom',
        status: 'pending',
        createdAt: 123,
      },
    });
    expect(calls).toEqual([
      { kind: 'list', args: { parentSessionId: 'session-1' } },
      {
        kind: 'upsert',
        args: {
          input: {
            id: 'subagent-1',
            parentSessionId: 'session-1',
            origin: 'plugin',
            kind: 'custom',
          },
          caller: { kind: 'host' },
        },
      },
    ]);
  });

  it('fails closed when a non-runtime subagent producer returns schema-invalid JSON', async () => {
    const executor = createActionExecutor(createDeps({
      // The host dependency is the external boundary under test: this value is JSON-serializable
      // but omits the required provider-neutral subagent fields.
      subagentsList: async () => [{ id: 'subagent-1' }],
    }));

    await expect(executor.execute(ActionIdSchema.parse('sessions.subagents.list'), {
      parentSessionId: 'session-1',
    }, { surface: 'rpc' })).resolves.toEqual({
      ok: false,
      errorCode: 'invalid_action_output',
      error: 'invalid_action_output',
    });
  });

  it('preserves a canonical returned failure envelope instead of classifying it as invalid output', async () => {
    const executor = createActionExecutor(createDeps({
      subagentsList: async () => ({
        ok: false,
        errorCode: 'subagent_store_unavailable',
        error: 'subagent_store_unavailable',
      }),
    }));

    await expect(executor.execute(ActionIdSchema.parse('sessions.subagents.list'), {
      parentSessionId: 'session-1',
    }, { surface: 'rpc' })).resolves.toEqual({
      ok: false,
      errorCode: 'subagent_store_unavailable',
      error: 'subagent_store_unavailable',
    });
  });

  it('surfaces stable subagent mutation authority errors from deps', async () => {
    const deps = createDeps({
      subagentsUpsert: vi.fn(async () => ({
        ok: false,
        errorCode: 'subagent_write_forbidden',
        error: 'subagent_write_forbidden',
      })),
    });
    const executor = createActionExecutor(deps);

    await expect(executor.execute(ActionIdSchema.parse('sessions.subagents.upsert'), {
      id: 'subagent-1',
      parentSessionId: 'session-1',
      origin: 'plugin',
      kind: 'custom',
    }, { surface: 'rpc' })).resolves.toEqual({
      ok: false,
      errorCode: 'subagent_write_forbidden',
      error: 'subagent_write_forbidden',
    });
  });

  it('allows subagent reads and rejects lifecycle mutations on the Plugin surface', async () => {
    const list = vi.fn(async () => []);
    const get = vi.fn(async () => null);
    const watch = vi.fn(async () => ({ kind: 'snapshot' as const, subagents: [] }));
    const upsert = vi.fn(async (_args: unknown) => ({}));
    const updateStatus = vi.fn(async (_args: unknown) => ({}));
    const complete = vi.fn(async (_args: unknown) => ({}));
    const executor = createActionExecutor(createDeps({
      subagentsList: list,
      subagentsGet: get,
      subagentsWatch: watch,
      subagentsUpsert: upsert,
      subagentsUpdateStatus: updateStatus,
      subagentsComplete: complete,
    }));
    const caller = {
      kind: 'plugin' as const,
      pluginId: 'happier.agent.acme',
      contributionLocalId: 'acme.sample',
    };
    const context = { surface: 'plugin' as const, actionCaller: caller };
    const upsertInput = {
      id: 'subagent-1',
      parentSessionId: 'other-session',
      origin: 'agent' as const,
      kind: 'native' as const,
      agentRef: { agentId: 'acme.sample' },
    };
    const updateInput = {
      id: 'subagent-1',
      parentSessionId: 'other-session',
      status: 'running' as const,
    };
    const completeInput = {
      id: 'subagent-1',
      parentSessionId: 'other-session',
      status: 'completed' as const,
    };

    for (const [actionId, input] of [
      ['sessions.subagents.list', { parentSessionId: 'other-session' }],
      ['sessions.subagents.get', { id: 'subagent-1', parentSessionId: 'other-session' }],
      ['sessions.subagents.watch', { id: 'subagent-1', parentSessionId: 'other-session' }],
    ] as const) {
      await expect(executor.execute(ActionIdSchema.parse(actionId), input, context))
        .resolves.toMatchObject({ ok: true });
    }

    for (const [actionId, input] of [
      ['sessions.subagents.upsert', upsertInput],
      ['sessions.subagents.updateStatus', updateInput],
      ['sessions.subagents.complete', completeInput],
    ] as const) {
      await expect(executor.execute(ActionIdSchema.parse(actionId), input, context))
        .resolves.toMatchObject({
          ok: false,
          errorCode: 'action_disabled',
          details: { reason: 'unsupported_surface', surface: 'plugin' },
        });
    }

    expect(list).toHaveBeenCalledOnce();
    expect(get).toHaveBeenCalledOnce();
    expect(watch).toHaveBeenCalledOnce();
    expect(upsert).not.toHaveBeenCalled();
    expect(updateStatus).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  it('allows subagent reads and rejects lifecycle mutations on the API surface', async () => {
    const list = vi.fn(async () => []);
    const get = vi.fn(async () => null);
    const watch = vi.fn(async () => ({ kind: 'snapshot' as const, subagents: [] }));
    const upsert = vi.fn(async (_args: unknown) => ({}));
    const updateStatus = vi.fn(async (_args: unknown) => ({}));
    const complete = vi.fn(async (_args: unknown) => ({}));
    const executor = createActionExecutor(createDeps({
      subagentsList: list,
      subagentsGet: get,
      subagentsWatch: watch,
      subagentsUpsert: upsert,
      subagentsUpdateStatus: updateStatus,
      subagentsComplete: complete,
    }));
    const context = { surface: 'api' as const, authority: 'account_automation' as const };

    for (const [actionId, input] of [
      ['sessions.subagents.list', { parentSessionId: 'other-session' }],
      ['sessions.subagents.get', { id: 'subagent-1', parentSessionId: 'other-session' }],
      ['sessions.subagents.watch', { id: 'subagent-1', parentSessionId: 'other-session' }],
    ] as const) {
      await expect(executor.execute(ActionIdSchema.parse(actionId), input, context))
        .resolves.toMatchObject({ ok: true });
    }

    for (const [actionId, input] of [
      ['sessions.subagents.upsert', {
        id: 'subagent-1',
        parentSessionId: 'other-session',
        origin: 'agent' as const,
        kind: 'native' as const,
        agentRef: { agentId: 'acme.sample' },
      }],
      ['sessions.subagents.updateStatus', {
        id: 'subagent-1',
        parentSessionId: 'other-session',
        status: 'running' as const,
      }],
      ['sessions.subagents.complete', {
        id: 'subagent-1',
        parentSessionId: 'other-session',
        status: 'completed' as const,
      }],
    ] as const) {
      await expect(executor.execute(ActionIdSchema.parse(actionId), input, context))
        .resolves.toMatchObject({
          ok: false,
          errorCode: 'action_disabled',
          details: { reason: 'unsupported_surface', surface: 'api' },
        });
    }

    expect(list).toHaveBeenCalledOnce();
    expect(get).toHaveBeenCalledOnce();
    expect(watch).toHaveBeenCalledOnce();
    expect(upsert).not.toHaveBeenCalled();
    expect(updateStatus).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  it('uses the default session id and forwards limit for subagent read actions', async () => {
    const calls: unknown[] = [];
    const deps = createDeps({
      subagentsList: vi.fn(async (args) => {
        calls.push({ kind: 'list', args });
        return [];
      }),
      subagentsGet: vi.fn(async (args) => {
        calls.push({ kind: 'get', args });
        return null;
      }),
      subagentsWatch: vi.fn(async (args) => {
        calls.push({ kind: 'watch', args });
        return { kind: 'snapshot', subagents: [] };
      }),
    });
    const executor = createActionExecutor(deps);

    await executor.execute(ActionIdSchema.parse('sessions.subagents.list'), {
      limit: 2,
    }, { surface: 'rpc', defaultSessionId: 'session-1' });
    await executor.execute(ActionIdSchema.parse('sessions.subagents.get'), {
      id: 'subagent-1',
    }, { surface: 'rpc', defaultSessionId: 'session-1' });
    await executor.execute(ActionIdSchema.parse('sessions.subagents.watch'), {
      id: 'subagent-1',
    }, { surface: 'rpc', defaultSessionId: 'session-1' });

    expect(calls).toEqual([
      { kind: 'list', args: { parentSessionId: 'session-1', limit: 2 } },
      { kind: 'get', args: { id: 'subagent-1', parentSessionId: 'session-1' } },
      { kind: 'watch', args: { id: 'subagent-1', parentSessionId: 'session-1' } },
    ]);
  });
});
