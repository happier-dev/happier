import { describe, expect, it, vi } from 'vitest';
import { listActionSpecsForCatalogSurface } from './actionCatalog.js';
import { createActionExecutor } from './actionExecutor.js';
import { ACCOUNT_DEVICES_APPROVE_ACTION_ID_V1 as actionId } from './actionIds.js';

describe('device approval Action', () => {
  it.each(['agent', 'mcp'] as const)('denies %s even with present-user authority and approval bypass', async surface => {
    const approveDevice = vi.fn(async () => true);
    const executor = createActionExecutor({ accountDevicesApproveAction: approveDevice });
    const result = await executor.execute(actionId, {}, {
      surface, authority: 'present_user', bypassApprovals: true,
    });
    expect(result).toMatchObject({ ok: false, errorCode: 'action_disabled',
      details: { surface, reason: 'unsupported_surface' } });
    expect(approveDevice).not.toHaveBeenCalled();
    expect(listActionSpecsForCatalogSurface({ surface }).map(action => action.id)).not.toContain(actionId);
  });
});
