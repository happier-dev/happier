import { describe, expect, it } from 'vitest';
import { createActionExecutor } from './actionExecutor.js';
import { ActionsSettingsV1Schema } from './actionSettings.js';
import { computeActionInputApprovalDigestV1 } from './decisionAuthority.js';
import type { ActionExecutorContext } from './executor/types.js';

const context: ActionExecutorContext = { surface: 'cli', authority: 'present_user',
  actionCaller: { kind: 'host' }, serverId: 'home', runtimeAccountId: 'owner',
  actionRequestId: 'parent-request', externalActionTarget: { kind: 'machine', machineId: 'machine' },
  actionsSettings: ActionsSettingsV1Schema.parse({ v: 1, actions: {} }) };

describe('generic reviewed host children', () => {
  it('projects the admitted native parent even when its trusted internal children are not predeclared', async () => {
    const input = { serverId: 'home', machineId: 'machine', expectedInstallationId: 'installation' };
    let port: ActionExecutorContext['hostReviewedChild'];
    const executor = createActionExecutor({ machineReboot: async ({ context }) => {
      port = context.hostReviewedChild;
      return { kind: 'unavailable', reason: 'needs_attendance' };
    } });
    expect(await executor.execute('machines.reboot', input, {
      ...context, surface: 'ui', actionRequestId: 'native-parent',
      presentUserConfirmation: { actionId: 'machines.reboot', accountId: 'owner', serverId: 'home',
        requestId: 'native-parent', target: context.externalActionTarget,
        inputDigest: computeActionInputApprovalDigestV1('machines.reboot', input) },
    })).toMatchObject({ ok: true });
    expect(port).toMatchObject({ parent: { actionId: 'machines.reboot', input } });
  });

});
