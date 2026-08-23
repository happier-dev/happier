import { describe, expect, it } from 'vitest';

import { getActionSpec } from '../actionSpecs.js';

const LOCAL_SERVICE_ACTION_BINDINGS = [
  ['localServices.actions.copyUrl', 'copy_url'],
  ['localServices.actions.openPreview', 'open_preview'],
  ['localServices.actions.forget', 'forget'],
  ['localServices.actions.stopManaged', 'stop_managed'],
  ['localServices.actions.restartManaged', 'restart_managed'],
  ['localServices.actions.terminateDetected', 'terminate_detected'],
] as const;

describe('local-services runtime Action specs', () => {
  it('binds every local-service Action id to exactly one request action', () => {
    const baseRequest = {
      requestId: 'request_1',
      target: {
        kind: 'managed_service' as const,
        managedServiceId: 'managed_1',
        machineId: 'machine_1',
      },
      confirmationNonce: 'confirmation_1',
      force: false,
    };

    for (const [index, [actionId, action]] of LOCAL_SERVICE_ACTION_BINDINGS.entries()) {
      const inputSchema = getActionSpec(actionId).inputSchema;
      const mismatchedAction = LOCAL_SERVICE_ACTION_BINDINGS[
        (index + 1) % LOCAL_SERVICE_ACTION_BINDINGS.length
      ][1];

      expect(inputSchema.safeParse({ ...baseRequest, action }).success, actionId).toBe(true);
      expect(
        inputSchema.safeParse({ ...baseRequest, action: mismatchedAction }).success,
        `${actionId} must reject ${mismatchedAction}`,
      ).toBe(false);
    }
  });
});
