import { expect, it } from 'vitest';
import { prepareApprovalRequest } from './approvalPreparation.js';

it('refuses to prepare a saved alert Test without the controller destination disclosure', async () => {
  const input = { serverId: 'home', machineId: 'controller', sourceInstanceId: 'health-source',
    channelId: 'saved-channel', channelIndex: 0, expectedSourceRevision: 'reviewed-revision' };
  const prepared = await prepareApprovalRequest({ deps: {}, actionId: 'notifications.test', input, actionArgs: input,
    context: { surface: 'agent' } });
  expect(prepared).toEqual({ ok: false, errorCode: 'notification_test_preparation_unavailable',
    error: 'notification_test_preparation_unavailable' });
});
