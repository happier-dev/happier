import { describe, expect, it } from 'vitest';

import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';
import { getActionSpec } from './actionSpecs.js';

describe('app shell Actions', () => {
  it.each(['session.work.get', 'inbox.get'] as const)('exposes %s as a strict client read with explicit availability', (actionId) => {
    const spec = getActionSpec(actionId);
    expect(spec.executionPlacement).toBe('client');
    expect(spec.sideEffectClass).toBe('read');
    expect(spec.requiredAuthority).toBe('account_automation');
    expect(spec.surfaces.agent).toBe(true);
    expect(spec.inputSchema.safeParse(actionId === 'session.work.get'
      ? { sessionId: 'lead' } : {}).success).toBe(true);
    expect(spec.inputSchema.safeParse({ unknown: true }).success).toBe(false);
    expect(spec.outputSchema?.safeParse({ status: 'unavailable' }).success).toBe(true);
    expect(spec.outputSchema?.safeParse({ status: 'ready', rawStore: {} }).success).toBe(false);
  });
  it('registers ordinary automated Inbox acknowledgement over exact Home addresses', () => {
    const spec = getActionSpec('inbox.mark_all_read');
    expect(spec.requiredAuthority).toBe('account_automation');
    expect(spec.inputSchema.safeParse({ targets: [{ serverId: 'home-a', sessionId: 'session-a' }] }).success).toBe(true);
    expect(spec.inputSchema.safeParse({ targets: [{ sessionId: 'session-a' }] }).success).toBe(false);
    expect(spec.surfaces.agent).toBe(true);
    expect(spec.surfaces.mcp).toBe(true);
  });

  it.each(['agent', 'mcp'] as const)('allows %s to mark an Inbox snapshot read without confirmation', async (surface) => {
    const executor = createActionExecutor({
      appShellAction: async () => ({ results: [{ serverId: 'home-a', sessionId: 'session-a', status: 'succeeded' }] }),
    } as unknown as ActionExecutorDeps);
    await expect(executor.execute('inbox.mark_all_read', {
      targets: [{ serverId: 'home-a', sessionId: 'session-a' }],
    }, { surface, authority: 'account_automation' })).resolves.toEqual({
      ok: true, result: { results: [{ serverId: 'home-a', sessionId: 'session-a', status: 'succeeded' }] },
    });
  });

  it('retains exact Home addresses and partial acknowledgement outcomes', async () => {
    const calls: unknown[] = [];
    const executor = createActionExecutor({
      appShellAction: async (args: unknown) => {
        calls.push(args);
        return { results: [
          { serverId: 'home-a', sessionId: 'same-id', status: 'succeeded' },
          { serverId: 'home-b', sessionId: 'same-id', status: 'failed' },
        ] };
      },
      isActionApprovalRequired: () => false,
    } as unknown as ActionExecutorDeps);
    const input = { targets: [
      { serverId: 'home-a', sessionId: 'same-id' },
      { serverId: 'home-b', sessionId: 'same-id' },
    ] };
    const context = { surface: 'ui' as const, authority: 'present_user' as const };
    await expect(executor.execute('inbox.mark_all_read', input, context)).resolves.toEqual({
      ok: true,
      result: { results: [
        { serverId: 'home-a', sessionId: 'same-id', status: 'succeeded' },
        { serverId: 'home-b', sessionId: 'same-id', status: 'failed' },
      ] },
    });
    expect(calls).toEqual([{ actionId: 'inbox.mark_all_read', input, context }]);
  });

  it('refuses draft deletion when its client owner is unavailable', async () => {
    const executor = createActionExecutor({ isActionApprovalRequired: () => false } as unknown as ActionExecutorDeps);
    await expect(executor.execute('session.draft.delete', { draftId: '00000000-0000-4000-8000-000000000001' }, {
      surface: 'ui', authority: 'present_user',
    })).resolves.toMatchObject({ ok: false, errorCode: 'unsupported_action' });
  });
});
