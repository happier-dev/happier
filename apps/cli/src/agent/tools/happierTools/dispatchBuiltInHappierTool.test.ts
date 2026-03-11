import { describe, expect, it, vi } from 'vitest';

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
    expect(names).toContain('review_start');
    expect(names).toContain('subagents_plan_start');
    expect(names).toContain('subagents_delegate_start');
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

    expect(getResult).toEqual({
      ok: false,
      errorCode: 'action_disabled',
      error: 'Action is disabled',
    });
  });

  it('does not expose non-MCP action specs through the shared discovery tools', async () => {
    const getResult = await dispatchBuiltInHappierTool({
      toolName: 'action_spec_get',
      args: { id: 'session.mode.set' },
      sessionId: 'sess-1',
      deps: {
        changeTitle: async () => ({ success: true }),
        startExecutionRun: async () => unsupported(),
        executeActionByToolName: async () => unsupported(),
      },
    });

    expect(getResult).toEqual({
      ok: false,
      errorCode: 'action_disabled',
      error: 'Action is disabled',
    });
  });

  it('dispatches action-backed tools through the shared action executor hook', async () => {
    const executeActionByToolName = vi.fn(
      async (toolName: string, args: unknown, defaultSessionId: string): Promise<HappierBuiltInToolDispatchResult> =>
        ok({ toolName, args, defaultSessionId }),
    );

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

    expect(executeActionByToolName).toHaveBeenCalledWith('review_start', { instructions: 'Check this' }, 'sess-1');
    expect(result).toEqual({
      ok: true,
      result: { toolName: 'review_start', args: { instructions: 'Check this' }, defaultSessionId: 'sess-1' },
    });
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
});
