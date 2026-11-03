import { describe, expect, it } from 'vitest';
import { executeAdmittedClientActionChildAtMachine } from './admittedClientActionChild';

describe('admitted client Action child input', () => {
  it('returns a typed refusal for the outside child probed before a mounted Workflow Save', async () => {
    // JQ-R14-FINAL/mounted-draft.cjs awaits this outside-family probe before
    // forwarding the valid definition child. Throwing here stops Save itself.
    expect(await executeAdmittedClientActionChildAtMachine({
      parent: { machineId: 'machine-a', requestId: 'mounted-parent-save' },
      serverId: 'home', accountId: 'account-a', sessionId: 'authoring-session',
      actionId: 'session.list', input: {},
    })).toEqual({ ok: false, errorCode: 'invalid_action_input', error: 'invalid_action_input' });
  });
});
