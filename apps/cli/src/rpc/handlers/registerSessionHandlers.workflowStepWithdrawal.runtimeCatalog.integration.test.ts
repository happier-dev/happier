import { describe, expect, it } from 'vitest';

import { createWorkflowStepWithdrawal } from '@/agent/runtime/session/contextOnly/workflowStepWithdrawal';
import { applySessionRuntimeControls } from '@/api/session/sessionRuntimeControls';
import { createEncryptedRpcTestClient } from './encryptedRpc.testkit';
import { registerSessionHandlers } from './registerSessionHandlers';
import type { SessionRuntimeControls } from './sessionControls';

const method = 'session.workflowStep.withdraw';
const unsupported = {
  ok: false,
  errorCode: 'unsupported_session_runtime_method',
  error: `unsupported_session_runtime_method:${method}`,
};

describe('Session workflow-step withdrawal RPC', () => {
  it('uses the current runtime owner and preserves its exact replay outcome across encrypted RPC', async () => {
    const controls: SessionRuntimeControls = {};
    const client = createEncryptedRpcTestClient({
      scopePrefix: 'session-1',
      registerHandlers: (registrar) => registerSessionHandlers(registrar, process.cwd(), {
        sessionId: 'session-1',
        sessionRuntimeControls: controls,
      }),
    });
    await expect(client.call(method, { localInputId: 'step-1' })).resolves.toEqual(unsupported);

    const owner = createWorkflowStepWithdrawal({ reportWithdrawn: async () => undefined });
    owner.claimDispatch({ localInputId: 'step-dispatched' }, () => undefined);
    applySessionRuntimeControls(controls, {
      withdrawWorkflowStepInput: owner.withdrawWorkflowStepInput,
    });

    await expect(client.call(method, { localInputId: 'step-1' })).resolves.toBe('withdrawn');
    await expect(client.call(method, { localInputId: 'step-1' })).resolves.toBe('withdrawn');
    await expect(client.call(method, { localInputId: 'step-dispatched' })).resolves.toBe('dispatched');
    await expect(client.call(method, { localInputId: 'step-dispatched' })).resolves.toBe('dispatched');

    applySessionRuntimeControls(controls, null);
    await expect(client.call(method, { localInputId: 'step-1' })).resolves.toEqual(unsupported);
  });

  it('rejects malformed or extended input before the runtime owns any withdrawal', async () => {
    const owner = createWorkflowStepWithdrawal({ reportWithdrawn: async () => undefined });
    const client = createEncryptedRpcTestClient({
      scopePrefix: 'session-1',
      registerHandlers: (registrar) => registerSessionHandlers(registrar, process.cwd(), {
        sessionId: 'session-1',
        sessionRuntimeControls: { withdrawWorkflowStepInput: owner.withdrawWorkflowStepInput },
      }),
    });
    for (const input of [[], {}, { localInputId: '' }, { localInputId: '   ' },
      { localInputId: 1 }, { localInputId: 'step-1', runId: 'untrusted' }]) {
      await expect(client.call(method, input)).resolves.toEqual({
        ok: false,
        errorCode: 'invalid_parameters',
        error: 'invalid_parameters',
      });
    }
    expect(owner.isWithdrawn({ localInputId: 'step-1' })).toBe(false);
    expect(owner.claimDispatch({ localInputId: 'step-1' }, () => undefined)).toBe(true);
    await expect(client.call(method, { localInputId: 'step-1' })).resolves.toBe('dispatched');
  });
});
