import { describe, expect, it } from 'vitest';
import { ActionExecuteFailureSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { executeMachineGuardAction } from './machineGuard';

describe('executeMachineGuardAction output validation', () => {
  it('keeps the Action, failing path and issue code, but never the rejected value', async () => {
    const result = await executeMachineGuardAction({ actionId: 'machines.guard.get', input: { machineId: 'machine-1' },
      serverId: 'home', assertCurrent: async () => {},
      // The exact-Machine RPC is the network boundary; the response is malformed.
      call: async () => ({ memory: 'secret-rejected-value' }) });
    const failure = ActionExecuteFailureSchema.parse(result);
    expect(failure.errorCode).toBe('invalid_action_output');
    expect(failure.failureCause).toMatchObject({ phase: 'machines.guard.get' });
    expect(failure.details).toMatchObject({ issues: expect.arrayContaining([expect.objectContaining({ code: expect.any(String), path: expect.any(Array) })]) });
    expect(JSON.stringify(failure)).not.toContain('secret-rejected-value');
  });
});
