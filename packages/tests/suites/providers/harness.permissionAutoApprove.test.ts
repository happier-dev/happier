import { describe, expect, it } from 'vitest';
import { shouldAutoApprovePermissionRequest } from '../../src/testkit/providers/harness';

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
});
