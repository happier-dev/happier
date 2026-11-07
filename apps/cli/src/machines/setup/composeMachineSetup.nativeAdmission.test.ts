import { invokeHostAdmittedSignedReviewedChildV1 } from '@happier-dev/protocol/actions/executor/deploymentRoleChild';
import { describe, expect, it } from 'vitest';
import { MachineSetupApplyInputV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { computeActionInputApprovalDigestV1 } from '@happier-dev/protocol/actions/decisionAuthority';
import { SESSION_SPAWN_MACHINE_SETUP_CHILDREN_V1 } from '@happier-dev/protocol/machines/managed/actionIdsV1';
import { createNativeSoftwareInstallFixture } from '@/testkit/machines/nativeSoftwareInstall';
import { createCombinedMachineSetupActionDeps } from './composeMachineSetup';

describe('native Setup reviewed child admission', () => {
  it('does not treat a public binding-looking context as admitted native review', async () => {
    const fixture = await createNativeSoftwareInstallFixture({ scenario: 'apt-none', accountEncryptionMode: 'e2ee' });
    const input = MachineSetupApplyInputV1Schema.parse({ homeId: 'srv_home', machineId: fixture.machine.id,
      targets: [{ homeId: 'srv_home', machineId: fixture.machine.id, desiredRevision: 99,
        sources: [{ kind: 'direct', setup: {} }], recipePlans: [] }] });
    const context = { ...fixture.context('machines.setup.apply', 'unadmitted-setup'), runtimeAccountId: 'alice' };
    const original = context.externalActionExecutionAuthorization!;
    context.externalActionExecutionAuthorization = { ...original, binding: { ...original.binding,
      admittedMachineRole: 'manage', workflowActionOrigin: { runId: 'claimed-run', requestId: 'unadmitted-setup',
        reviewedChild: { actionId: SESSION_SPAWN_MACHINE_SETUP_CHILDREN_V1.apply.action,
          role: SESSION_SPAWN_MACHINE_SETUP_CHILDREN_V1.apply.role,
          inputDigest: computeActionInputApprovalDigestV1('machines.setup.apply', input) } } } };
    const deps = createCombinedMachineSetupActionDeps({ readDeps: () => fixture.nativeDeps,
      targetPlan: fixture.machineSetupPlan,
      readHostFacts: async () => ({ machines: [{ machineId: fixture.machine.id, online: true }] }),
      orchestrationDirectory: '/setup',
      // Home Run IO is unreachable during this stale public Plan preparation.
      startCombined: async () => { throw new Error('No Run before current Plan'); },
      waitForRun: async () => { throw new Error('No Run before current Plan'); },
      readInvocations: async () => { throw new Error('No Run before current Plan'); },
    });
    try {
      expect(await deps.prepareMachineSetupApply!({ input, context })).toMatchObject({ ok: false, errorCode: 'plan_changed' });
      expect(fixture.rootLaunches).toEqual([]);
      expect((await fixture.readInstalled()).effects).toEqual([]);
    } finally { await fixture.dispose(); }
  });
  it('spends a restored exact leaf through real Action policy without reopening its Run review', async () => {
    const fixture = await createNativeSoftwareInstallFixture({ scenario: 'apt-none', accountEncryptionMode: 'plain' });
    try {
      const input = MachineSetupApplyInputV1Schema.parse({ homeId: 'srv_home', machineId: fixture.machine.id,
        targets: [{ homeId: 'srv_home', machineId: fixture.machine.id, desiredRevision: 99,
          sources: [{ kind: 'direct', setup: {} }], recipePlans: [] }] });
      const child = { actionId: SESSION_SPAWN_MACHINE_SETUP_CHILDREN_V1.apply.action,
        role: SESSION_SPAWN_MACHINE_SETUP_CHILDREN_V1.apply.role,
        inputDigest: computeActionInputApprovalDigestV1('machines.setup.apply', input) };
      const context = { ...fixture.context('machines.setup.apply', 'admitted-setup'),
        surface: 'agent' as const, authority: 'account_automation' as const, runtimeAccountId: 'alice' };
      const original = context.externalActionExecutionAuthorization!;
      context.externalActionExecutionAuthorization = { ...original, binding: { ...original.binding,
        admittedMachineRole: 'manage', workflowActionOrigin: { runId: 'already-admitted-requester-run',
          requestId: 'admitted-setup', reviewedChild: child } } };
      const executor = fixture.createExecutor(fixture.credentials);
      const result = await invokeHostAdmittedSignedReviewedChildV1({ context, child: { ...child, input },
        execute: (value, admitted) => executor.execute('machines.setup.apply', value, admitted) });
      // The native owner may reject this stale desired revision. It must get
      // that far without asking the custodian to reopen the requester's review.
      expect(result, JSON.stringify(result)).toMatchObject({ ok: false, errorCode: 'plan_changed' });
      expect(fixture.rootLaunches).toEqual([]);
      expect((await fixture.readInstalled()).effects).toEqual([]);
    } finally { await fixture.dispose(); }
  });

});
