import { describe, expect, it } from 'vitest';
import { createActionExecutor } from './actionExecutor.js';
import type { ActionExecutorContext, ActionExecutorDeps } from './executor/types.js';

describe('client Session-open continuation', () => {
  it('resolves an exact Session once per open and retains its leaf through local client delivery', async () => {
    let reads = 0;
    const opened: string[] = [];
    // Authenticated Home resolution and delivery to a client realm are transport
    // boundaries; target binding, admission and the local effect remain real.
    const deps = {
      resolveSessionReference: async ({ sessionId, context }) => {
        reads += 1;
        // Settle a regressed loop at the boundary rather than timing out.
        if (reads > opened.length + 1) return { kind: 'incomplete' as const };
        return { kind: 'unique' as const, address: { serverId: context.serverId!, sessionId: sessionId! } };
      },
      clientActionExecute: async ({ execute }) => execute(),
      sessionOpen: async ({ sessionId }) => { opened.push(sessionId); return { status: 'opened', sessionId }; },
      isActionApprovalRequired: () => false,
    } satisfies ActionExecutorDeps;
    const executor = createActionExecutor(deps);
    const context = {
      serverId: 'home', surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
      expectedSessionAddress: { serverId: 'home', sessionId: 'reviewed' },
    } satisfies ActionExecutorContext;

    const first = await executor.execute('session.open', { sessionId: 'reviewed' }, context);
    expect(reads).toBe(1);
    expect(first).toMatchObject({ ok: true, result: { status: 'opened', sessionId: 'reviewed' } });
    expect(opened).toEqual(['reviewed']);

    // A genuine new request still resolves and opens its newly selected Session.
    expect(await executor.execute('session.open', { sessionId: 'changed' }, {
      ...context, expectedSessionAddress: { serverId: 'home', sessionId: 'changed' },
    })).toMatchObject({ ok: true, result: { status: 'opened', sessionId: 'changed' } });
    expect(reads).toBe(2);
    expect(opened).toEqual(['reviewed', 'changed']);
  });
});
