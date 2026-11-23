import { createActionAutomationPortV1 } from './actionAutomationAdmission.js';

/** External admission requires the canonical Automation port; this Account has no checks to select. */
export function createEmptyActionAutomationPortV1(accountId = 'owner') {
  return createActionAutomationPortV1({
    accountId,
    seed: async () => ({ v: 1, rows: [] }),
    settle: async () => {},
  });
}
