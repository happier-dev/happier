import { describe, expect, it } from 'vitest';

import { ApprovalRequestV2StatusSchema, isApprovalRequestV2InFlightStatus, isApprovalRequestV2TerminalStatus } from './approvalRequestV1.js';

describe('approval request V2 status partition', () => {
  it('splits every status into exactly one of in-flight or terminal', () => {
    for (const status of ApprovalRequestV2StatusSchema.options) {
      expect(isApprovalRequestV2InFlightStatus(status), status).toBe(!isApprovalRequestV2TerminalStatus(status));
    }
    expect(isApprovalRequestV2InFlightStatus('executing')).toBe(true);
    expect(isApprovalRequestV2TerminalStatus('outcome_unknown')).toBe(true);
    expect(isApprovalRequestV2InFlightStatus(undefined)).toBe(false);
    expect(isApprovalRequestV2TerminalStatus('nope')).toBe(false);
  });
});
