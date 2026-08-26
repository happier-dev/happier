import { describe, expect, it, vi } from 'vitest';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol';

import { listBuiltInHappierTools } from './listBuiltInHappierTools';
import { dispatchBuiltInHappierTool } from './dispatchBuiltInHappierTool';
import type { HappierBuiltInToolDispatchResult } from './types';

function ok(result: unknown): HappierBuiltInToolDispatchResult {
  return { ok: true, result };
}

function unsupported(): HappierBuiltInToolDispatchResult {
  return { ok: false, errorCode: 'unsupported', error: 'unsupported' };
}

describe('built-in Happier tools', () => {
  it('lists manual and action-backed tools from the shared catalog', () => {
    const names = listBuiltInHappierTools().map((tool) => tool.name);

    expect(names).toContain('change_title');
    expect(names).toContain('action_spec_search');
    expect(names).toContain('action_spec_get');
    expect(names).toContain('action_options_resolve');
    expect(names).toContain('action_execute');
    expect(names).not.toContain('review_start');
    expect(names).not.toContain('subagents_plan_start');
    expect(names).not.toContain('subagents_delegate_start');
    expect(names).not.toContain('execution_run_start');
  });

  it('dispatches change_title through the injected title updater', async () => {
    const changeTitle = vi.fn(async (_sessionId: string, title: string) => ({ success: true, title }));

    const result = await dispatchBuiltInHappierTool({
      toolName: 'change_title',
      args: { title: 'New title' },
      sessionId: 'sess-1',
      deps: {
        changeTitle,
        startExecutionRun: async () => unsupported(),
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
        startExecutionRun: async () => unsupported(),
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
        startExecutionRun: async () => unsupported(),
        executeActionByToolName: async () => unsupported(),
        isActionEnabled: (id) => id !== 'session.title.set',
      },
    });

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'action_disabled',
      error: 'Action is disabled',
    });
    expect(changeTitle).not.toHaveBeenCalled();
  });

  it('rejects change_title when session title updates are discoverable-only', async () => {
    const changeTitle = vi.fn(async () => ({ success: true, title: 'New title' }));

    const result = await dispatchBuiltInHappierTool({
      toolName: 'change_title',
      args: { title: 'New title' },
      sessionId: 'sess-1',
      surface: 'session_agent',
      actionsSettings: ActionsSettingsV1Schema.parse({
        v: 1,
        actions: {
          'session.title.set': {
            toolExposureModes: { session_agent: 'discoverable_only' },
          },
        },
      }),
      deps: {
        changeTitle,
        startExecutionRun: async () => unsupported(),
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
        startExecutionRun: async () => unsupported(),
        executeActionByToolName: async () => unsupported(),
      },
    });

    expect(listResult.ok).toBe(true);
    if (!listResult.ok) {
      throw new Error(`expected action_spec_search to succeed: ${listResult.errorCode}`);
    }
    expect(Array.isArray((listResult.result as { actionSpecs?: unknown }).actionSpecs)).toBe(true);
    expect((listResult.result as { actionSpecs: Array<{ id: string }> }).actionSpecs.some((spec) => spec.id === 'session.mode.set')).toBe(false);
    expect((listResult.result as { actionSpecs: Array<{ id: string }> }).actionSpecs.some((spec) => spec.id === 'review.start')).toBe(true);

    const getResult = await dispatchBuiltInHappierTool({
      toolName: 'action_spec_get',
      args: { id: 'review.start' },
      sessionId: 'sess-1',
      deps: {
        changeTitle: async () => ({ success: true }),
        startExecutionRun: async () => unsupported(),
        executeActionByToolName: async () => unsupported(),
      },
    });

    expect(getResult).toEqual(expect.objectContaining({
      ok: true,
      result: expect.objectContaining({
        actionSpec: expect.objectContaining({ id: 'review.start' }),
      }),
    }));

    const delegateGetResult = await dispatchBuiltInHappierTool({
      toolName: 'action_spec_get',
      args: { id: 'subagents.delegate.start' },
      sessionId: 'sess-1',
      deps: {
        changeTitle: async () => ({ success: true }),
        startExecutionRun: async () => unsupported(),
        executeActionByToolName: async () => unsupported(),
      },
    });

    expect(delegateGetResult).toEqual(expect.objectContaining({
      ok: true,
      result: expect.objectContaining({
        actionSpec: expect.objectContaining({ id: 'subagents.delegate.start' }),
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
        startExecutionRun: async () => unsupported(),
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

  it('rejects action_options_resolve on the CLI surface', async () => {
    const result = await dispatchBuiltInHappierTool({
      toolName: 'action_options_resolve',
      args: { optionsSourceId: 'session.modes.available' },
      sessionId: 'sess-1',
      surface: 'cli',
      deps: {
        changeTitle: async () => ({ success: true }),
        startExecutionRun: async () => unsupported(),
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

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'action_disabled',
      error: 'Action is disabled',
    });
  });

  it('resolves action options directly from an optionsSourceId', async () => {
    const result = await dispatchBuiltInHappierTool({
      toolName: 'action_options_resolve',
      args: { optionsSourceId: 'session.modes.available' },
      sessionId: 'sess-1',
      deps: {
        changeTitle: async () => ({ success: true }),
        startExecutionRun: async () => unsupported(),
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
        startExecutionRun: async () => unsupported(),
        executeActionByToolName: async () => unsupported(),
        isActionEnabled: (id) => id !== 'review.start',
      },
    });

    expect(getResult).toMatchObject({
      ok: false,
      errorCode: 'action_disabled',
      error: 'Action is disabled',
    });
  });

  it('includes structured availability details when action_spec_get is disabled by caller policy', async () => {
    const getResult = await dispatchBuiltInHappierTool({
      toolName: 'action_spec_get',
      args: { id: 'review.start' },
      sessionId: 'sess-1',
      deps: {
        changeTitle: async () => ({ success: true }),
        startExecutionRun: async () => unsupported(),
        executeActionByToolName: async () => unsupported(),
        isActionEnabled: (id) => id !== 'review.start',
      },
    });

    expect(getResult).toMatchObject({
      ok: false,
      errorCode: 'action_disabled',
      error: 'Action is disabled',
      details: {
        actionId: 'review.start',
        surface: 'session_agent',
        reason: 'disabled_by_policy',
      },
    });
  });

  it('includes structured availability details when action_options_resolve targets a disabled action field', async () => {
    const getResult = await dispatchBuiltInHappierTool({
      toolName: 'action_options_resolve',
      args: { actionId: 'subagents.plan.start', fieldPath: 'backendTargetKeys' },
      sessionId: 'sess-1',
      deps: {
        changeTitle: async () => ({ success: true }),
        startExecutionRun: async () => unsupported(),
        executeActionByToolName: async () => unsupported(),
        resolveActionOptions: async () => ({
          ok: true,
          result: {
            actionId: 'subagents.plan.start',
            fieldPath: 'backendTargetKeys',
            optionsSourceId: 'execution.backends.enabled',
            options: [],
          },
        }),
        isActionEnabled: (id) => id !== 'subagents.plan.start',
      },
    });

    expect(getResult).toMatchObject({
      ok: false,
      errorCode: 'action_disabled',
      error: 'Action is disabled',
      details: {
        actionId: 'subagents.plan.start',
        surface: 'session_agent',
        reason: 'disabled_by_policy',
      },
    });
  });

  it('includes structured availability details when action_execute targets an unsupported surface', async () => {
    const executeActionByToolName = vi.fn(async () => ok({ unreachable: true }));

    const result = await dispatchBuiltInHappierTool({
      toolName: 'action_execute',
      args: { actionId: 'action.spec.search', input: { query: 'review' } },
      sessionId: 'sess-1',
      surface: 'cli',
      deps: {
        changeTitle: async () => ({ success: true }),
        startExecutionRun: async () => unsupported(),
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

  it('does not expose non-MCP action specs through the shared discovery tools', async () => {
    const getResult = await dispatchBuiltInHappierTool({
      toolName: 'action_spec_get',
      args: { id: 'memory.search' },
      sessionId: 'sess-1',
      surface: 'mcp',
      deps: {
        changeTitle: async () => ({ success: true }),
        startExecutionRun: async () => unsupported(),
        executeActionByToolName: async () => unsupported(),
      },
    });

    expect(getResult).toMatchObject({
      ok: false,
      errorCode: 'action_disabled',
      error: 'Action is disabled',
      details: {
        actionId: 'memory.search',
        surface: 'mcp',
        reason: 'unsupported_surface',
      },
    });
  });

  it('rejects discoverable-only action-backed tools as direct session-agent calls', async () => {
    const executeActionByToolName = vi.fn(async () => ok({ unreachable: true }));

    const result = await dispatchBuiltInHappierTool({
      toolName: 'review_start',
      args: { instructions: 'Check this' },
      sessionId: 'sess-1',
      deps: {
        changeTitle: async () => ({ success: true }),
        startExecutionRun: async () => unsupported(),
        executeActionByToolName,
      },
    });

    expect(result).toEqual({
      ok: false,
      errorCode: 'unknown_tool',
      error: 'Unknown built-in Happier tool: review_start',
    });
    expect(executeActionByToolName).not.toHaveBeenCalled();
  });

  it('dispatches direct action-backed tools through the shared action executor hook for external MCP', async () => {
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
        startExecutionRun: async () => unsupported(),
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
        startExecutionRun: async () => unsupported(),
        executeActionByToolName,
        isActionEnabled: (id) => id !== 'review.start',
      },
    });

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'action_disabled',
      error: 'Action is disabled',
    });
    expect(executeActionByToolName).not.toHaveBeenCalled();
  });

  it('rejects action-backed tools when the action is unavailable on the current surface', async () => {
    const executeActionByToolName = vi.fn(async () => ok({ unreachable: true }));

    const result = await dispatchBuiltInHappierTool({
      toolName: 'memory_ensure_up_to_date',
      args: { machineId: 'machine-1', sessionId: 'sess-1' },
      sessionId: 'sess-1',
      surface: 'cli',
      deps: {
        changeTitle: async () => ({ success: true }),
        startExecutionRun: async () => unsupported(),
        executeActionByToolName,
      },
    });

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'action_disabled',
      error: 'Action is disabled',
    });
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
        startExecutionRun: async () => unsupported(),
        executeActionByToolName,
        isActionEnabled: (id) => id !== 'review.start',
      },
    });

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'action_disabled',
      error: 'Action is disabled',
    });
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
        startExecutionRun: async () => unsupported(),
        executeActionByToolName,
      },
    });

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'action_disabled',
      error: 'Action is disabled',
    });
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
        startExecutionRun: async () => unsupported(),
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

  it('dispatches execution_run_start with a backendTarget and defaults', async () => {
    const startExecutionRun = vi.fn(async (_sessionId: string, request: unknown) => ok(request));

    const result = await dispatchBuiltInHappierTool({
      toolName: 'execution_run_start',
      args: {
        intent: 'review',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        instructions: 'Review.',
      },
      sessionId: 'sess-1',
      surface: 'mcp',
      deps: {
        changeTitle: async () => ({ success: true }),
        startExecutionRun,
        executeActionByToolName: async () => unsupported(),
      },
    });

    expect(startExecutionRun).toHaveBeenCalledWith('sess-1', {
      intent: 'review',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'Review.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
    });
    expect(result).toEqual({
      ok: true,
      result: {
        intent: 'review',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        instructions: 'Review.',
        permissionMode: 'read_only',
        retentionPolicy: 'ephemeral',
        runClass: 'bounded',
        ioMode: 'request_response',
      },
    });
  });

  it('routes delegate execution_run_start through the shared action tool executor', async () => {
    const startExecutionRun = vi.fn(async (_sessionId: string, request: unknown) => ok(request));
    const executeActionByToolName = vi.fn(
      async (toolName: string, args: unknown, defaultSessionId: string): Promise<HappierBuiltInToolDispatchResult> =>
        ok({ toolName, args, defaultSessionId }),
    );

    const result = await dispatchBuiltInHappierTool({
      toolName: 'execution_run_start',
      args: {
        intent: 'delegate',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        instructions: 'Delegate.',
      },
      sessionId: 'sess-1',
      surface: 'mcp',
      deps: {
        changeTitle: async () => ({ success: true }),
        startExecutionRun,
        executeActionByToolName,
      },
    });

    expect(executeActionByToolName).toHaveBeenCalledWith('subagents_delegate_start', expect.objectContaining({
      sessionId: 'sess-1',
      instructions: 'Delegate.',
      backendTargetKeys: ['agent:claude'],
    }), 'sess-1');
    expect(startExecutionRun).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: true,
      result: expect.objectContaining({ toolName: 'subagents_delegate_start' }),
    });
  });

  it('routes voice_agent execution_run_start through the shared action tool executor', async () => {
    const startExecutionRun = vi.fn(async (_sessionId: string, request: unknown) => ok(request));
    const executeActionByToolName = vi.fn(
      async (toolName: string, args: unknown, defaultSessionId: string): Promise<HappierBuiltInToolDispatchResult> =>
        ok({ toolName, args, defaultSessionId }),
    );

    const result = await dispatchBuiltInHappierTool({
      toolName: 'execution_run_start',
      args: {
        intent: 'voice_agent',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        instructions: 'Start voice agent.',
      },
      sessionId: 'sess-1',
      surface: 'mcp',
      deps: {
        changeTitle: async () => ({ success: true }),
        startExecutionRun,
        executeActionByToolName,
      },
    });

    expect(executeActionByToolName).toHaveBeenCalledWith('voice_agent_start', expect.objectContaining({
      sessionId: 'sess-1',
      instructions: 'Start voice agent.',
      backendTargetKeys: ['agent:claude'],
    }), 'sess-1');
    expect(startExecutionRun).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: true,
      result: expect.objectContaining({ toolName: 'voice_agent_start' }),
    });
  });

  it('routes plan execution_run_start through the shared action tool executor', async () => {
    const startExecutionRun = vi.fn(async (_sessionId: string, request: unknown) => ok(request));
    const executeActionByToolName = vi.fn(
      async (toolName: string, args: unknown, defaultSessionId: string): Promise<HappierBuiltInToolDispatchResult> =>
        ok({ toolName, args, defaultSessionId }),
    );

    const result = await dispatchBuiltInHappierTool({
      toolName: 'execution_run_start',
      args: {
        intent: 'plan',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        instructions: 'Plan.',
      },
      sessionId: 'sess-1',
      surface: 'mcp',
      deps: {
        changeTitle: async () => ({ success: true }),
        startExecutionRun,
        executeActionByToolName,
      },
    });

    expect(executeActionByToolName).toHaveBeenCalledWith('subagents_plan_start', expect.objectContaining({
      sessionId: 'sess-1',
      instructions: 'Plan.',
      backendTargetKeys: ['agent:codex'],
    }), 'sess-1');
    expect(startExecutionRun).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: true,
      result: expect.objectContaining({ toolName: 'subagents_plan_start' }),
    });
  });

  it('rejects execution_run_start when the equivalent action is disabled by policy', async () => {
    const startExecutionRun = vi.fn(async () => ok({ unreachable: true }));

    const result = await dispatchBuiltInHappierTool({
      toolName: 'execution_run_start',
      args: {
        intent: 'review',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        instructions: 'Review this task.',
      },
      sessionId: 'sess-1',
      deps: {
        changeTitle: async () => ({ success: true }),
        startExecutionRun,
        executeActionByToolName: async () => unsupported(),
        isActionEnabled: (id) => id !== 'review.start',
      },
    });

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'action_disabled',
      error: 'Action is disabled',
    });
    expect(startExecutionRun).not.toHaveBeenCalled();
  });

  it('dispatches action-backed tools that are direct on the external MCP surface', async () => {
    const executeActionByToolName = vi.fn(async () => ok({ ok: true }));

    const result = await dispatchBuiltInHappierTool({
      toolName: 'session_list',
      args: { limit: 10 },
      sessionId: 'sess-1',
      surface: 'mcp',
      deps: {
        changeTitle: async () => ({ success: true }),
        startExecutionRun: async () => unsupported(),
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

  it('passes approval origin metadata to direct action-backed tool execution', async () => {
    const executeActionByToolName = vi.fn(async () => ok({ ok: true }));
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
      surface: 'mcp',
      approvalOrigin,
      deps: {
        changeTitle: async () => ({ success: true }),
        startExecutionRun: async () => unsupported(),
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
});
