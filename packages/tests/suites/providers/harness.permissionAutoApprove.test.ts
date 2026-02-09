import { describe, expect, it } from 'vitest';
import { shouldAutoApprovePermissionRequest, autoResolvePendingPermissionRequests } from '../../src/testkit/providers/harness';

describe('providers harness: yolo permission auto-approval guard', () => {
  it('allows scenario opt-in for unexpected yolo permission requests', () => {
    expect(
      shouldAutoApprovePermissionRequest({
        yolo: false,
        allowPermissionAutoApproveInYolo: false,
        toolName: 'Edit',
      }),
    ).toBe(true);

    expect(
      shouldAutoApprovePermissionRequest({
        yolo: true,
        allowPermissionAutoApproveInYolo: false,
        toolName: 'AcpHistoryImport',
      }),
    ).toBe(true);

    expect(
      shouldAutoApprovePermissionRequest({
        yolo: true,
        allowPermissionAutoApproveInYolo: false,
        toolName: 'Edit',
      }),
    ).toBe(false);

    expect(
      shouldAutoApprovePermissionRequest({
        yolo: true,
        allowPermissionAutoApproveInYolo: true,
        toolName: 'Edit',
      }),
    ).toBe(true);
  });

  it('auto-resolves pending requests when yolo auto-approve is enabled', async () => {
    const approvedIds = new Set<string>();
    const rpcCalls: Array<{ method: string }> = [];

    const result = await autoResolvePendingPermissionRequests({
      pendingPermissionIds: [{ id: 'perm-1', toolName: 'unknown' }],
      approvedPermissionIds: approvedIds,
      yolo: true,
      allowPermissionAutoApproveInYolo: true,
      decision: 'approved',
      sessionId: 'sess-1',
      secret: new Uint8Array(32),
      uiSocket: {
        rpcCall: async (method: string) => {
          rpcCalls.push({ method });
          return { ok: true };
        },
      },
    });

    expect(result.blockedInYolo).toEqual([]);
    expect(result.approvedIds).toEqual(['perm-1']);
    expect(approvedIds.has('perm-1')).toBe(true);
    expect(rpcCalls).toEqual([{ method: 'sess-1:permission' }]);
  });
});
