import { describe, expect, it } from 'vitest';
import { shouldAutoApprovePermissionRequest, autoResolvePendingPermissionRequests } from '../../src/testkit/providers/harness';
import { decryptLegacyBase64 } from '../../src/testkit/messageCrypto';

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
    const secret = new Uint8Array(32);
    const rpcCalls: Array<{ method: string; payload: string }> = [];
    const answers = {
      components: ['alpha-beta', 'gamma', 'Custom, other'],
    } as const;

    const result = await autoResolvePendingPermissionRequests({
      pendingPermissionIds: [{ id: 'perm-1', toolName: 'unknown' }],
      approvedPermissionIds: approvedIds,
      yolo: true,
      allowPermissionAutoApproveInYolo: true,
      decision: 'approved',
      answers,
      sessionId: 'sess-1',
      secret,
      uiSocket: {
        rpcCall: async <T = unknown>(method: string, payload: string) => {
          rpcCalls.push({ method, payload });
          return { ok: true } as T;
        },
      },
    });

    expect(result.blockedInYolo).toEqual([]);
    expect(result.approvedIds).toEqual(['perm-1']);
    expect(approvedIds.has('perm-1')).toBe(true);
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0]?.method).toBe('sess-1:permission');
    expect(decryptLegacyBase64(rpcCalls[0]!.payload, secret)).toEqual({
      id: 'perm-1',
      approved: true,
      decision: 'approved',
      answers,
    });
  });
});
