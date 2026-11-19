import { describe, expect, it } from 'vitest';
import { listActionSpecsForCatalogSurface } from './actionCatalog.js';
import { createActionExecutor } from './actionExecutor.js';
import { ACCOUNT_TERMINALS_APPROVE_ACTION_ID_V1 } from './actionIds.js';

describe('terminal approval Action', () => {
  it.each(['agent', 'mcp'] as const)('denies %s even with present-user authority and approval bypass', async (surface) => {
    const actionId = ACCOUNT_TERMINALS_APPROVE_ACTION_ID_V1;
    const executor = createActionExecutor({});

    await expect(executor.execute(actionId, {}, { surface, authority: 'present_user', bypassApprovals: true })).resolves.toMatchObject({
      ok: false,
      errorCode: 'action_disabled',
      details: { surface, reason: 'unsupported_surface' },
    });
    expect(listActionSpecsForCatalogSurface({ surface }).map((action) => action.id)).not.toContain(actionId);
  });
});
