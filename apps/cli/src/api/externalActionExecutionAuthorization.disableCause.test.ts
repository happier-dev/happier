import { expect, it } from 'vitest';
import { ActionExecuteFailureSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { dispatchOriginalAccountAction } from './externalActionExecutionAuthorization';

it.each([
  ['requester authentication', false, 'dispatch.requester_authentication'],
  ['workflow invocation', true, 'dispatch.workflow_invocation'],
] as const)('retains the plugins.disable admission issuer for %s without relabeling it', async (_name, workflow, phase) => {
  const result = await dispatchOriginalAccountAction({
    actionId: 'plugins.disable', input: { pluginId: 'happier.scm.forge.github', machineId: 'machine' },
    requestId: 'disable-cause-request', target: { kind: 'machine', machineId: 'machine' },
    credentials: { token: 'invalid-token', encryption: null },
    serverHttpBaseUrl: 'https://disable-cause.test', serverIdentityId: 'srv_disable_cause',
    ...(workflow ? { installedWorkflow: { context: { surface: 'cli', actionRequestId: 'disable-cause-request' },
      machineId: 'machine', installationId: 'installation', privateKey: new Uint8Array(64) } } : {}),
  });
  expect(ActionExecuteFailureSchema.parse(result)).toMatchObject({
    ok: false, errorCode: 'admission_unavailable', effectAttempted: false,
    failureCause: { phase, errorCode: 'admission_unavailable' },
  });
});
