import { describe, expect, it } from 'vitest';
import { decryptLegacyBase64 } from '../../src/testkit/messageCrypto';
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
        rpcCall: async <T = unknown>(method: string, _payload: string) => {
          rpcCalls.push({ method });
          return { ok: true } as T;
        },
      },
    });

    expect(result.blockedInYolo).toEqual([]);
    expect(result.approvedIds).toEqual(['perm-1']);
    expect(approvedIds.has('perm-1')).toBe(true);
    expect(rpcCalls).toEqual([{ method: 'sess-1:permission' }]);
  });

  it.each(['AskUserQuestion', 'ask_user_question'] as const)('answers %s structured questions through the receiver-enforced v1 method without legacy flattening', async (toolName) => {
    const secret = new Uint8Array(32);
    const rpcCalls: Array<{ method: string; payload: string }> = [];
    const structuredAnswersV1 = Object.assign(Object.create(null), {
      location: ['Washington, D.C.', '__proto__'],
    });

    const result = await autoResolvePendingPermissionRequests({
      pendingPermissionIds: [{ id: 'question-1', toolName }],
      approvedPermissionIds: new Set<string>(),
      yolo: true,
      allowPermissionAutoApproveInYolo: true,
      decision: 'approved',
      structuredAnswersV1,
      sessionId: 'sess-1',
      secret,
      uiSocket: {
        rpcCall: async <T = unknown>(method: string, payload: string) => {
          rpcCalls.push({ method, payload });
          return { ok: true } as T;
        },
      },
    });

    expect(result.approvedIds).toEqual(['question-1']);
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0]?.method).toBe('sess-1:session.structuredQuestion.respond.v1');
    expect(decryptLegacyBase64(rpcCalls[0]!.payload, secret)).toEqual({
      id: 'question-1',
      structuredAnswersV1: {
        location: ['Washington, D.C.', '__proto__'],
      },
    });
  });
});
