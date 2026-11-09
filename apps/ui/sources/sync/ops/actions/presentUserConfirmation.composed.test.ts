import { expect, it } from 'vitest';
import { admitPresentUserConfirmationV1 } from '../../../../../../packages/protocol/src/actions/executor/approvalReview';
import { MachineSetupApplyInputV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';

import { bindPresentUserActionConfirmation } from './presentUserConfirmation';

it.each(['ui', 'voice'] as const)('never lends the confirmed operand to a different resolved Session target (%s)', surface => {
  const actionId = 'session.message.send';
  const input = { sessionId: { selector: 'self', of: 'prefix' }, message: 'hello' };
  const snapshot = { actionId, field: 'sessionId', selector: false,
    targets: [{ serverId: 'srv_home', sessionId: 'original' }] };
  const context = bindPresentUserActionConfirmation(actionId, input, { surface, authority: 'present_user',
    actionCaller: { kind: 'host' }, runtimeAccountId: 'alice', serverIdentityId: 'srv_home',
    actionRequestId: 'reviewed-message', sessionTargetsV1: snapshot });
  expect(admitPresentUserConfirmationV1(actionId, input, { ...context, sessionTargetsV1: { ...snapshot,
    targets: [{ serverId: 'srv_home', sessionId: 'replacement' }] } })).toBeNull();
  expect(admitPresentUserConfirmationV1(actionId, input, context)).toMatchObject({ actionId, requestSurface: surface });
});

it('does not admit a changed workspace through the original mutable confirmation target', () => {
  const actionId = 'machines.setup.apply';
  const input = MachineSetupApplyInputV1Schema.parse({ homeId: 'srv_home', machineId: 'machine', targets: [{
    homeId: 'srv_home', machineId: 'machine', desiredRevision: 0, recipePlans: [],
    sources: [{ kind: 'direct', setup: { scripts: [{ body: 'echo reviewed' }] } }],
  }] });
  const target = { kind: 'machine' as const, machineId: 'machine',
    project: { machineId: 'machine', directory: '/reviewed' } };
  const context = bindPresentUserActionConfirmation(actionId, input, { surface: 'ui', authority: 'present_user',
    actionCaller: { kind: 'host' }, runtimeAccountId: 'alice', serverIdentityId: 'srv_home',
    actionRequestId: 'reviewed-apply', externalActionTarget: target });
  expect(context.presentUserConfirmation).toBeDefined();

  target.project.directory = '/changed';
  expect(admitPresentUserConfirmationV1(actionId, input, context)).toBeNull();
});
