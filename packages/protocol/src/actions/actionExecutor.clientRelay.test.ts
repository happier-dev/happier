import { describe, expect, it } from 'vitest';
import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';

describe('client placement delivery after canonical admission', () => {
  it.each([
    { actionId: 'ui.find' as const, input: { op: 'read' }, result: { status: 'idle' } },
    { actionId: 'session.pending.next' as const, input: {}, result: { status: 'opened' } },
    { actionId: 'workspace.tabs.list' as const, input: {}, result: { ok: true, tabs: [], groups: [], splits: [], rootNodeId: 'main', focusedGroupId: 'main', maximizedGroupId: null } },
  ])('delivers $actionId on the invoking surface', async ({ actionId, input, result }) => {
    const requests: unknown[] = [];
    const deps = {
      clientActionExecute: async (request: unknown) => { requests.push(request); return { ok: true as const, result }; },
    } as unknown as ActionExecutorDeps;
    const executor = createActionExecutor(deps);
    expect(await executor.execute(actionId, input, { surface: 'mcp', authority: 'account_automation' }))
      .toEqual({ ok: true, result });
    expect(requests).toEqual([expect.objectContaining({ actionId, input, context: expect.objectContaining({ surface: 'mcp', authority: 'account_automation' }) })]);
  });

  it('does not dispatch a danger Action without approval', async () => {
    let issued = false;
    const executor = createActionExecutor({ clientActionExecute: async () => {
      issued = true; return { ok: true, result: {} };
    } } as unknown as ActionExecutorDeps);
    const result = await executor.execute('session.draft.delete', { draftId: '11111111-1111-4111-8111-111111111111' }, { surface: 'agent', authority: 'account_automation' });
    expect(result).toMatchObject({ ok: false, errorCode: 'approvals_not_supported' });
    expect(issued).toBe(false);
  });
});
