import { createActionAutomationPortV1 } from './actionAutomationAdmission.js';
import { createActionExecutor } from '../actionExecutor.js';
import type { ActionExecutorDeps } from './types.js';

/** External admission requires the canonical Automation port; this Account has no checks to select. */
export function createEmptyActionAutomationPortV1(accountId = 'owner') {
  return createActionAutomationPortV1({
    accountId,
    seed: async () => ({ v: 1, rows: [] }),
    settle: async () => {},
  });
}

export function createActionExecutorWithEmptyAutomationPort(deps: ActionExecutorDeps): ReturnType<typeof createActionExecutor> {
  return createActionExecutor({ actionAutomations: createEmptyActionAutomationPortV1(), ...deps });
}
