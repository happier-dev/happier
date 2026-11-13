import axios, { AxiosHeaders } from 'axios';
import { onTestFinished, vi } from 'vitest';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { computeActionInputApprovalDigestV1 } from '@happier-dev/protocol/actions/decisionAuthority';
import {
  ExternalActionExecutionAuthorizationRequestV1Schema,
  ExternalActionExecutionAuthorizationV1Schema,
  ExternalActionRequestEnvelopeSchema,
  bindExternalActionExecutionAuthorizationHttpPathV1,
  bindExternalActionExecutionAuthorizationVerifyHttpPathV1,
  EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER,
  EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER,
  EXTERNAL_ACTION_RESOLVED_TARGET_HEADER,
  projectExternalActionDeploymentPreparationEnvelopeAdmissionV1,
  type ExternalActionExecutionAuthorizationV1,
} from '@happier-dev/protocol/actions/externalActionApi';
import {
  computeExternalActionRequestEnvelopeDigestV1,
  decodeExternalActionResolvedTargetV1,
  verifyExternalActionMachineRequestV1,
} from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import {
  MachineSetupApplyInputV1Schema,
  MachineSetupApplyResultV1Schema,
  MachineSetupPlanInputV1Schema,
  MachineSetupPlanResultV1Schema,
  MachineSetupRemoveInputV1Schema,
  MachineSetupUpdatesApplyInputV1Schema,
  MachineSetupUpdatesRolloutInputV1Schema,
  machineSetupApplyTargetFromPlanV1,
} from '@happier-dev/protocol/machines/managed/actionsV1';
import { MachineAccessRecipientCensusResponseV1Schema } from '@happier-dev/protocol/machines/machineAccessV1';
import { machineSetupItemKeyV1 } from '@happier-dev/protocol';
import { MachineSetupTargetUnavailableFailureV1Schema } from '@happier-dev/protocol/actions/operations/v1';
import { createNativeSoftwareInstallFixture } from '../../../../../apps/cli/src/testkit/machines/nativeSoftwareInstall';
import { createNativeSoftwareOsFixture } from '../../../../../apps/cli/src/testkit/machines/nativeSoftwareOs';
import { exercisePublicPackagePlanApply } from '../../../../../apps/cli/src/testkit/machines/nativeSoftwareInstallFlow';
import { createMachineSetupUpdatesAction, prepareMachineSetupUpdatesPlanV1 } from '../../../../../apps/cli/src/machines/setup/machineSetupUpdatesAction';
import { prepareMachineAccessKeyEnvelopes } from '../../../../../apps/cli/src/api/machineAccessGrantEnvelopeHost';

const homeId = 'srv_home';
type SoftwareFixture = Awaited<ReturnType<typeof createNativeSoftwareInstallFixture>>;

function requireProducerOutput(output: unknown): unknown {
  if (output && typeof output === 'object' && 'ok' in output && output.ok === false) {
    const code = 'errorCode' in output && typeof output.errorCode === 'string' ? output.errorCode : 'unknown';
    const details = 'details' in output && output.details && typeof output.details === 'object'
      && 'failure' in output.details ? MachineSetupTargetUnavailableFailureV1Schema.safeParse(output.details.failure) : undefined;
    throw new Error(`Native setup producer refused the fixture invocation: ${code}${details?.success
      ? ` (${details.data.branch}/${details.data.reason ?? 'unknown'})` : ''}`);
  }
  return output;
}

/** Each case owns a temporary native Home. The existing fixture supplies real
 * SDK recipes, installed setup Actions, native scripts and operation receipts. */
export async function createSetupOutputFixture() {
  let native: SoftwareFixture | undefined;
  let lifetime: Promise<void> | undefined;
  let release: (() => void) | undefined;
  const open = async () => {
    if (native) return native;
    let ready!: (fixture: SoftwareFixture) => void;
    let fail!: (error: unknown) => void;
    const available = new Promise<SoftwareFixture>((resolve, reject) => { ready = resolve; fail = reject; });
    const released = new Promise<void>(resolve => { release = resolve; });
    lifetime = exercisePublicPackagePlanApply('native-confirm', false, async fixture => {
      ready(fixture);
      await released;
    });
    void lifetime.catch(fail);
    onTestFinished(close);
    return native = await available;
  };
  const close = async () => {
    native = undefined;
    release?.();
    release = undefined;
    const previous = lifetime;
    lifetime = undefined;
    await previous;
  };
  const plan = async () => {
    const fixture = await open();
    return MachineSetupPlanResultV1Schema.parse(await fixture.machineSetupPlan({
      input: { homeId, machineId: fixture.machine.id, sources: fixture.sources, mode: 'effects' },
      context: fixture.context('machines.setup.plan'),
    }));
  };
  const applyInput = async () => {
    const fixture = await open();
    const reviewed = await plan();
    const target = { homeId, machineId: fixture.machine.id };
    return MachineSetupApplyInputV1Schema.parse({ ...target,
      targets: [machineSetupApplyTargetFromPlanV1(target, reviewed)] });
  };
  const updatesInput = async () => {
    const fixture = await open();
    const reviewed = MachineSetupPlanResultV1Schema.parse(await fixture.machineSetupPlan({
      input: { homeId, machineId: fixture.machine.id, mode: 'effects', updates: { scope: 'security' } },
      context: fixture.context('machines.setup.plan'),
    }));
    if (!reviewed.updates?.plan) throw new Error('Native setup review did not produce an update plan');
    return MachineSetupUpdatesApplyInputV1Schema.parse({ homeId, machineId: fixture.machine.id,
      scope: 'security', plan: reviewed.updates.plan });
  };
  const invoke = async (id: ActionId, value: unknown): Promise<unknown> => {
    const fixture = await open();
    try {
      if (id === 'machines.setup.plan') return await fixture.machineSetupPlan({
        input: MachineSetupPlanInputV1Schema.parse(value), context: fixture.context(id),
      });
      if (id === 'machines.setup.apply') return requireProducerOutput(await fixture.machineSetupApply({
        input: MachineSetupApplyInputV1Schema.parse(value), context: fixture.context(id),
      }));
      if (id === 'machines.setup.remove') return requireProducerOutput(await fixture.machineSetupRemove({
        input: MachineSetupRemoveInputV1Schema.parse(value), context: fixture.context(id),
      }));
      if (id === 'machines.setup.updates.apply') return requireProducerOutput(await createMachineSetupUpdatesAction({
        apiMachine: fixture.client, homeId, machineId: fixture.machine.id, installation: fixture.installation,
      })({ input: MachineSetupUpdatesApplyInputV1Schema.parse(value), context: fixture.context(id) }));
      if (id === 'machines.access.prepareKeys') {
        fixture.setHomeRead(url => {
          if (new URL(url).pathname !== `/v1/machines/${fixture.machine.id}/data-key-envelopes`) return undefined;
          const machine = fixture.readHomeMachine();
          // This is the authenticated Home census boundary, not a prepared-key
          // result. The real key materializer owns the plain-Account outcome.
          return { status: 200, data: MachineAccessRecipientCensusResponseV1Schema.parse({
            machineId: fixture.machine.id, custodianAccountId: 'alice', encryptionMode: 'plain',
            machineOwnerEnvelopeFingerprint: null, callerDataEncryptionKey: null, nextCursor: null,
            content: { metadata: machine.metadata, metadataVersion: machine.metadataVersion,
              daemonState: machine.daemonState, daemonStateVersion: machine.daemonStateVersion }, recipients: [],
          }) };
        });
        return await prepareMachineAccessKeyEnvelopes({ credentials: fixture.credentials,
          serverHttpBaseUrl: 'https://native-software.invalid', serverId: homeId, machineId: fixture.machine.id });
      }
      throw new Error(`Unsupported setup output case: ${id}`);
    } finally { await close(); }
  };
  return { open, plan, applyInput, updatesInput, invoke, close };
}

export type SetupOutputFixture = Awaited<ReturnType<typeof createSetupOutputFixture>>;

/** Extend only the genuine Home HTTP boundary omitted by the install journey's
 * fixture. Installed dispatch, Workflow start/wait, coordinator, native update
 * child and all output producers remain the production implementations. */
async function rollout(input: unknown): Promise<unknown> {
  const value = MachineSetupUpdatesRolloutInputV1Schema.parse(input);
  let result: unknown;
  await exercisePublicPackagePlanApply('native-confirm', false, async (fixture, admitRoot) => {
    const post = vi.mocked(axios.post);
    const previous = post.getMockImplementation();
    if (!previous) throw new Error('Native installed journey did not provide its Home HTTP boundary');
    const roots = new Map<string, ExternalActionExecutionAuthorizationV1>();
    const ids = ['machines.setup.updates.rollout', 'machines.setup.updates.apply'] as const;
    post.mockImplementation(async (url, body, options) => {
      const path = new URL(String(url)).pathname;
      const id = ids.find(candidate => path === bindExternalActionExecutionAuthorizationHttpPathV1(candidate)
        || path === bindExternalActionExecutionAuthorizationVerifyHttpPathV1(candidate)
        || path === `/v1/actions/${candidate}`);
      if (!id) return previous(url, body, options);
      const headers = new AxiosHeaders();
      for (const [name, entry] of Object.entries(options?.headers ?? {})) {
        if (typeof entry === 'string') headers.set(name, entry);
      }
      if (path === bindExternalActionExecutionAuthorizationVerifyHttpPathV1(id)) {
        const token = headers.get(EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER);
        const authorization = typeof token === 'string' ? roots.get(token) : undefined;
        const signature = headers.get(EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER);
        const encodedTarget = headers.get(EXTERNAL_ACTION_RESOLVED_TARGET_HEADER);
        const target = typeof encodedTarget === 'string' ? decodeExternalActionResolvedTargetV1(encodedTarget) : null;
        const ok = authorization && target && typeof signature === 'string'
          && authorization.binding.actionId === id
          && verifyExternalActionMachineRequestV1({ authorizationToken: authorization.token, effectActionId: id,
            target, installationId: fixture.installation.installationId, requestId: authorization.binding.requestId,
            method: 'POST', path, body, publicKey: fixture.pair.publicKey, signature });
        return { status: ok ? 200 : 403, data: ok ? { ok: true } : { error: 'action_forbidden' } };
      }
      const proposal = ExternalActionExecutionAuthorizationRequestV1Schema.safeParse(body);
      const envelope = ExternalActionRequestEnvelopeSchema.parse(proposal.success ? proposal.data.envelope : body);
      if (envelope.target?.kind !== 'machine' || envelope.target.machineId !== fixture.machine.id)
        throw new Error('Rollout Home fixture received another Machine target');
      const bearer = headers.get('Authorization');
      if (bearer !== `Bearer ${fixture.credentials.token}` && bearer !== `Bearer ${fixture.issuerCredentials.token}`)
        throw new Error('Rollout Home fixture received another Account credential');
      const workflow = proposal.success && proposal.data.workflowActionOrigin ? proposal.data : undefined;
      const parent = workflow?.executionAuthorization?.binding;
      const authentication = parent && 'authentication' in parent ? parent.authentication
        : { kind: bearer === `Bearer ${fixture.credentials.token}` ? 'terminal' : 'account', tokenEpoch: 0 };
      const deploymentPreparationAdmission = projectExternalActionDeploymentPreparationEnvelopeAdmissionV1({ actionId: id, envelope });
      const authorization = (proposal.success && !workflow ? proposal.data.executionAuthorization : undefined)
        ?? ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1,
          token: `native-${id}-${envelope.requestId}-${computeExternalActionRequestEnvelopeDigestV1(envelope)}`,
          binding: { accountId: 'alice', authentication, serverIdentityId: homeId, machineId: fixture.machine.id,
            custodianAccountId: 'alice', installationId: fixture.installation.installationId, admittedMachineRole: 'manage',
            accountEncryptionMode: fixture.accountEncryptionMode, actionId: id, requestId: envelope.requestId,
            target: envelope.target, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
            ...(envelope.v === 2 && envelope.machineRuntimeDemand !== undefined
              ? { machineRuntimeDemand: envelope.machineRuntimeDemand } : {}),
            ...(deploymentPreparationAdmission ? { deploymentPreparationAdmission } : {}),
            ...(workflow ? { workflowActionOrigin: workflow.workflowActionOrigin } : {}),
          } });
      roots.set(authorization.token, authorization);
      admitRoot(authorization);
      if (path === bindExternalActionExecutionAuthorizationHttpPathV1(id)) return { status: 200, data: authorization };
      return { status: 200, data: await fixture.receive({ actionId: id, envelope, authorization,
        ...(workflow ? { authority: 'account_automation' } : {}) }) };
    });
    try {
      const id = 'machines.setup.updates.rollout';
      const requestId = 'output-contract-updates-rollout';
      const invocation = {
        actionRequestId: requestId, externalActionTarget: { kind: 'machine', machineId: fixture.machine.id },
        presentUserConfirmation: { actionId: id, requestId, accountId: 'alice', serverId: homeId,
          target: { kind: 'machine', machineId: fixture.machine.id },
          inputDigest: computeActionInputApprovalDigestV1(id, getActionSpec(id).inputSchema.parse(value)) },
      } as const;
      const review = await fixture.publicExecutor.execute(id, value, {
        actionRequestId: requestId, externalActionTarget: invocation.externalActionTarget,
      });
      if (review.ok || review.errorCode !== 'action_interactive_review_required')
        throw new Error('Native rollout did not carry its required confirmation review');
      const details = review.details;
      if (!details || typeof details !== 'object' || !('reviewDigest' in details)
        || typeof details.reviewDigest !== 'string') throw new Error('Native rollout omitted its carried review');
      const presentUserConfirmation = { ...invocation.presentUserConfirmation, reviewDigest: details.reviewDigest };
      const output = await fixture.publicExecutor.execute(id, value, { ...invocation, presentUserConfirmation });
      if (!output.ok) throw new Error(`Real update rollout did not settle successfully: ${output.errorCode}`);
      // The producer emits an accepted Operation receipt before its Workflow
      // finishes. The census validates that output, as for the native siblings.
      result = output.result;
    } finally { post.mockImplementation(previous); }
  });
  return result;
}

type SetupCase = Readonly<{ input(fixture: SetupOutputFixture): unknown | Promise<unknown>;
  execute?(fixture: SetupOutputFixture, input: unknown): Promise<unknown> }>;
export const setupOutputCases = new Map<ActionId, SetupCase>([
  ['machines.setup.plan', { input: async f => {
    const native = await f.open();
    return { homeId, machineId: native.machine.id, sources: native.sources, mode: 'effects' };
  } }],
  ['machines.setup.apply', { input: f => f.applyInput() }],
  ['machines.setup.remove', { input: async f => {
    const native = await f.open();
    const context = native.context('machines.setup.apply');
    const installed = MachineSetupApplyResultV1Schema.parse(requireProducerOutput(await native.machineSetupApply({
      input: await f.applyInput(), context,
    })));
    const settled = await native.operations.handlers.getV2({ operationId: installed.operationId, waitForTerminal: true }, context);
    if (settled.kind !== 'found' || settled.operation.state !== 'succeeded')
      throw new Error('Native removal fixture installation did not succeed');
    const item = native.sources[0]!.setup.items![0]!;
    if (item.kind === 'app') throw new Error('Native recipe fixture supplied an App');
    const key = machineSetupItemKeyV1(item);
    const reviewed = MachineSetupPlanResultV1Schema.parse(await native.machineSetupPlan({
      input: { homeId, machineId: native.machine.id, sources: [{ kind: 'direct', setup: {} }],
        mode: 'effects', removeItemKeys: [key] }, context: native.context('machines.setup.plan', 'remove-plan'),
    }));
    return { homeId, machineId: native.machine.id, desiredRevision: reviewed.desiredRevision,
      sources: reviewed.sources, exclusions: reviewed.exclusions, removeItemKeys: [key],
      removalPlans: reviewed.removalPlans ?? [] };
  } }],
  ['machines.setup.updates.apply', { input: f => f.updatesInput() }],
  ['machines.setup.updates.rollout', { input: async () => {
    // Review the same disposable OS candidate set without nesting temporary
    // ApiMachineClient Homes in one test's onTestFinished lifetime.
    const os = await createNativeSoftwareOsFixture({ manager: 'apt' });
    try {
      const machineId = 'alice-machine';
      const reviewed = await prepareMachineSetupUpdatesPlanV1({ machineId, scope: 'security', platform: 'linux',
        runNative: os.runNative });
      if (!reviewed.plan) throw new Error('Native OS review did not produce an update plan');
      return { homeId, machineId, batches: [[{ homeId, machineId, scope: 'security', plan: reviewed.plan }]],
        failurePolicy: 'fail_stop' };
    } finally { await os.dispose(); }
  }, execute: (_f, input) => rollout(input) }],
  ['machines.access.prepareKeys', { input: async f => ({ serverId: homeId, machineId: (await f.open()).machine.id }) }],
]);
