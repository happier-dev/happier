const { activeRuntimeRegistryState } = vi.hoisted(() => ({
  activeRuntimeRegistryState: {
    registry: null as ReturnType<typeof createResolvedContributionRegistry> | null,
    catalogPolicyOutcome: 'visible' as 'visible' | 'denied',
  },
}));

vi.mock('@/plugins/runtime/reload/singleton', () => ({
  pluginReloadController: {
    getState: () => ({
      generation: 1,
      activeRegistry: activeRuntimeRegistryState.registry
        ? {
            contributes: activeRuntimeRegistryState.registry,
            targetActionInvocations: {
              evaluateCatalogPolicy: () => ({
                outcome: activeRuntimeRegistryState.catalogPolicyOutcome,
                code: activeRuntimeRegistryState.catalogPolicyOutcome === 'visible'
                  ? 'plugin_action_available'
                  : 'plugin_action_generation_retired',
                requiresCurrentIntent: false,
              }),
            },
          }
        : null,
      lastResult: null,
    }),
    isRuntimeRegistryCurrent: () => true,
  },
}));

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol';

import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';

import { listBuiltInHappierTools } from './listBuiltInHappierTools';
import { dispatchBuiltInHappierTool } from './dispatchBuiltInHappierTool';
import type { HappierBuiltInToolDispatchResult } from './types';

function ok(result: unknown): HappierBuiltInToolDispatchResult {
  return { ok: true, result };
}

function unsupported(): HappierBuiltInToolDispatchResult {
  return { ok: false, errorCode: 'unsupported', error: 'unsupported' };
}

function expectActionDisabled(result: HappierBuiltInToolDispatchResult): void {
  expect(result).toMatchObject({
    ok: false,
    errorCode: 'action_disabled',
    error: 'Action is disabled',
  });
}

function useActiveResolvedContributionRegistry(
  input: Parameters<typeof createResolvedContributionRegistry>[0],
  catalogPolicyOutcome: 'visible' | 'denied' = 'visible',
) {
  const registry = createResolvedContributionRegistry(input);
  activeRuntimeRegistryState.registry = registry;
  activeRuntimeRegistryState.catalogPolicyOutcome = catalogPolicyOutcome;
  return registry;
}

describe('built-in Happier tools', () => {
  beforeEach(() => {
    activeRuntimeRegistryState.registry = null;
    activeRuntimeRegistryState.catalogPolicyOutcome = 'visible';
  });

  it('lists the default session-agent direct bootstrap tools from the shared catalog', () => {
    const names = listBuiltInHappierTools().map((tool) => tool.name);

    expect(names).toContain('change_title');
    expect(names).toContain('action_spec_search');
    expect(names).toContain('action_spec_get');
    expect(names).toContain('action_options_resolve');
    expect(names).toContain('action_execute');
    expect(names).toContain('plugins_reload');
    expect(names).not.toContain('review_start');
    expect(names).not.toContain('subagents_plan_start');
    expect(names).not.toContain('subagents_delegate_start');
  });

  it('dispatches change_title through the injected title updater', async () => {
    const changeTitle = vi.fn(async (_sessionId: string, title: string) => ({ success: true, title }));

    const result = await dispatchBuiltInHappierTool({
      toolName: 'change_title',
      args: { title: 'New title' },
      sessionId: 'sess-1',
      deps: {
        changeTitle,
        executeActionByToolName: async () => unsupported(),
      },
    });

    expect(changeTitle).toHaveBeenCalledWith('sess-1', 'New title');
    expect(result).toEqual({ ok: true, result: { success: true, title: 'New title' } });
  });

  it('surfaces change_title failures as tool errors', async () => {
    const result = await dispatchBuiltInHappierTool({
      toolName: 'change_title',
      args: { title: 'New title' },
      sessionId: 'sess-1',
      deps: {
        changeTitle: async () => ({ success: false, error: 'update failed' }),
        executeActionByToolName: async () => unsupported(),
      },
    });

    expect(result).toEqual({
      ok: false,
      errorCode: 'change_title_failed',
      error: 'update failed',
    });
  });

  it('rejects change_title when the equivalent session.title.set action is disabled', async () => {
    const changeTitle = vi.fn(async () => ({ success: true, title: 'New title' }));

    const result = await dispatchBuiltInHappierTool({
      toolName: 'change_title',
      args: { title: 'New title' },
      sessionId: 'sess-1',
      surface: 'cli',
      deps: {
        changeTitle,
        executeActionByToolName: async () => unsupported(),
        isActionEnabled: (id) => id !== 'session.title.set',
      },
    });

    expectActionDisabled(result);
    expect(changeTitle).not.toHaveBeenCalled();
  });

  it('rejects change_title when session title updates are discoverable-only', async () => {
    const changeTitle = vi.fn(async () => ({ success: true, title: 'New title' }));

    const result = await dispatchBuiltInHappierTool({
      toolName: 'change_title',
      args: { title: 'New title' },
      sessionId: 'sess-1',
      surface: 'agent',
      actionsSettings: ActionsSettingsV1Schema.parse({
        v: 1,
        actions: {
          'session.title.set': {
            toolExposureModes: { agent: 'discoverable_only' },
          },
        },
      }),
      deps: {
        changeTitle,
        executeActionByToolName: async () => unsupported(),
      },
    });

    expect(result).toEqual({
      ok: false,
      errorCode: 'unknown_tool',
      error: 'Unknown built-in Happier tool: change_title',
    });
    expect(changeTitle).not.toHaveBeenCalled();
  });

  it('returns serialized action spec payloads without needing transport deps', async () => {
    const listResult = await dispatchBuiltInHappierTool({
      toolName: 'action_spec_search',
      args: { query: 'review' },
      sessionId: 'sess-1',
      deps: {
        changeTitle: async () => ({ success: true }),
        executeActionByToolName: async () => unsupported(),
      },
    });

    expect(listResult.ok).toBe(true);
    if (!listResult.ok) {
      throw new Error(`expected action_spec_search to succeed: ${listResult.errorCode}`);
    }
    expect(Array.isArray((listResult.result as { actionSpecs?: unknown }).actionSpecs)).toBe(true);
    expect((listResult.result as { actionSpecs: Array<{ id: string }> }).actionSpecs.some((spec) => spec.id === 'session.mode.set')).toBe(false);

    const getResult = await dispatchBuiltInHappierTool({
      toolName: 'action_spec_get',
      args: { id: 'subagents.plan.start' },
      sessionId: 'sess-1',
      deps: {
        changeTitle: async () => ({ success: true }),
        executeActionByToolName: async () => unsupported(),
      },
    });

    expect(getResult).toEqual(expect.objectContaining({
      ok: true,
      result: expect.objectContaining({
        actionSpec: expect.objectContaining({
          id: 'subagents.plan.start',
          kindVersion: 1,
          inputSchema: expect.objectContaining({
            properties: expect.objectContaining({
              backendTargetKeys: expect.objectContaining({
                type: 'array',
                minItems: 1,
                items: expect.objectContaining({
                  anyOf: expect.arrayContaining([
                    expect.objectContaining({
                      type: 'string',
                      pattern: '^(agent|acpBackend):.+$',
                    }),
                  ]),
                }),
              }),
              permissionMode: expect.objectContaining({ description: expect.any(String) }),
            }),
          }),
        }),
      }),
    }));

    const spawnGetResult = await dispatchBuiltInHappierTool({
      toolName: 'action_spec_get',
      args: { id: 'session.spawn_new' },
      sessionId: 'sess-1',
      deps: {
        changeTitle: async () => ({ success: true }),
        executeActionByToolName: async () => unsupported(),
      },
    });

    expect(spawnGetResult).toEqual(expect.objectContaining({
      ok: true,
      result: expect.objectContaining({
        actionSpec: expect.objectContaining({
          kindVersion: 1,
          inputSchema: expect.objectContaining({
            properties: expect.objectContaining({
              executionTarget: expect.objectContaining({
                properties: expect.objectContaining({
                  serverId: expect.objectContaining({ minLength: 1, maxLength: 191 }),
                }),
              }),
              organizationPlacement: expect.objectContaining({
                properties: expect.objectContaining({
                  tagIds: expect.objectContaining({ type: 'array', maxItems: 500 }),
                }),
              }),
              agentSessionStartupInstructionsV1: expect.objectContaining({
                properties: expect.objectContaining({
                  revision: expect.objectContaining({ exclusiveMinimum: 0, maximum: 2_147_483_647 }),
                }),
              }),
            }),
          }),
        }),
      }),
    }));
  });

  it('resolves action options through the shared options resolver hook', async () => {
    const result = await dispatchBuiltInHappierTool({
      toolName: 'action_options_resolve',
      args: { actionId: 'subagents.plan.start', fieldPath: 'backendTargetKeys' },
      sessionId: 'sess-1',
      deps: {
        changeTitle: async () => ({ success: true }),
        executeActionByToolName: async () => unsupported(),
        resolveActionOptions: async ({ actionId, fieldPath, optionsSourceId }) => ({
          ok: true,
          result: {
            actionId,
            fieldPath,
            optionsSourceId,
            options: [{ value: 'agent:codex', label: 'Codex' }],
          },
        }),
      },
    });

    expect(result).toEqual({
      ok: true,
      result: {
        actionId: 'subagents.plan.start',
        fieldPath: 'backendTargetKeys',
        optionsSourceId: 'execution.backends.enabled',
        options: [{ value: 'agent:codex', label: 'Codex' }],
      },
    });
  });

  it('preserves V2 session spawn option context through the agent/MCP discovery tool', async () => {
    const resolveActionOptions = vi.fn(async (args: Record<string, unknown>) => ({
      ok: true as const,
      result: {
        actionId: args.actionId as 'session.spawn_new',
        fieldPath: args.fieldPath as string,
        optionsSourceId: args.optionsSourceId as string,
        options: [],
      },
    }));
    const sessionSpawnOptionContext = {
      executionTarget: { serverId: 'local', machineId: 'm1' },
      directory: '/repo',
      agentTarget: {
        kind: 'agent',
        identity: { pluginId: 'happier.agent.claude', localId: 'claude' },
      },
      modelSelection: {
        v: 1,
        updatedAt: 1,
        ref: { agentTargetKey: 'backend:claude', modelId: 'claude-opus-4-8' },
      },
    } as const;

    const result = await dispatchBuiltInHappierTool({
      toolName: 'action_options_resolve',
      args: {
        actionId: 'session.spawn_new',
        fieldPath: 'modelSelection',
        ...sessionSpawnOptionContext,
      },
      sessionId: 'sess-1',
      deps: {
        changeTitle: async () => ({ success: true }),
        executeActionByToolName: async () => unsupported(),
        resolveActionOptions,
      },
    });

    expect(result).toEqual({
      ok: true,
      result: {
        actionId: 'session.spawn_new',
        fieldPath: 'modelSelection',
        optionsSourceId: 'agents.models.available',
        options: [],
      },
    });
    expect(resolveActionOptions).toHaveBeenCalledWith({
      actionId: 'session.spawn_new',
      fieldPath: 'modelSelection',
      optionsSourceId: 'agents.models.available',
      sessionId: null,
      limit: null,
      query: null,
      ...sessionSpawnOptionContext,
    });
  });

  it('rejects action_options_resolve on the CLI surface', async () => {
    const result = await dispatchBuiltInHappierTool({
      toolName: 'action_options_resolve',
      args: { optionsSourceId: 'session.modes.available' },
      sessionId: 'sess-1',
      surface: 'cli',
      deps: {
        changeTitle: async () => ({ success: true }),
        executeActionByToolName: async () => unsupported(),
        resolveActionOptions: async () => ({
          ok: true,
          result: {
            actionId: null,
            fieldPath: null,
            optionsSourceId: 'session.modes.available',
            options: [{ value: 'plan', label: 'Plan' }],
          },
        }),
      },
    });

    expectActionDisabled(result);
  });

  it('resolves action options directly from an optionsSourceId', async () => {
    const result = await dispatchBuiltInHappierTool({
      toolName: 'action_options_resolve',
      args: { optionsSourceId: 'session.modes.available' },
      sessionId: 'sess-1',
      deps: {
        changeTitle: async () => ({ success: true }),
        executeActionByToolName: async () => unsupported(),
        resolveActionOptions: async ({ actionId, fieldPath, optionsSourceId }) => ({
          ok: true,
          result: {
            actionId,
            fieldPath,
            optionsSourceId,
            options: [{ value: 'plan', label: 'Plan' }],
          },
        }),
      },
    });

    expect(result).toEqual({
      ok: true,
      result: {
        actionId: null,
        fieldPath: null,
        optionsSourceId: 'session.modes.available',
        options: [{ value: 'plan', label: 'Plan' }],
      },
    });
  });

  it('rejects disabled action specs through the shared policy hook', async () => {
    const getResult = await dispatchBuiltInHappierTool({
      toolName: 'action_spec_get',
      args: { id: 'review.start' },
      sessionId: 'sess-1',
      deps: {
        changeTitle: async () => ({ success: true }),
        executeActionByToolName: async () => unsupported(),
        isActionEnabled: (id) => id !== 'review.start',
      },
    });

    expectActionDisabled(getResult);
  });

  it('does not expose non-MCP action specs through the shared discovery tools', async () => {
    const getResult = await dispatchBuiltInHappierTool({
      toolName: 'action_spec_get',
      args: { id: 'ui.voice_global.reset' },
      sessionId: 'sess-1',
      surface: 'mcp',
      deps: {
        changeTitle: async () => ({ success: true }),
        executeActionByToolName: async () => unsupported(),
      },
    });

    expect(getResult).toMatchObject({
      ok: false,
      errorCode: 'action_disabled',
      error: 'Action is disabled',
      details: {
        actionId: 'ui.voice_global.reset',
        surface: 'mcp',
        reason: 'unsupported_surface',
      },
    });
  });

  it('dispatches action-backed tools through the shared action executor hook on external MCP', async () => {
    const executeActionByToolName = vi.fn(
      async (toolName: string, args: unknown, defaultSessionId: string): Promise<HappierBuiltInToolDispatchResult> =>
        ok({ toolName, args, defaultSessionId }),
    );

    const result = await dispatchBuiltInHappierTool({
      toolName: 'review_start',
      args: { instructions: 'Check this' },
      sessionId: 'sess-1',
      surface: 'mcp',
      deps: {
        changeTitle: async () => ({ success: true }),
        executeActionByToolName,
      },
    });

    expect(executeActionByToolName).toHaveBeenCalledWith('review_start', { instructions: 'Check this' }, 'sess-1');
    expect(result).toEqual({
      ok: true,
      result: { toolName: 'review_start', args: { instructions: 'Check this' }, defaultSessionId: 'sess-1' },
    });
  });

  it('rejects disabled action-backed tools before execution', async () => {
    const executeActionByToolName = vi.fn(async () => ok({ unreachable: true }));

    const result = await dispatchBuiltInHappierTool({
      toolName: 'review_start',
      args: { instructions: 'Check this' },
      sessionId: 'sess-1',
      deps: {
        changeTitle: async () => ({ success: true }),
        executeActionByToolName,
        isActionEnabled: (id) => id !== 'review.start',
      },
    });

    expectActionDisabled(result);
    expect(executeActionByToolName).not.toHaveBeenCalled();
  });

  it('rejects action-backed tools when the action is unavailable on the current surface', async () => {
    const executeActionByToolName = vi.fn(async () => ok({ unreachable: true }));

    const result = await dispatchBuiltInHappierTool({
      toolName: 'memory_search',
      args: { machineId: 'machine-1', query: { q: 'needle' } },
      sessionId: 'sess-1',
      surface: 'cli',
      deps: {
        changeTitle: async () => ({ success: true }),
        executeActionByToolName,
      },
    });

    expectActionDisabled(result);
    expect(executeActionByToolName).not.toHaveBeenCalled();
  });

  it('rejects disabled action_execute calls before execution', async () => {
    const executeActionByToolName = vi.fn(async () => ok({ unreachable: true }));

    const result = await dispatchBuiltInHappierTool({
      toolName: 'action_execute',
      args: { actionId: 'review.start', input: { sessionId: 'sess-1' } },
      sessionId: 'sess-1',
      deps: {
        changeTitle: async () => ({ success: true }),
        executeActionByToolName,
        isActionEnabled: (id) => id !== 'review.start',
      },
    });

    expectActionDisabled(result);
    expect(executeActionByToolName).not.toHaveBeenCalled();
  });

  it('rejects action_execute when the action is unavailable on the current surface', async () => {
    const executeActionByToolName = vi.fn(async () => ok({ unreachable: true }));

    const result = await dispatchBuiltInHappierTool({
      toolName: 'action_execute',
      args: { actionId: 'action.spec.search', input: { query: 'review' } },
      sessionId: 'sess-1',
      surface: 'cli',
      deps: {
        changeTitle: async () => ({ success: true }),
        executeActionByToolName,
      },
    });

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'action_disabled',
      error: 'Action is disabled',
      details: {
        actionId: 'action.spec.search',
        surface: 'cli',
        reason: 'unsupported_surface',
      },
    });
    expect(executeActionByToolName).not.toHaveBeenCalled();
  });

  it('rejects action_execute when explicit action settings disable the target action', async () => {
    const executeActionByToolName = vi.fn(async () => ok({ unreachable: true }));
    const actionsSettings = ActionsSettingsV1Schema.parse({
      v: 1,
      actions: {
        'subagents.plan.start': {
          disabledSurfaces: ['agent'],
        },
      },
    });

    const result = await dispatchBuiltInHappierTool({
      toolName: 'action_execute',
      args: {
        actionId: 'subagents.plan.start',
        input: { backendTargetKeys: ['agent:codex'], instructions: 'Plan.' },
      },
      sessionId: 'sess-1',
      actionsSettings,
      deps: {
        changeTitle: async () => ({ success: true }),
        executeActionByToolName,
      },
    });

    expectActionDisabled(result);
    expect(executeActionByToolName).not.toHaveBeenCalled();
  });

  it('dispatches action_execute through the shared action executor hook', async () => {
    const executeActionByToolName = vi.fn(
      async (toolName: string, args: unknown, defaultSessionId: string): Promise<HappierBuiltInToolDispatchResult> =>
        ok({ toolName, args, defaultSessionId }),
    );

    const result = await dispatchBuiltInHappierTool({
      toolName: 'action_execute',
      args: { actionId: 'review.start', input: { sessionId: 'sess-1', instructions: 'Check this', engineIds: ['claude'] } },
      sessionId: 'sess-1',
      deps: {
        changeTitle: async () => ({ success: true }),
        executeActionByToolName,
      },
    });

    expect(executeActionByToolName).toHaveBeenCalledWith(
      'action_execute',
      { actionId: 'review.start', input: { sessionId: 'sess-1', instructions: 'Check this', engineIds: ['claude'] } },
      'sess-1',
    );
    expect(result).toEqual({
      ok: true,
      result: {
        toolName: 'action_execute',
        args: { actionId: 'review.start', input: { sessionId: 'sess-1', instructions: 'Check this', engineIds: ['claude'] } },
        defaultSessionId: 'sess-1',
      },
    });
  });

  it('dispatches plugins_reload through the generated canonical Action tool', async () => {
    const canonicalPendingReview = {
      ok: false,
      kind: 'plugins_reload',
      outcome: 'reviewRequired',
      pendingReview: {
        kind: 'reviewRequired',
        pendingChangeId: 'pending-1',
      },
    } as const;
    const executeActionByToolName = vi.fn(async (): Promise<HappierBuiltInToolDispatchResult> => ok(canonicalPendingReview));

    const result = await dispatchBuiltInHappierTool({
      toolName: 'plugins_reload',
      args: { pluginId: 'acme.dev.plugin' },
      sessionId: 'sess-1',
      surface: 'cli',
      deps: {
        changeTitle: async () => ({ success: true }),
        executeActionByToolName,
      },
    });

    expect(executeActionByToolName).toHaveBeenCalledWith(
      'plugins_reload',
      { pluginId: 'acme.dev.plugin' },
      'sess-1',
    );
    expect(result).toEqual({
      ok: true,
      result: canonicalPendingReview,
    });
  });

  it('rejects discoverable-only first-party direct tool calls on the session-agent surface', async () => {
    const executeActionByToolName = vi.fn(async () => ok({ unreachable: true }));

    const result = await dispatchBuiltInHappierTool({
      toolName: 'execution_run_start',
      args: {
        intent: 'review',
        backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
        instructions: 'Review.',
      },
      sessionId: 'sess-1',
      surface: 'agent',
      deps: {
        changeTitle: async () => ({ success: true }),
        executeActionByToolName,
      },
    });

    expect(result).toEqual({
      ok: false,
      errorCode: 'unknown_tool',
      error: 'Unknown built-in Happier tool: execution_run_start',
    });
    expect(executeActionByToolName).not.toHaveBeenCalled();
  });

  it('dispatches execution_run_start through the shared action executor hook on external MCP', async () => {
    const executeActionByToolName = vi.fn(
      async (toolName: string, args: unknown, defaultSessionId: string): Promise<HappierBuiltInToolDispatchResult> =>
        ok({ toolName, args, defaultSessionId }),
    );

    const result = await dispatchBuiltInHappierTool({
      toolName: 'execution_run_start',
      args: {
        intent: 'review',
        backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
        instructions: 'Review.',
      },
      sessionId: 'sess-1',
      surface: 'mcp',
      deps: {
        changeTitle: async () => ({ success: true }),
        executeActionByToolName,
      },
    });

    expect(executeActionByToolName).toHaveBeenCalledWith('execution_run_start', {
      intent: 'review',
      backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
      instructions: 'Review.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
    }, 'sess-1');
    expect(result).toEqual({
      ok: true,
      result: {
        toolName: 'execution_run_start',
        args: expect.objectContaining({
          intent: 'review',
          backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
          instructions: 'Review.',
          permissionMode: 'read_only',
          retentionPolicy: 'ephemeral',
          runClass: 'bounded',
          ioMode: 'request_response',
        }),
        defaultSessionId: 'sess-1',
      },
    });
  });

  it('routes delegate execution_run_start through the shared action executor on external MCP', async () => {
    const executeActionByToolName = vi.fn(
      async (toolName: string, args: unknown, defaultSessionId: string): Promise<HappierBuiltInToolDispatchResult> =>
        ok({ toolName, args, defaultSessionId }),
    );

    const result = await dispatchBuiltInHappierTool({
      toolName: 'execution_run_start',
      args: {
        intent: 'delegate',
        backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
        instructions: 'Delegate.',
      },
      sessionId: 'sess-1',
      surface: 'mcp',
      deps: {
        changeTitle: async () => ({ success: true }),
        executeActionByToolName,
      },
    });

    expect(executeActionByToolName).toHaveBeenCalledWith('execution_run_start', expect.objectContaining({
      instructions: 'Delegate.',
      backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
      intent: 'delegate',
      permissionMode: 'workspace_write',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
    }), 'sess-1');
    expect(result).toEqual({
      ok: true,
      result: expect.objectContaining({ toolName: 'execution_run_start' }),
    });
  });

  it('routes voice_agent execution_run_start through the shared action executor on external MCP', async () => {
    const executeActionByToolName = vi.fn(
      async (toolName: string, args: unknown, defaultSessionId: string): Promise<HappierBuiltInToolDispatchResult> =>
        ok({ toolName, args, defaultSessionId }),
    );

    const result = await dispatchBuiltInHappierTool({
      toolName: 'execution_run_start',
      args: {
        intent: 'voice_agent',
        backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
        instructions: 'Start voice agent.',
      },
      sessionId: 'sess-1',
      surface: 'mcp',
      deps: {
        changeTitle: async () => ({ success: true }),
        executeActionByToolName,
      },
    });

    expect(executeActionByToolName).toHaveBeenCalledWith('execution_run_start', expect.objectContaining({
      instructions: 'Start voice agent.',
      backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
      intent: 'voice_agent',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'long_lived',
      ioMode: 'streaming',
    }), 'sess-1');
    expect(result).toEqual({
      ok: true,
      result: expect.objectContaining({ toolName: 'execution_run_start' }),
    });
  });

  it('routes plan execution_run_start through the shared action executor on external MCP', async () => {
    const executeActionByToolName = vi.fn(
      async (toolName: string, args: unknown, defaultSessionId: string): Promise<HappierBuiltInToolDispatchResult> =>
        ok({ toolName, args, defaultSessionId }),
    );

    const result = await dispatchBuiltInHappierTool({
      toolName: 'execution_run_start',
      args: {
        intent: 'plan',
        backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
        instructions: 'Plan.',
      },
      sessionId: 'sess-1',
      surface: 'mcp',
      deps: {
        changeTitle: async () => ({ success: true }),
        executeActionByToolName,
      },
    });

    expect(executeActionByToolName).toHaveBeenCalledWith('execution_run_start', expect.objectContaining({
      instructions: 'Plan.',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      intent: 'plan',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
    }), 'sess-1');
    expect(result).toEqual({
      ok: true,
      result: expect.objectContaining({ toolName: 'execution_run_start' }),
    });
  });

  it('rejects execution_run_start when the equivalent action is disabled by policy', async () => {
    const executeActionByToolName = vi.fn(async () => ok({ unreachable: true }));

    const result = await dispatchBuiltInHappierTool({
      toolName: 'execution_run_start',
      args: {
        intent: 'review',
        backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
        instructions: 'Review this task.',
      },
      sessionId: 'sess-1',
      surface: 'mcp',
      deps: {
        changeTitle: async () => ({ success: true }),
        executeActionByToolName,
        isActionEnabled: (id) => id !== 'review.start',
      },
    });

    expectActionDisabled(result);
    expect(executeActionByToolName).not.toHaveBeenCalled();
  });

  it('rejects execution_run_start when explicit action settings disable the equivalent action', async () => {
    const executeActionByToolName = vi.fn(async () => ok({ unreachable: true }));
    const actionsSettings = ActionsSettingsV1Schema.parse({
      v: 1,
      actions: {
        'review.start': {
          disabledSurfaces: ['mcp'],
        },
      },
    });

    const result = await dispatchBuiltInHappierTool({
      toolName: 'execution_run_start',
      args: {
        intent: 'review',
        backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
        instructions: 'Review this task.',
      },
      sessionId: 'sess-1',
      surface: 'mcp',
      actionsSettings,
      deps: {
        changeTitle: async () => ({ success: true }),
        executeActionByToolName,
      },
    });

    expectActionDisabled(result);
    expect(executeActionByToolName).not.toHaveBeenCalled();
  });

  it('dispatches action-backed tools that are only surfaced on the agent surface', async () => {
    const executeActionByToolName = vi.fn(async () => ok({ ok: true }));
    const actionsSettings = ActionsSettingsV1Schema.parse({
      v: 1,
      actions: {
        'session.list': {
          toolExposureModes: {
            agent: 'direct',
          },
        },
      },
    });

    const result = await dispatchBuiltInHappierTool({
      toolName: 'session_list',
      args: { limit: 10 },
      sessionId: 'sess-1',
      surface: 'agent',
      actionsSettings,
      deps: {
        changeTitle: async () => ({ success: true }),
        executeActionByToolName,
      },
    });

    expect(result).toEqual(ok({ ok: true }));
    expect(executeActionByToolName).toHaveBeenCalledWith(
      'session_list',
      { limit: 10 },
      'sess-1',
    );
  });

  it('passes approval origin metadata to action-backed tool execution', async () => {
    const executeActionByToolName = vi.fn(async () => ok({ ok: true }));
    const actionsSettings = ActionsSettingsV1Schema.parse({
      v: 1,
      actions: {
        'session.list': {
          toolExposureModes: {
            agent: 'direct',
          },
        },
      },
    });
    const approvalOrigin = {
      kind: 'transcript_tool_call' as const,
      sessionId: 'sess-1',
      toolCallId: 'tool-1',
      toolName: 'session_list',
      toolInput: { limit: 10 },
    };

    const result = await dispatchBuiltInHappierTool({
      toolName: 'session_list',
      args: { limit: 10 },
      sessionId: 'sess-1',
      surface: 'agent',
      approvalOrigin,
      actionsSettings,
      deps: {
        changeTitle: async () => ({ success: true }),
        executeActionByToolName,
      },
    });

    expect(result).toEqual(ok({ ok: true }));
    expect(executeActionByToolName).toHaveBeenCalledWith(
      'session_list',
      { limit: 10 },
      'sess-1',
      { approvalOrigin },
    );
  });

  it('allows action_execute to target plugin actions when the current registry exposes them on the surface', async () => {
    const executeActionByToolName = vi.fn(
      async (toolName: string, args: unknown, defaultSessionId: string): Promise<HappierBuiltInToolDispatchResult> =>
        ok({ toolName, args, defaultSessionId }),
    );

    const result = await dispatchBuiltInHappierTool({
      toolName: 'action_execute',
      args: {
        actionId: 'acme.review.plugin/review-start',
        input: { scope: 'diff' },
      },
      sessionId: 'sess-1',
      registry: useActiveResolvedContributionRegistry({
        agents: [],
                actions: [
          {
            provenance: 'external',
            source: { kind: 'path' },
            pluginId: 'acme.review.plugin',
            manifestPath: '/plugins/acme/review/.happier-plugin/plugin.json',
            daemonEntryPath: '/plugins/acme/review/daemon.mjs',
            sourceSpec: {
              kind: 'path',
              locator: '/plugins/acme/review',
              trustPolicy: 'local_trusted',
              installPolicy: 'link',
            },
            definition: {
              kindVersion: 1,
              id: 'review-start',
              title: 'Acme Review Start',
              description: 'Start a plugin-defined review workflow',
              safety: 'safe',
              dangerLevel: 'safe',
              placements: [],
              slash: null,
              bindings: {
                mcpToolName: 'acme_review_start',
              },
              examples: null,
              surfaces: {
                ui: false,
                voice: false,
                agent: true,
                mcp: true,
                cli: true,
                rpc: false,
                api: false,
                plugin: false,
              },
              inputHints: null,
              inputSchema: {
                type: 'object',
                properties: {},
                additionalProperties: true,
              },
              execution: {
                routing: 'plugin',
                handler: {
                  target: 'plugin',
                  exportName: 'startReview',
                },
              },
            },
          },
        ],
      }),
      deps: {
        changeTitle: async () => ({ success: true }),
        executeActionByToolName,
      },
    });

    expect(result).toEqual({
      ok: true,
      result: {
        toolName: 'action_execute',
        args: {
          actionId: 'acme.review.plugin/review-start',
          input: { scope: 'diff' },
        },
        defaultSessionId: 'sess-1',
      },
    });
    expect(executeActionByToolName).toHaveBeenCalledWith(
      'action_execute',
      {
        actionId: 'acme.review.plugin/review-start',
        input: { scope: 'diff' },
      },
      'sess-1',
    );
  });

  it('allows action_execute to target trusted non-MCP plugin actions on the CLI surface', async () => {
    const executeActionByToolName = vi.fn(
      async (toolName: string, args: unknown, defaultSessionId: string): Promise<HappierBuiltInToolDispatchResult> =>
        ok({ toolName, args, defaultSessionId }),
    );

    const result = await dispatchBuiltInHappierTool({
      toolName: 'action_execute',
      args: {
        actionId: 'acme.review.plugin/cli-review-start',
        input: { scope: 'diff' },
      },
      sessionId: 'sess-1',
      surface: 'cli',
      registry: useActiveResolvedContributionRegistry({
        agents: [],
                actions: [
          {
            provenance: 'external',
            source: { kind: 'path' },
            pluginId: 'acme.review.plugin',
            manifestPath: '/plugins/acme/review/.happier-plugin/plugin.json',
            daemonEntryPath: '/plugins/acme/review/daemon.mjs',
            sourceSpec: {
              kind: 'path',
              locator: '/plugins/acme/review',
              trustPolicy: 'local_trusted',
              installPolicy: 'link',
            },
            definition: {
              kindVersion: 1,
              id: 'cli-review-start',
              title: 'Acme CLI Review Start',
              description: 'Start a CLI-only plugin-defined review workflow',
              safety: 'safe',
              dangerLevel: 'safe',
              placements: [],
              slash: null,
              bindings: {},
              examples: null,
              surfaces: {
                ui: false,
                voice: false,
                agent: true,
                mcp: false,
                cli: true,
                rpc: false,
                api: false,
                plugin: false,
              },
              inputHints: null,
              inputSchema: {
                type: 'object',
                properties: {},
                additionalProperties: true,
              },
              execution: {
                routing: 'plugin',
                handler: {
                  target: 'plugin',
                  exportName: 'startCliReview',
                },
              },
            },
          },
        ],
      }),
      deps: {
        changeTitle: async () => ({ success: true }),
        executeActionByToolName,
      },
    });

    expect(result).toEqual({
      ok: true,
      result: {
        toolName: 'action_execute',
        args: {
          actionId: 'acme.review.plugin/cli-review-start',
          input: { scope: 'diff' },
        },
        defaultSessionId: 'sess-1',
      },
    });
    expect(executeActionByToolName).toHaveBeenCalledWith(
      'action_execute',
      {
        actionId: 'acme.review.plugin/cli-review-start',
        input: { scope: 'diff' },
      },
      'sess-1',
    );
  });

  it('rejects action_execute for plugin actions that are not trusted by the authoritative registry', async () => {
    const executeActionByToolName = vi.fn(async () => ok({ unreachable: true }));

    const result = await dispatchBuiltInHappierTool({
      toolName: 'action_execute',
      args: {
        actionId: 'acme.review.plugin/review-start',
        input: { scope: 'diff' },
      },
      sessionId: 'sess-1',
      surface: 'cli',
      registry: useActiveResolvedContributionRegistry({
        agents: [],
                actions: [
          {
            provenance: 'external',
            source: { kind: 'path' },
            pluginId: 'acme.review.plugin',
            manifestPath: '/plugins/acme/review/.happier-plugin/plugin.json',
            daemonEntryPath: '/plugins/acme/review/daemon.mjs',
            sourceSpec: {
              kind: 'path',
              locator: '/plugins/acme/review',
              trustPolicy: 'prompt',
              installPolicy: 'link',
            },
            definition: {
              kindVersion: 1,
              id: 'review-start',
              title: 'Acme Review Start',
              description: 'Start a plugin-defined review workflow',
              safety: 'safe',
              dangerLevel: 'safe',
              placements: [],
              slash: null,
              bindings: {
                mcpToolName: 'acme_review_start',
              },
              examples: null,
              surfaces: {
                ui: false,
                voice: false,
                agent: true,
                mcp: true,
                cli: true,
                rpc: false,
                api: false,
                plugin: false,
              },
              inputHints: null,
              inputSchema: {
                type: 'object',
                properties: {},
                additionalProperties: true,
              },
              execution: {
                routing: 'plugin',
                handler: {
                  target: 'plugin',
                  exportName: 'startReview',
                },
              },
            },
          },
        ],
      }, 'denied'),
      deps: {
        changeTitle: async () => ({ success: true }),
        executeActionByToolName,
      },
    });

    expectActionDisabled(result);
    expect(executeActionByToolName).not.toHaveBeenCalled();
  });

  it('rejects action_execute for plugin actions hidden from the current surface', async () => {
    const executeActionByToolName = vi.fn(async () => ok({ unreachable: true }));

    const result = await dispatchBuiltInHappierTool({
      toolName: 'action_execute',
      args: {
        actionId: 'acme.review.plugin/review-start',
        input: { scope: 'diff' },
      },
      sessionId: 'sess-1',
      surface: 'cli',
      registry: useActiveResolvedContributionRegistry({
        agents: [],
                actions: [
          {
            provenance: 'external',
            source: { kind: 'path' },
            pluginId: 'acme.review.plugin',
            manifestPath: '/plugins/acme/review/.happier-plugin/plugin.json',
            daemonEntryPath: '/plugins/acme/review/daemon.mjs',
            sourceSpec: {
              kind: 'path',
              locator: '/plugins/acme/review',
              trustPolicy: 'local_trusted',
              installPolicy: 'link',
            },
            definition: {
              kindVersion: 1,
              id: 'review-start',
              title: 'Acme Review Start',
              description: 'Start a plugin-defined review workflow',
              safety: 'safe',
              dangerLevel: 'safe',
              placements: [],
              slash: null,
              bindings: {
                mcpToolName: 'acme_review_start',
              },
              examples: null,
              surfaces: {
                ui: false,
                voice: false,
                agent: true,
                mcp: true,
                cli: false,
                rpc: false,
                api: false,
                plugin: false,
              },
              inputHints: null,
              inputSchema: {
                type: 'object',
                properties: {},
                additionalProperties: true,
              },
              execution: {
                routing: 'plugin',
                handler: {
                  target: 'plugin',
                  exportName: 'startReview',
                },
              },
            },
          },
        ],
      }),
      deps: {
        changeTitle: async () => ({ success: true }),
        executeActionByToolName,
      },
    });

    expectActionDisabled(result);
    expect(executeActionByToolName).not.toHaveBeenCalled();
  });
});
