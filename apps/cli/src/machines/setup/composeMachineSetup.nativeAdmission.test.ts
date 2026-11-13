import axios from 'axios';
import nacl from 'tweetnacl';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { invokeHostReviewedChildV1 } from '@happier-dev/protocol/actions/actionExecutor';
import { ExternalActionExecutionAuthorizationRequestV1Schema, ExternalActionExecutionAuthorizationV1Schema,
  projectDeploymentPreparationAdmissionV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { dispatchOriginalAccountAction, verifyExternalActionExecutionAuthorizationCurrent } from '@/api/externalActionExecutionAuthorization';
import { executeExternalAction } from '@/daemon/externalActions/executeExternalAction';
import { createDaemonExternalActionTargetResolver } from '@/daemon/externalActions/daemonExternalActionTargetResolver';
import { invokeHostAdmittedSignedReviewedChildV1 } from '@happier-dev/protocol/actions/executor/deploymentRoleChild';
import { describe, expect, it, vi } from 'vitest';
import { MachineSetupApplyInputV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { computeActionInputApprovalDigestV1 } from '@happier-dev/protocol/actions/decisionAuthority';
import { ActionOperationGetV1ResponseSchema } from '@happier-dev/protocol/actions/operations/v1';
import { ActionOperationAcceptedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
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
  it.each([false, true])('spends a restored exact leaf through real Action policy without reopening its Run review (app intent=%s)', async hasApps => {
    const fixture = await createNativeSoftwareInstallFixture({ scenario: 'apt-none', accountEncryptionMode: 'plain' });
    try {
      const input = MachineSetupApplyInputV1Schema.parse({ homeId: 'srv_home', machineId: fixture.machine.id,
        targets: [{ homeId: 'srv_home', machineId: fixture.machine.id, desiredRevision: 99,
          sources: [{ kind: 'direct', setup: hasApps ? { items: [{ kind: 'app', definition: {
            name: 'Retained app', project: { kind: 'existing', projectSourceId: 'project' },
            definition: { from: 'catalogApp', templateRef: { sourceId: 'apps', itemId: 'app', version: '1',
              ref: { kind: 'version', version: '1' } } }, bindings: [],
          } }] } : {} }], recipePlans: [] }] });
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
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
      if (!result.ok) throw new Error('Native Apply admission failed');
      const receipt = ActionOperationAcceptedResultSchema.parse(result.result);
      const settled = ActionOperationGetV1ResponseSchema.parse(await fixture.operations.handlers.getV2(
        { operationId: receipt.operationId, waitForTerminal: true }, context));
      expect(settled).toMatchObject({ kind: 'found', operation: { state: 'failed', error: { errorCode: 'plan_changed' } } });
      expect(fixture.rootLaunches).toEqual([]);
      expect((await fixture.readInstalled()).effects).toEqual([]);
    } finally { await fixture.dispose(); }
  });

  it.each(['plain', 'e2ee'] as const)('delivers a private reviewed leaf from a different Machine to the real native decider (%s)', async mode => {
    const fixture = await createNativeSoftwareInstallFixture({ scenario: 'apt-none', accountEncryptionMode: mode });
    const sourceKey = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(71));
    const source = { kind: 'machine' as const, machineId: 'publisher-machine' };
    const target = { kind: 'machine' as const, machineId: fixture.machine.id };
    const input = MachineSetupApplyInputV1Schema.parse({ homeId: 'srv_home', machineId: target.machineId,
      targets: [{ homeId: 'srv_home', machineId: target.machineId, desiredRevision: 99,
        sources: [{ kind: 'direct', setup: {} }], recipePlans: [] }] });
    const parentInput = { ...input, machineId: source.machineId,
      targets: [{ ...input.targets[0]!, machineId: source.machineId }, ...input.targets] };
    const original = fixture.context('machines.setup.apply', 'root-review').externalActionExecutionAuthorization!;
    const parent = ExternalActionExecutionAuthorizationV1Schema.parse({ ...original, binding: { ...original.binding,
      machineId: source.machineId, installationId: 'publisher-installation', target: source,
      admittedMachineRole: 'manage', accountEncryptionMode: mode } });
    const requestId = 'reviewed-run/second-machine/0';
    const runId = '11111111-1111-4111-8111-111111111111';
    const context = { ...fixture.context('machines.setup.apply', requestId), surface: 'ui' as const, runtimeAccountId: 'alice',
      externalActionExecutionAuthorization: parent, externalActionTarget: source,
      executionRunWorkflowRunId: runId, actionCaller: { kind: 'workflowRun' as const, runId,
        authorization: { principal: { kind: 'host' as const }, admittedPermissionCeiling: 'default' as const,
          externalActionExecutionAuthorization: parent } } };
    const executor = fixture.createExecutor(fixture.credentials);
    const get = vi.spyOn(axios, 'get').mockImplementation(async url => {
      // The installed native owner resolves its own custodian identity only.
      if (String(url).endsWith('/v1/account/profile')) return { status: 200, data: { id: 'alice' } };
      expect(String(url)).toBe('https://home.test/v1/machines/' + target.machineId);
      return { status: 200, data: { machine: { id: target.machineId, kind: 'persistent', active: true,
        managedMachineRef: null, installationId: fixture.installation.installationId, revokedAt: null,
        replacedByMachineId: null, dataEncryptionKey: null, runnerContentKeyBinding: null,
        installationPublicKey: Buffer.from(fixture.pair.publicKey).toString('base64'),
        access: { custodian: { accountId: 'alice', displayName: 'Receiver' }, role: 'manage',
          resourceMode: mode, accessState: 'ready' } } } };
    });
    let boundaryFailure: unknown;
    const post = vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
      try {
      if (String(url).endsWith('/verify')) return { status: 200, data: { ok: true } };
      const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
      if (String(url).endsWith('/execution-authorization')) {
        expect(request.workflowActionOrigin?.reviewedChild).toMatchObject({ actionId: 'machines.setup.apply',
          role: 'setup-1', inputDigest: computeActionInputApprovalDigestV1('machines.setup.apply', input) });
        return { status: 200, data: ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'reviewed-native-child',
          binding: { ...parent.binding, actionId: 'machines.setup.apply', requestId, machineId: target.machineId,
            installationId: fixture.installation.installationId, target,
            workflowActionOrigin: request.workflowActionOrigin,
            deploymentPreparationAdmission: projectDeploymentPreparationAdmissionV1('machines.setup.apply', input),
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope) } }) };
      }
      expect(String(url)).toBe('https://home.test/v1/actions/machines.setup.apply');
      const authorization = request.executionAuthorization!;
      const received = await executeExternalAction({ actionId: 'machines.setup.apply', envelope: request.envelope,
        principal: { accountId: 'alice', authentication: { kind: 'account', tokenEpoch: 0 }, authority: 'account_automation',
          workflowActionOrigin: authorization.binding.workflowActionOrigin },
        currentMachineId: target.machineId, currentAccountId: 'alice', currentServerId: 'fixture-home',
        currentServerHttpBaseUrl: 'https://home.test', currentInstallationId: fixture.installation.installationId,
        executionAuthorization: authorization, machineAdmission: fixture.context('machines.setup.apply').machineAdmission,
        externalActionMachineRequestPrivateKey: fixture.pair.secretKey,
        verifyExecutionAuthorization: value => verifyExternalActionExecutionAuthorizationCurrent({ ...value,
          installationId: fixture.installation.installationId, privateKey: fixture.pair.secretKey, serverHttpBaseUrl: 'https://home.test' }),
        resolveTarget: createDaemonExternalActionTargetResolver({ credentials: fixture.credentials }), executor });
      expect(received.kind).toBe('response');
      if (received.kind !== 'response') throw new Error('Native receiver produced no response');
      return { status: 200, data: received.response };
      } catch (error) { boundaryFailure = error; throw error; }
    });
    try {
      const result = await invokeHostReviewedChildV1({ parent: { actionId: 'machines.setup.apply', input: parentInput },
        child: { action: 'machines.setup.apply', role: 'setup-1', input }, context, approvedBy: { accountId: 'alice' },
        admittedReview: { action: 'machines.setup.apply', role: 'setup-1', surface: 'ui' },
        execute: (_input, issued) => dispatchOriginalAccountAction({ actionId: 'machines.setup.apply', input,
          requestId, target, credentials: fixture.credentials, serverHttpBaseUrl: 'https://home.test', serverIdentityId: 'srv_home',
          installedWorkflow: { context: issued, machineId: source.machineId, installationId: 'publisher-installation', privateKey: sourceKey.secretKey } }) });
      if (boundaryFailure) throw boundaryFailure;
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
      if (!result.ok) throw new Error('Signed native child admission failed');
      const receipt = ActionOperationAcceptedResultSchema.parse(result.result);
      const settled = ActionOperationGetV1ResponseSchema.parse(await fixture.operations.handlers.getV2(
        { operationId: receipt.operationId, waitForTerminal: true }, fixture.context('machines.setup.apply')));
      if (boundaryFailure) throw boundaryFailure;
      // Stale native review is conclusive: it reached the real native owner,
      // without opening or starting any requester Run on the receiving Machine.
      expect(settled, JSON.stringify(settled)).toMatchObject({ kind: 'found', operation: { state: 'failed', error: { errorCode: 'plan_changed' } } });
      expect(fixture.rootLaunches).toEqual([]);
      expect((await fixture.readInstalled()).effects).toEqual([]);
    } finally { get.mockRestore(); post.mockRestore(); await fixture.dispose(); }
  });

});
