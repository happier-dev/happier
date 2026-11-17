import { expect, it } from 'vitest';
import { ActionExecuteFailureSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { deliverExternalActionRequest, dispatchOriginalAccountAction } from './externalActionExecutionAuthorization';
import { resolveOriginalAccountMachineTarget } from './machine/originalAccountTarget';

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

it.each(['target-kind', 'retired-dispatch', 'retired-delivery'] as const)(
  'retains the target-unavailable issuer before an effect (%s)', async branch => {
    const envelope = { v: 1 as const, requestId: 'target-cause-request',
      target: { kind: 'machine' as const, machineId: 'selected-machine' }, input: {} };
    const result = branch === 'retired-delivery'
      ? await deliverExternalActionRequest({ actionId: 'machines.managed.acquire',
        serverHttpBaseUrl: 'https://target-cause.test', envelope, body: envelope,
        headers: {}, isCurrent: async () => false })
      : await dispatchOriginalAccountAction({ actionId: 'machines.managed.acquire', input: {},
        requestId: envelope.requestId,
        target: branch === 'target-kind' ? { kind: 'session', sessionId: 'session' } : envelope.target,
        credentials: { token: 'invalid-token', encryption: null },
        serverHttpBaseUrl: 'https://target-cause.test', isCurrent: async () => false });
    expect(ActionExecuteFailureSchema.parse(result)).toMatchObject({
      ok: false, errorCode: 'target_unavailable',
      failureCause: { phase: branch === 'target-kind' ? 'dispatch.target_kind'
        : branch === 'retired-dispatch' ? 'dispatch.currentness' : 'dispatch.delivery.currentness',
      errorCode: 'target_unavailable' },
    });
  },
);

it('retains the selected Machine issuer when its requester retires after inventory', async () => {
  const result = await resolveOriginalAccountMachineTarget({ actionId: 'machines.managed.acquire',
    machineId: 'selected-machine', machines: [{ id: 'selected-machine', label: 'Selected', kind: 'persistent',
      managedMachineRef: null, installationId: 'installation', active: false, revokedAt: null, replacedByMachineId: null,
      access: { custodian: { accountId: 'requester', displayName: 'Requester' }, role: 'manage',
        resourceMode: 'plain', accessState: 'ready' } }],
    accountId: 'requester', accountMode: 'plain', authenticationKind: 'account', authority: 'present_user',
    credentialProvenance: 'stored_session', managedAdmission: true, isCurrent: async () => false });
  expect(result).toMatchObject({ kind: 'refused', execution: { ok: false, errorCode: 'target_unavailable',
    failureCause: { phase: 'dispatch.machine_selection', errorCode: 'target_unavailable' } } });
});
