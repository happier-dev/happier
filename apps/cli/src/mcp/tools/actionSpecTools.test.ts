import { describe, expect, it } from 'vitest';

import { createActionSpecMcpTools } from './actionSpecTools';

function parse(res: any): any {
  return JSON.parse(res.content[0]!.text);
}

describe('createActionSpecMcpTools', () => {
  it('searches action specs as JSON-safe objects', async () => {
    const tools = createActionSpecMcpTools();
    const res = await tools.action_spec_search.handler({ query: 'plan' });
    expect(res.isError).toBe(false);

    const payload = parse(res);
    expect(Array.isArray(payload.actionSpecs)).toBe(true);
    expect(payload.actionSpecs.some((s: any) => s.id === 'subagents.plan.start')).toBe(true);
  });

  it('gets a single action spec by id', async () => {
    const tools = createActionSpecMcpTools();
    const res = await tools.action_spec_get.handler({ id: 'subagents.plan.start' });
    expect(res.isError).toBe(false);

    const payload = parse(res);
    expect(payload.actionSpec?.id).toBe('subagents.plan.start');
    expect(payload.actionSpec?.inputSchema).toBeUndefined();
  });

  it('does not expose non-MCP actions through the MCP catalog helpers', async () => {
    const tools = createActionSpecMcpTools();

    const searchRes = await tools.action_spec_search.handler({ query: 'mode' });
    expect(searchRes.isError).toBe(false);
    expect(parse(searchRes).actionSpecs.some((spec: any) => spec.id === 'session.mode.set')).toBe(false);

    const getRes = await tools.action_spec_get.handler({ id: 'session.mode.set' });
    expect(getRes.isError).toBe(true);
    expect(parse(getRes)).toEqual({
      errorCode: 'action_disabled',
      error: 'Action is disabled',
    });
  });

  it('resolves field options from action specs', async () => {
    const tools = createActionSpecMcpTools({
      resolveActionOptions: async () => ({
        ok: true,
        result: {
          actionId: 'subagents.plan.start',
          fieldPath: 'backendTargetKeys',
          optionsSourceId: 'execution.backends.enabled',
          options: [{ value: 'agent:codex', label: 'Codex' }],
        },
      }),
    });
    const res = await tools.action_options_resolve.handler({
      actionId: 'subagents.plan.start',
      fieldPath: 'backendTargetKeys',
    });

    expect(res.isError).toBe(false);
    expect(parse(res)).toEqual({
      actionId: 'subagents.plan.start',
      fieldPath: 'backendTargetKeys',
      optionsSourceId: 'execution.backends.enabled',
      options: [{ value: 'agent:codex', label: 'Codex' }],
    });
  });

  it('filters static field options by query and limit', async () => {
    const tools = createActionSpecMcpTools();
    const res = await tools.action_options_resolve.handler({
      actionId: 'review.start',
      fieldPath: 'changeType',
      query: 'unc',
      limit: 1,
    });

    expect(res.isError).toBe(false);
    expect(parse(res)).toEqual({
      actionId: 'review.start',
      fieldPath: 'changeType',
      optionsSourceId: null,
      options: [{ value: 'uncommitted', label: 'Uncommitted' }],
    });
  });

  it('resolves dynamic options directly from optionsSourceId', async () => {
    const tools = createActionSpecMcpTools({
      resolveActionOptions: async ({ actionId, fieldPath, optionsSourceId }) => ({
        ok: true,
        result: {
          actionId,
          fieldPath,
          optionsSourceId,
          options: [{ value: 'plan', label: 'Plan' }],
        },
      }),
    });
    const res = await tools.action_options_resolve.handler({
      optionsSourceId: 'session.modes.available',
    });

    expect(res.isError).toBe(false);
    expect(parse(res)).toEqual({
      actionId: null,
      fieldPath: null,
      optionsSourceId: 'session.modes.available',
      options: [{ value: 'plan', label: 'Plan' }],
    });
  });

  it('filters dynamic options resolved from optionsSourceId by query and limit', async () => {
    const tools = createActionSpecMcpTools({
      resolveActionOptions: async ({ actionId, fieldPath, optionsSourceId }) => ({
        ok: true,
        result: {
          actionId,
          fieldPath,
          optionsSourceId,
          options: [
            { value: 'plan', label: 'Plan' },
            { value: 'build', label: 'Build' },
          ],
        },
      }),
    });
    const res = await tools.action_options_resolve.handler({
      optionsSourceId: 'session.modes.available',
      query: 'pl',
      limit: 1,
    });

    expect(res.isError).toBe(false);
    expect(parse(res)).toEqual({
      actionId: null,
      fieldPath: null,
      optionsSourceId: 'session.modes.available',
      options: [{ value: 'plan', label: 'Plan' }],
    });
  });

  it('does not misclassify thrown option-resolution failures as unknown action specs', async () => {
    const tools = createActionSpecMcpTools({
      resolveActionOptions: async () => {
        throw new Error('boom');
      },
    });

    const res = await tools.action_options_resolve.handler({
      optionsSourceId: 'session.modes.available',
    });

    expect(res.isError).toBe(true);
    expect(parse(res)).toEqual({
      errorCode: 'action_options_resolve_failed',
      error: 'Options source resolution failed',
    });
  });
});
