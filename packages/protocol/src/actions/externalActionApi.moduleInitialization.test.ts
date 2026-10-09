import { expect, it } from 'vitest';

it('initializes external Action and Machine pending admission schemas from the external API entry point', async () => {
  const api = await import('./externalActionApi.js');
  const pending = await import('../sessions/messages/sessionPendingMachineAdmissionV1.js');
  expect(api.ExternalActionMachineRpcExecutionV1Schema.safeParse({}).success).toBe(false);
  expect(pending.SessionPendingEnqueueByMachineRequestV1Schema.safeParse({
    v: 1, sessionId: 'session-1', targetMachineId: 'machine-1', localId: 'input-1',
    content: { t: 'encrypted', c: 'cipher' }, requestedAction: { v: 1, kind: 'enqueue' },
  }).success).toBe(true);
});
