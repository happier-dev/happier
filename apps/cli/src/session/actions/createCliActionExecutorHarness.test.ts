import { describe, expect, it, vi } from 'vitest';

import { createCliActionExecutorHarness } from './createCliActionExecutorHarness';

describe('createCliActionExecutorHarness', () => {
  it('lets callers override action approval policy for a specific runtime surface', async () => {
    const approvalsCreate = vi.fn(async () => ({ artifactId: 'approval_1' }));
    const sessionList = vi.fn(async () => ({ ok: true, sessions: [] }));
    const harness = createCliActionExecutorHarness(
      {
        token: 'token',
        sessionId: 'sess_1',
        ctx: {
          encryptionKey: new Uint8Array(32).fill(1),
          encryptionVariant: 'legacy',
        },
      },
      {
        approvalsCreate,
        sessionList,
        isActionApprovalRequired: (id, ctx) => id === 'session.list' && ctx.surface === 'session_agent',
      },
    );

    const result = await harness.executor.execute(
      'session.list',
      { limit: 20 },
      { surface: 'session_agent', defaultSessionId: 'sess_1' },
    );

    expect(result).toMatchObject({
      ok: true,
      result: {
        kind: 'approval_request_created',
        artifactId: 'approval_1',
        actionId: 'session.list',
      },
    });
    expect(approvalsCreate).toHaveBeenCalledTimes(1);
    expect(sessionList).not.toHaveBeenCalled();
  });
});
