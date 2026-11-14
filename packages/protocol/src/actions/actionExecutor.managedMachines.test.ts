import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1 } from '../account/settings/sessionAgentSpawnPolicyV1.js';
import { API_TOKEN_FULL_GRANT_V1 } from '../auth/apiTokenGrant.js';
import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';
import { ApprovalRequestV1Schema, type ApprovalRequest } from '../approvals/approvalRequestV1.js';
import { buildApprovalRequestArtifactHeaderV1 } from '../approvals/approvalArtifactHeaderV1.js';
import { ManagedAcquireInputV1Schema, MachineSetupApplyInputV1Schema } from '../machines/managed/actionsV1.js';
import { ActionsSettingsV1Schema } from './actionSettings.js';
import { normalizeActionExecutorThrownError } from './executor/resultProjection.js';
import { readMachineActionRpcResult } from './executor/actionFailureEnvelope.js';
import { ActionOperationFailureV1Schema } from './operations/v1.js';
import { MachineProvisionerContributionV1Schema } from '../plugins/contributions/machineProvisioners.js';
import { ACTION_IDS } from './actionIds.js';
import { createRpcCallError, RpcError } from '../rpc/errors.js';

const agentTarget = { kind: 'agent', identity: { pluginId: 'native.agent', localId: 'agent' } } as const;

describe('unexpected Action failure diagnostics', () => {
  it('preserves admitted public RPC failure details through thrown-error normalization', () => {
    const details = { field: 'encryptionMode' };
    let thrown: unknown;
    try {
      readMachineActionRpcResult({ error: 'RPC client temporarily unavailable', errorCode: 'RPC_CLIENT_NOT_AVAILABLE', details });
    } catch (error) { thrown = error; }
    expect(normalizeActionExecutorThrownError(thrown)).toMatchObject({ errorCode: 'RPC_CLIENT_NOT_AVAILABLE', details });
  });
  it('preserves schema-validated Machine availability diagnostics from the RPC boundary', () => {
    const details = { reason: 'machine_offline', requiredFact: 'machine_online', remedy: 'reconnect_machine' };
    const failure = normalizeActionExecutorThrownError(createRpcCallError({ error: 'target_unavailable', errorCode: 'target_unavailable', details }));
    expect(failure).toMatchObject({ errorCode: 'target_unavailable', details });
    const malformed = normalizeActionExecutorThrownError(createRpcCallError({ error: 'target_unavailable', errorCode: 'target_unavailable',
      details: { ...details, token: 'PRIVATE_TOKEN' } }));
    expect(malformed).not.toHaveProperty('details');
    expect(JSON.stringify(malformed)).not.toContain('PRIVATE_TOKEN');
  });
  it('does not give arbitrary RpcError details public diagnostic authority', () => {
    const failure = normalizeActionExecutorThrownError(Object.assign(new RpcError('token=PRIVATE_TOKEN', 'RPC_FORBIDDEN'), {
      details: { token: 'PRIVATE_TOKEN' },
    }));
    expect(failure).toMatchObject({ errorCode: 'RPC_FORBIDDEN' });
    expect(failure).not.toHaveProperty('details');
    expect(JSON.stringify(failure)).not.toContain('PRIVATE_TOKEN');
  });
  it('retains a closed child failureCause and enrollment phase while redacting the message and dropping opaque details', () => {
    const error = Object.assign(new Error('token=PRIVATE_TOKEN'), { name: 'ManagedMachineControllerError', code: 'RPC_FORBIDDEN',
      details: { token: 'PRIVATE_TOKEN' },
      failureCause: { errorClass: 'ManagedMachineControllerError', errorCode: 'RPC_FORBIDDEN',
        httpStatus: null, phase: 'machines.agentIsolation.preview' } });
    const failure = normalizeActionExecutorThrownError(error);
    expect(failure).toMatchObject({ errorCode: 'RPC_FORBIDDEN', failureCause: error.failureCause });
    expect(failure).not.toHaveProperty('details');
    expect(JSON.stringify(failure)).not.toContain('PRIVATE_TOKEN');
    expect(ActionOperationFailureV1Schema.parse(failure)).toEqual(failure);
    const privateFields = normalizeActionExecutorThrownError(Object.assign(new TypeError('token=PRIVATE_TOKEN'), {
      code: 'token=PRIVATE_TOKEN', details: { token: 'PRIVATE_TOKEN', phase: 'PRIVATE_PHASE' },
    }));
    expect(privateFields).toMatchObject({ errorCode: 'action_failed',
      failureCause: { errorClass: 'TypeError', errorCode: null, httpStatus: null } });
    expect(privateFields).not.toHaveProperty('details');
    expect(JSON.stringify(privateFields)).not.toMatch(/PRIVATE_/);
  });
});

describe('machine setup apply admission', () => {
  it('dispatches only a matching reviewed updates plan after confirmation', async () => {
    const actionId = ACTION_IDS.find(id => String(id) === 'machines.setup.updates.apply');
    expect(actionId).toBeDefined();
    if (!actionId) return;
    const applied: unknown[] = [];
    const deps: ActionExecutorDeps & { machineSetupUpdatesApply: (request: { input: unknown }) => Promise<unknown> } = {
      machineSetupUpdatesApply: async request => { applied.push(request.input); return { operationId: 'updates-operation' }; },
    };
    const executor = createActionExecutor(deps);
    const input = { homeId: 'home', machineId: 'guest', scope: 'security', plan: {
      v: 1, basis: { kind: 'updates', machineId: 'guest', scope: 'security' }, steps: [], nativeFacts: [], planDigest: 'a'.repeat(64),
    } };
    const context = { surface: 'cli' as const, authority: 'present_user' as const, presentUserConfirmation: { actionId } };
    expect(await executor.execute(actionId, input, context)).toEqual({ ok: true, result: { operationId: 'updates-operation' } });
    expect(await executor.execute(actionId, { ...input, scope: 'all' }, context)).toMatchObject({ ok: false });
    expect(applied).toEqual([input]);
  });
  it('runs only the reviewed preset revision after confirmation through the machine transport', async () => {
    const applied: unknown[] = [];
    const executor = createActionExecutor({ machineSetupApply: async request => {
      applied.push(request.input);
      return { operationId: 'environment-operation', terminalId: 'environment-output' };
    } } as ActionExecutorDeps);
    const input = MachineSetupApplyInputV1Schema.parse({ homeId: 'home', machineId: 'guest', targets: [{
      homeId: 'home', machineId: 'guest', desiredRevision: 0, recipePlans: [], sources: [
      { kind: 'accountPresetOpaque', presetId: 'preset', presetRevision: 4, contentEncryptionMode: 'e2ee' },
      { kind: 'direct', setup: {} },
    ] }] });
    expect(await executor.execute('machines.setup.apply', input, { surface: 'cli', authority: 'present_user',
      presentUserConfirmation: { actionId: 'machines.setup.apply' } }))
      .toEqual({ ok: true, result: { operationId: 'environment-operation', terminalId: 'environment-output' } });
    expect(applied).toEqual([input]);
    expect(await executor.execute('machines.setup.apply', { ...input, setup: { scripts: [{ body: 'unreviewed' }] } },
      { surface: 'cli', authority: 'present_user', presentUserConfirmation: { actionId: 'machines.setup.apply' } }))
      .toMatchObject({ ok: false });
    expect(applied).toEqual([input]);
  });
});
const acquireInput = {
  enrollmentIdentity: { kind: 'existingUser', role: 'adopted' },
  selection: { kind: 'one-off', homeId: 'home', controller: { machineId: 'controller', installationId: 'installation' },
    launch: { provider: { pluginId: 'machine.example', localId: 'vm' }, schemaVersion: 1, name: 'Work VM', choices: {} },
    retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false },
} as const;
const agentContext = {
  surface: 'agent', callerPermissionMode: 'yolo', defaultSessionId: 'lead',
  causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'yolo' },
  sessionInputSource: { sourceSessionId: 'lead', sourceTurnId: 'turn', via: 'action' },
  agentStartContext: {
    caller: { kind: 'session', sessionId: 'lead', starterDepth: 0, turnDepth: 0 },
    baseline: { machineId: 'parent', directory: '/repo', configuration: { agentTarget } },
    roles: {}, ledSubtreeSessionIds: [], workDepthLimit: 4, callerPermissionCeiling: 'yolo',
  },
} as const;

describe('managed Machine Action executor', () => {
  function portableAcquireInput() {
    const provisioner = MachineProvisionerContributionV1Schema.parse({ id: 'vm', title: 'Cloud', icon: 'server', resourceKind: 'vm',
      schemaVersion: 1, launchSchema: { type: 'object', properties: {}, additionalProperties: false },
      resourceSchema: { type: 'object', properties: {}, additionalProperties: false }, platforms: ['linux'], browserReachable: true,
      prerequisites: [], billing: { location: 'cloud', stoppedBilling: 'not-billed' }, retention: { supportedIntents: ['delete'] },
      actions: { check: 'check', acquire: 'acquire', bootstrap: 'bootstrap', inspect: 'inspect', destroy: 'destroy' } });
    const { controller: _nativeController, ...selection } = acquireInput.selection;
    return ManagedAcquireInputV1Schema.parse({ enrollmentIdentity: acquireInput.enrollmentIdentity, selection,
      reviewedFacts: { launch: selection.launch, provisioner, optionStatus: 'current', billing: provisioner.billing,
        prerequisites: [], retentionCapabilities: provisioner.retention, retention: selection.retention, wakeOnAcceptedMessage: false } });
  }

  it('passes only the selected provisioner role through the existing reviewed-child issuer', async () => {
    const input = portableAcquireInput();
    const action = { pluginId: input.reviewedFacts!.launch.provider.pluginId, localId: 'acquire' };
    const execute = (selected: typeof action) => createActionExecutor({ managedMachineAction: async ({ context }) => {
      if (!context.hostReviewedChild) return { ok: false, errorCode: 'credential_scope_denied', error: 'credential_scope_denied' };
      return await context.hostReviewedChild.invoke({ action: selected, role: 'acquire', input: { launch: {}, managedId: 'retained' } });
    } }).execute('machines.managed.acquire', input, { surface: 'cli', authority: 'present_user', runtimeAccountId: 'owner',
      serverId: 'home', serverIdentityId: 'home', actionCaller: { kind: 'host' },
      actionsSettings: ActionsSettingsV1Schema.parse({ v: 1, actions: {} }),
      presentUserConfirmation: { actionId: 'machines.managed.acquire' } });
    // The contributed runtime is the missing external boundary here: reaching it
    // proves the real issuer admitted the declared role instead of denying scope.
    expect(await execute(action)).toMatchObject({ ok: false, errorCode: 'contributed_action_unavailable' });
    expect(await execute({ ...action, pluginId: 'other.provider' })).toMatchObject({ ok: false, errorCode: 'credential_scope_denied' });
  });

  it('folds selected provider Require policy into the parent before admitting paid work', async () => {
    let admitted = 0;
    const executor = createActionExecutor({ managedMachineAction: async () => { admitted++; return { managedId: 'retained' }; } });
    const result = await executor.execute('machines.managed.acquire', portableAcquireInput(), {
      surface: 'cli', authority: 'present_user', runtimeAccountId: 'owner', serverId: 'home', serverIdentityId: 'home',
      actionCaller: { kind: 'host' }, interactivePresentation: 'unavailable', bypassApprovals: true,
      actionsSettings: ActionsSettingsV1Schema.parse({ v: 1, actions: {
        'machine.example/actions/acquire': { approvalRequiredSurfaces: ['cli'] },
      } }), presentUserConfirmation: { actionId: 'machines.managed.acquire' },
    });
    expect(result).toMatchObject({ ok: false, errorCode: 'action_interactive_review_required' });
    expect(admitted).toBe(0);
  });

  it('keeps opaque preset child declarations with the custodian that opens the private declaration', async () => {
    const demanded = ['machines.setup.adminAccess.set', 'machines.agentIsolation.preview', 'machines.agentIsolation.set',
      'machines.setup.plan', 'machines.setup.apply', 'session.spawn_new'] as const;
    let approval: ApprovalRequest | undefined;
    let entered = 0;
    const executor = createActionExecutor({
      // The installed controller and Artifact storage are Protocol's genuine
      // process boundaries; declaration, preparation and policy remain real.
      managedMachineAction: async () => { entered++; return { managedId: 'managed' }; },
      approvalsCreate: async ({ request }) => { approval = request; return { artifactId: 'parent-review' }; },
    });
    const input = ManagedAcquireInputV1Schema.parse({
      selection: { kind: 'preset', homeId: 'home', id: 'preset', revision: 1 },
      controller: acquireInput.selection.controller, retention: acquireInput.selection.retention, wakeOnAcceptedMessage: false,
      agentStart: { directory: { kind: 'managed' }, agentTarget },
      presetContentOverride: { content: { t: 'plain', v: {
        enrollmentIdentity: { kind: 'dedicatedDaemonUser', username: 'private-user', serviceMode: 'user', role: 'server', adminAccessAtCreation: 'preauthorized' },
        reviewedFacts: { launch: acquireInput.selection.launch, controller: acquireInput.selection.controller,
          optionStatus: 'current', billing: { location: 'unknown', stoppedBilling: 'unknown' }, prerequisites: [],
          retentionCapabilities: { supportedIntents: ['start', 'delete'] }, retention: acquireInput.selection.retention,
          wakeOnAcceptedMessage: false, preset: { id: 'preset', revision: 1 }, setup: {} },
      } } },
    });
    const result = await executor.execute('machines.managed.acquire', input, {
      surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' }, runtimeAccountId: 'owner',
      serverId: 'home', serverIdentityId: 'home', actionRequestId: 'acquire-review', defaultSessionMachineId: 'controller',
      externalActionTarget: { kind: 'machine', machineId: 'controller' }, bypassApprovals: true,
      actionsSettings: ActionsSettingsV1Schema.parse({ v: 1, actions: Object.fromEntries(demanded.map(id => [id, { approvalRequiredSurfaces: ['cli'] }])) }),
    });
    expect(result).toMatchObject({ ok: true, result: { kind: 'approval_request_created', actionId: 'machines.managed.acquire', artifactId: 'parent-review' } });
    expect(entered).toBe(0);
    expect(approval?.preview).toMatchObject({ hostReviewedChildren: { children: [{ action: 'session.spawn_new', role: 'session.spawn_new' }] } });
    const preview = approval?.preview as { hostReviewedChildren?: { children: readonly { input?: unknown }[] } } | undefined;
    expect(preview?.hostReviewedChildren?.children.every(child => child.input === undefined)).toBe(true);
    expect(JSON.stringify(approval?.preview)).not.toContain('private-user');
  });

  it('does not ask for unused managed roles or infer Setup from a preset address alone', async () => {
    const demanded = ['machines.setup.adminAccess.set', 'machines.agentIsolation.preview', 'machines.agentIsolation.set',
      'machines.setup.plan', 'machines.setup.apply', 'session.spawn_new'] as const;
    let entered = 0;
    let approvals = 0;
    const executor = createActionExecutor({ managedMachineAction: async () => { entered++; return { managedId: 'managed' }; },
      approvalsCreate: async () => { approvals++; return { artifactId: 'unused-child-review' }; } });
    const context = { surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' }, runtimeAccountId: 'owner',
      serverId: 'home', serverIdentityId: 'home', defaultSessionMachineId: 'controller', bypassApprovals: true,
      actionsSettings: ActionsSettingsV1Schema.parse({ v: 1, actions: Object.fromEntries(demanded.map(id => [id, { approvalRequiredSurfaces: ['cli'] }])) }) } as const;
    for (const input of [acquireInput, {
      selection: { kind: 'preset', homeId: 'home', id: 'preset', revision: 1 }, controller: acquireInput.selection.controller,
      retention: acquireInput.selection.retention, wakeOnAcceptedMessage: false,
      presetContentOverride: { content: { t: 'plain', v: {} } } }]) {
      expect(await executor.execute('machines.managed.acquire', input, context)).toMatchObject({ ok: true, result: { managedId: 'managed' } });
    }
    expect(entered).toBe(2);
    expect(approvals).toBe(0);
  });

  it('preserves the closed controller authority comparison after prepared-task serialization', () => {
    const message = 'The acquired enrollment runtime does not match the resolved Home authority (authorityReason descriptor; authorityPhase controller_approval; authorityCarrier https; authorityDescriptorPresent false).';
    const failure = normalizeActionExecutorThrownError({ code: 'HOME_AUTHORITY_MISMATCH', message,
      url: 'https://private', token: 'private' });
    expect(ActionOperationFailureV1Schema.parse(failure)).toEqual({ errorCode: 'HOME_AUTHORITY_MISMATCH', error: message,
      failureCause: { phase: 'dispatch', errorClass: 'UnknownThrownValue', errorCode: 'HOME_AUTHORITY_MISMATCH', httpStatus: null },
      details: { kind: 'homeAuthorityMismatch', authorityReason: 'descriptor', authorityPhase: 'controller_approval',
        authorityCarrier: 'https', authorityDescriptorPresent: false } });
    const rejected = normalizeActionExecutorThrownError({ code: 'HOME_AUTHORITY_MISMATCH', message: message + ' token=PRIVATE_TOKEN' });
    expect(rejected).not.toHaveProperty('details');
    expect(JSON.stringify(rejected)).not.toContain('PRIVATE_TOKEN');
  });
  it.each([
    { code: 'auth_enrollment_timeout', category: 'enrollment_deadline' },
    { code: 'auth_request_expired', category: 'pairing_deadline' },
    { code: 'cancelled', category: 'caller_abort' },
  ])('keeps the controller $category diagnostic and refusal code in the Action and operation', async ({ code, category }) => {
    const message = `Remote Home enrollment failed. (phase auth.enroll-remote; exitStatus unknown; signal unknown; stdoutPresent unknown; stderrPresent unknown; elapsedBucket under_1s; requestEventSeen false; finalResultEventSeen false; guestCliCode unknown; guestAuthCategory unknown; controllerAbortCategory ${category})`;
    const executor = createActionExecutor({ managedMachineAction: async () => {
      throw Object.assign(new Error(message), { code });
    } } as ActionExecutorDeps);
    expect(await executor.execute('machines.managed.acquire', acquireInput, { surface: 'cli', authority: 'present_user',
      presentUserConfirmation: { actionId: 'machines.managed.acquire' } }))
      .toEqual({ ok: false, errorCode: code, error: message,
        failureCause: { phase: 'machines.managed.acquire', errorClass: 'Error', errorCode: code, httpStatus: null } });
  });
  it.each([
    { message: 'Remote Home enrollment failed. (phase auth.enroll-remote; exitStatus 1; signal unknown; stdoutPresent true; stderrPresent true; elapsedBucket at_least_600s; requestEventSeen true; finalResultEventSeen false; guestCliCode AUTH_ENROLL_REMOTE_TIMEOUT; guestAuthCategory deadline_elapsed; controllerAbortCategory none)', valid: true },
    { message: 'Remote Home enrollment failed. (phase auth.enroll-remote; exitStatus 1; signal unknown; stdoutPresent true; stderrPresent true; elapsedBucket private_secret; requestEventSeen true; finalResultEventSeen false; guestCliCode AUTH_ENROLL_REMOTE_TIMEOUT; guestAuthCategory deadline_elapsed; controllerAbortCategory none)', valid: false },
    { message: 'Remote Home enrollment failed. (phase auth.enroll-remote; exitStatus 137; signal SIGKILL-compatible; stdoutPresent false; stderrPresent false)', valid: true },
    { message: 'Remote Home enrollment failed. (phase auth.enroll-remote; exitStatus 1; signal unknown; stdoutPresent false; stderrPresent true)', valid: true },
    { message: 'Remote Home enrollment failed. (phase auth.request; exitStatus 137; signal SIGKILL-compatible; stdoutPresent false; stderrPresent false)', valid: true },
    { message: 'Remote Home enrollment failed during auth wait (exit 1; code HOME_FEATURES_NETWORK; category auth_error).', valid: true },
    { message: 'Remote Home enrollment failed during auth wait (exit 1; code private_secret; category auth_error).', valid: false },
    { message: 'private stderr and pairing secrets', valid: false },
    { message: 'Remote Home enrollment failed. (phase auth.enroll-remote; exitStatus 1; signal SIGKILL-compatible; stdoutPresent false; stderrPresent false)', valid: false },
    { message: 'Remote Home enrollment failed. (phase private.secret; exitStatus 137; signal SIGKILL-compatible; stdoutPresent false; stderrPresent false)', valid: false },
    { message: 'Remote Home enrollment failed. (phase auth.enroll-remote; exitStatus 137; signal SIGKILL-compatible; stdoutPresent false; stderrPresent false) private stderr', valid: false },
  ])('retains only closed enrollment process facts at Action settlement ($valid)', async ({ message, valid }) => {
    const executor = createActionExecutor({ managedMachineAction: async () => {
      throw Object.assign(new Error(message), { code: 'remote_command_failed' });
    } } as ActionExecutorDeps);
    expect(await executor.execute('machines.managed.acquire', acquireInput, { surface: 'cli', authority: 'present_user',
      presentUserConfirmation: { actionId: 'machines.managed.acquire' } }))
      .toEqual({ ok: false, errorCode: 'remote_command_failed', error: valid ? message : 'Remote command failed.',
        failureCause: { phase: 'machines.managed.acquire', errorClass: 'Error', errorCode: 'remote_command_failed', httpStatus: null } });
  });

  it.each([
    { message: 'The SSH command failed. (phase daemon.service.start; exitStatus 1; stdoutPresent true; stderrPresent false; guestCliCode service_start_timeout; serviceStep bootstrap; serviceStepStatus deadline_elapsed)', valid: true },
    { message: 'The SSH command failed. (phase daemon.service.start; exitStatus 1; stdoutPresent true; stderrPresent false; guestCliCode service_ownership_failed; serviceStep wait; serviceStepStatus failed; serviceReason launchd_exited)', valid: true },
    { message: 'The SSH command failed. (phase daemon.service.start; exitStatus 1; stdoutPresent true; stderrPresent false; guestCliCode private_secret; serviceStep bootstrap; serviceStepStatus failed)', valid: false },
    { message: 'The SSH command failed. (phase auth.status; exitStatus 1; stdoutPresent true; stderrPresent false; guestCliCode service_start_timeout; serviceStep bootstrap; serviceStepStatus deadline_elapsed)', valid: false },
    { message: 'The SSH command failed. (phase daemon.service.install; exitStatus 1; stdoutPresent false; stderrPresent true)', valid: true },
    { message: 'The SSH command failed. (phase daemon.service.start; exitStatus unknown; stdoutPresent unknown; stderrPresent unknown)', valid: true },
    { message: 'The SSH command failed. (phase daemon.service.start; exitStatus 1; stdoutPresent false; stderrPresent true; reason launchctl_io_error)', valid: true },
    { message: 'The SSH command failed. (phase daemon.service.start; exitStatus 1; stdoutPresent false; stderrPresent true; reason launchctl_domain_unsupported)', valid: true },
    { message: 'The SSH command failed. (phase daemon.service.start; exitStatus 1; stdoutPresent false; stderrPresent true; reason launchctl_service_missing)', valid: true },
    { message: 'The SSH command failed. (phase daemon.service.start; exitStatus 1; stdoutPresent false; stderrPresent true; reason private_secret)', valid: false },
    { message: 'The SSH command failed. (phase auth.status; exitStatus 1; stdoutPresent false; stderrPresent true; reason launchctl_io_error)', valid: false },
    { message: 'The SSH command failed. (phase daemon.service.start; exitStatus 1; stdoutPresent false; stderrPresent true; reason launchctl_io_error) private stderr', valid: false },
    { message: 'private output /Users/person/secret', valid: false },
    { message: 'The SSH command failed. (phase private.secret; exitStatus 1; stdoutPresent false; stderrPresent true)', valid: false },
    { message: 'The SSH command failed. (phase daemon.service.install; exitStatus 9007199254740992; stdoutPresent false; stderrPresent true)', valid: false },
    { message: 'The SSH command failed. (phase daemon.service.install; exitStatus 1; stdoutPresent false; stderrPresent true) private output', valid: false },
    { message: 'The SSH command failed. (phase daemon.service.install; exitStatus 1; stdoutPresent secret; stderrPresent true)', valid: false },
  ])('retains only closed SSH command facts at public Action settlement ($valid, $message)', async ({ message, valid }) => {
    // The installed CLI controller is outside Protocol's process boundary.
    const executor = createActionExecutor({ managedMachineAction: async () => {
      throw Object.assign(new Error(message), { code: 'ssh_command_failed' });
    } } as ActionExecutorDeps);
    expect(await executor.execute('machines.managed.acquire', acquireInput, { surface: 'cli', authority: 'present_user',
      presentUserConfirmation: { actionId: 'machines.managed.acquire' } }))
      .toEqual({ ok: false, errorCode: 'ssh_command_failed', error: valid ? message : 'The SSH command failed.',
        failureCause: { phase: 'machines.managed.acquire', errorClass: 'Error', errorCode: 'ssh_command_failed', httpStatus: null } });
  });

  it('retains the unreachable Home address without exposing native enrollment diagnostics', async () => {
    let details: unknown = { kind: 'managedGuestHome', homeOrigin: 'https://home.example.test:9443' };
    // The installed controller is an external host boundary of Protocol's executor.
    const executor = createActionExecutor({ managedMachineAction: async () => {
      throw Object.assign(new Error('private enrollment diagnostic'), { code: 'home_not_guest_reachable', details });
    } } as ActionExecutorDeps);
    const context = { surface: 'cli', authority: 'present_user',
      presentUserConfirmation: { actionId: 'machines.managed.acquire' } } as const;
    const result = await executor.execute('machines.managed.acquire', acquireInput, context);
    expect(result).toMatchObject({ ok: false, errorCode: 'home_not_guest_reachable', details });
    expect(JSON.stringify(result)).not.toContain('private enrollment diagnostic');
    details = { kind: 'managedGuestHome', homeOrigin: 'https://home.example.test?token=PRIVATE' };
    const invalid = await executor.execute('machines.managed.acquire', acquireInput, context);
    expect(invalid).not.toHaveProperty('details');
    expect(JSON.stringify(invalid)).not.toContain('PRIVATE');
  });

  it('retains closed bootstrap interpreter facts at public Action settlement without native content', async () => {
    const diagnostic = { kind: 'managedBootstrap', phase: 'check', response: 'missing_result', exitStatus: 127,
      stdoutPresent: false, stderrPresent: true };
    let details: unknown = diagnostic;
    // The installed controller is an external host boundary of Protocol's executor.
    const executor = createActionExecutor({ managedMachineAction: async () => {
      throw Object.assign(new Error('token=PRIVATE_BOOTSTRAP_TOKEN'), { code: 'bootstrap_effect_unconfirmed', details });
    } } as ActionExecutorDeps);
    const input = { homeId: 'home', managedId: 'managed', expectedIntentRevision: 1 };
    const context = { surface: 'cli', authority: 'present_user',
      presentUserConfirmation: { actionId: 'machines.managed.bootstrap.retry' } } as const;
    const result = await executor.execute('machines.managed.bootstrap.retry', input, context);
    expect(result).toEqual({ ok: false, errorCode: 'bootstrap_effect_unconfirmed', error: 'bootstrap_effect_unconfirmed', details,
      failureCause: { phase: 'machines.managed.bootstrap.retry', errorClass: 'Error', errorCode: 'bootstrap_effect_unconfirmed', httpStatus: null } });
    expect(JSON.stringify(result)).not.toContain('private interpreter stderr');
    details = { ...diagnostic, stderr: 'private interpreter stderr' };
    const invalid = await executor.execute('machines.managed.bootstrap.retry', input, context);
    expect(invalid).toMatchObject({ errorCode: 'bootstrap_effect_unconfirmed', failureCause: { errorClass: 'Error', errorCode: 'bootstrap_effect_unconfirmed' } });
    expect(invalid).not.toHaveProperty('details');
    expect(JSON.stringify(invalid)).not.toContain('PRIVATE_BOOTSTRAP_TOKEN');
  });
  it.each(['native_resource_unavailable', 'native_action_failed'])('keeps terminal native bootstrap reasons without forwarding diagnostics (%s)', async code => {
    let entered = false;
    const executor = createActionExecutor({ managedMachineAction: async () => {
      entered = true;
      throw Object.assign(new Error('private native diagnostic'), { code });
    } } as ActionExecutorDeps);
    const result = await executor.execute('machines.managed.bootstrap.retry', { homeId: 'home', managedId: 'managed', expectedIntentRevision: 0 },
      { surface: 'cli', authority: 'present_user', presentUserConfirmation: { actionId: 'machines.managed.bootstrap.retry' } });
    expect(entered).toBe(true);
    expect(result).toEqual({ ok: false, errorCode: code, error: code,
      failureCause: { phase: 'machines.managed.bootstrap.retry', errorClass: 'Error', errorCode: code, httpStatus: null } });
  });

  it.each([
    ['ssh_password_expired', 'The SSH login account requires a password change.'],
    ['ssh_host_key_changed', 'The SSH host key could not be verified.'],
    ['ssh_host_key_unverified', 'The SSH host key could not be verified.'],
    ['ssh_command_failed', 'The SSH command failed.'],
  ])('keeps SSH failure codes and fixed messages across the host boundary (%s)', async (code, message) => {
    // The installed CLI controller is outside Protocol's process boundary.
    const executor = createActionExecutor({ managedMachineAction: async () => {
      throw Object.assign(new Error('private host diagnostic'), { code });
    } } as ActionExecutorDeps);
    expect(await executor.execute('machines.managed.acquire', acquireInput, { surface: 'cli', authority: 'present_user',
      presentUserConfirmation: { actionId: 'machines.managed.acquire' } }))
      .toEqual({ ok: false, errorCode: code, error: message,
        failureCause: { phase: 'machines.managed.acquire', errorClass: 'Error', errorCode: code, httpStatus: null } });
  });
  it.each([
    { code: 'provider_unavailable', nativeCause: { httpStatusClass: '4xx', code: 'uniqueness_error' } },
    { code: 'provider_unavailable', nativeCause: { localCause: 'native_options_changed' } },
    { code: 'native_action_failed', nativeCause: { httpStatusClass: '5xx', code: 'service_error' } },
    { code: 'native_access_refused', nativeCause: { grpcStatusCode: 7 } },
    { code: 'native_access_refused', nativeCause: { sdkError: 'NotFoundError' } },
  ] as const)('retains closed managed native diagnostics at Action settlement ($code, $nativeCause)', async ({ code, nativeCause }) => {
    // The installed controller is an external host boundary of Protocol's executor.
    let details: unknown = { kind: 'managedNative', nativeCause };
    const executor = createActionExecutor({ managedMachineAction: async () => {
      throw Object.assign(new Error('token=PRIVATE_NATIVE_TOKEN'), { code, details });
    } } as ActionExecutorDeps);
    const context = { surface: 'cli', authority: 'present_user',
      presentUserConfirmation: { actionId: 'machines.managed.acquire' } } as const;
    expect(await executor.execute('machines.managed.acquire', acquireInput, context))
      .toEqual({ ok: false, errorCode: code, error: code, details,
        failureCause: { phase: 'machines.managed.acquire', errorClass: 'Error', errorCode: code, httpStatus: null } });
    details = { kind: 'managedNative', nativeCause: { ...nativeCause, message: 'private native response' } };
    const invalid = await executor.execute('machines.managed.acquire', acquireInput, context);
    expect(invalid).not.toHaveProperty('details.nativeCause');
    expect(JSON.stringify(invalid)).not.toMatch(/nativeCause|PRIVATE_NATIVE_TOKEN/);
  });

  it('retires only exact-target Delete approvals without opening unrelated bodies across pages', async () => {
    const actionArgs = { homeId: 'home', managedId: 'managed', when: 'now', expectedRevision: 4,
      intent: 'delete', reviewedDependencies: true } as const;
    const openApproval = (managedId: string): ApprovalRequest => ApprovalRequestV1Schema.parse({
      v: 1, status: 'open', createdAtMs: 1, updatedAtMs: 1,
      createdBy: { surface: 'cli' }, requestedSurface: 'cli', actionId: 'machines.managed.delete',
      actionArgs: { ...actionArgs, managedId }, summary: `Delete ${managedId}`,
    });
    const rows = [
      ...Array.from({ length: 205 }, (_, index) => ({ artifactId: `unrelated-${index}`,
        request: openApproval(`other-${index}`) })),
      { artifactId: 'matching-one', request: openApproval('managed') },
      { artifactId: 'matching-two', request: openApproval('managed') },
    ].map(row => ({ ...row, header: buildApprovalRequestArtifactHeaderV1(row.request) }));
    const stored = new Map(rows.map(row => [row.artifactId, row.request]));
    const approvalsGet = vi.fn(async ({ artifactId }: { artifactId: string }) => stored.get(artifactId) ?? null);
    const approvalsUpdate = vi.fn(async ({ artifactId, request }: { artifactId: string; request: ApprovalRequest }) => {
      stored.set(artifactId, request);
      return { ok: true as const };
    });
    const approvalsList = vi.fn(async (args: Readonly<{ cursor?: string | null; limit?: number | null;
      subjectKey?: string | null }>) => {
      const selected = args.subjectKey
        ? rows.filter(row => row.header.approvalSubjectKey === args.subjectKey)
        : rows;
      const start = args.cursor ? selected.findIndex(row => row.artifactId === args.cursor) + 1 : 0;
      const page = selected.slice(start, start + (args.limit ?? 100));
      return { items: page.map(row => ({ artifactId: row.artifactId, status: row.request.status,
        actionId: row.request.actionId, summary: row.request.summary, serverId: 'home', updatedAtMs: row.request.updatedAtMs })),
      nextCursor: start + page.length < selected.length ? page.at(-1)!.artifactId : null,
      queryPlan: { kind: 'approval_artifact_header_scan' as const, hydratedTranscripts: false as const } };
    });
    const executor = createActionExecutor({
      managedMachineReferences: async () => ({ homeId: 'home', machineId: 'guest', coverage: 'complete', references: [], unavailable: [] }),
      managedMachineAction: async () => ({ kind: 'accepted', managedId: 'managed', intentRevision: 5,
        operation: { operationId: 'delete-operation' } }),
      approvalsList, approvalsGet, approvalsUpdate, isActionApprovalRequired: () => false,
    } as unknown as ActionExecutorDeps);

    expect(await executor.execute('machines.managed.delete', actionArgs, { surface: 'ui', authority: 'present_user',
      serverId: 'home', presentUserConfirmation: { actionId: 'machines.managed.delete' } }))
      .toMatchObject({ ok: true });
    expect(approvalsList).toHaveBeenCalledTimes(1);
    expect(approvalsList).toHaveBeenCalledWith(expect.objectContaining({ subjectKey: expect.any(String) }));
    expect(approvalsGet).toHaveBeenCalledTimes(2);
    expect(approvalsUpdate).toHaveBeenCalledTimes(2);
    expect(stored.get('matching-one')).toMatchObject({ status: 'canceled' });
    expect(stored.get('matching-two')).toMatchObject({ status: 'canceled' });
    expect(stored.get('unrelated-0')).toMatchObject({ status: 'open' });
  });

  it('converges a failed exact-target retirement on the next accepted Delete transition', async () => {
    const actionArgs = { homeId: 'home', managedId: 'managed', when: 'now', expectedRevision: 4,
      intent: 'delete', reviewedDependencies: true } as const;
    let stored = ApprovalRequestV1Schema.parse({ v: 1, status: 'open', createdAtMs: 1, updatedAtMs: 1,
      createdBy: { surface: 'cli' }, requestedSurface: 'cli', actionId: 'machines.managed.delete', actionArgs,
      summary: 'Delete managed Machine' });
    let refuse = true;
    const approvalsUpdate = vi.fn(async ({ request }: { request: ApprovalRequest }) => {
      if (refuse) return { ok: false as const, errorCode: 'update_failed', error: 'update_failed' };
      stored = request;
      return { ok: true as const };
    });
    const executor = createActionExecutor({
      managedMachineReferences: async () => ({ homeId: 'home', machineId: 'guest', coverage: 'complete', references: [], unavailable: [] }),
      managedMachineAction: async () => ({ kind: 'accepted', managedId: 'managed', intentRevision: 5,
        operation: { operationId: 'delete-operation' } }),
      approvalsList: async args => {
        const header = buildApprovalRequestArtifactHeaderV1(stored);
        return { items: stored.status === 'open' && header.approvalSubjectKey === args.subjectKey
          ? [{ artifactId: 'stale-delete', status: stored.status, actionId: stored.actionId,
            summary: stored.summary, serverId: 'home', updatedAtMs: stored.updatedAtMs }] : [],
        nextCursor: null, queryPlan: { kind: 'bounded_approval_artifact_header_scan',
          boundedBy: 'exact approval subject key', hydratedTranscripts: false } };
      },
      approvalsGet: async () => stored, approvalsUpdate, isActionApprovalRequired: () => false,
    } as unknown as ActionExecutorDeps);
    const execute = () => executor.execute('machines.managed.delete', actionArgs, { surface: 'ui', authority: 'present_user',
      serverId: 'home', presentUserConfirmation: { actionId: 'machines.managed.delete' } });

    expect(await execute()).toMatchObject({ ok: true });
    expect(stored).toMatchObject({ status: 'open' });
    refuse = false;
    expect(await execute()).toMatchObject({ ok: true });
    expect(stored).toMatchObject({ status: 'canceled' });
    expect(approvalsUpdate).toHaveBeenCalledTimes(2);
  });

  it('keeps an accepted Delete truthful while retiring every writable older approval', async () => {
    const actionArgs = { homeId: 'home', managedId: 'managed', when: 'now', expectedRevision: 4,
      intent: 'delete', reviewedDependencies: true } as const;
    const openApproval = (): ApprovalRequest => ApprovalRequestV1Schema.parse({
      v: 1, status: 'open', createdAtMs: 1, updatedAtMs: 1,
      createdBy: { surface: 'cli' }, requestedSurface: 'cli', actionId: 'machines.managed.delete', actionArgs,
      summary: 'Delete managed Machine',
    });
    const stored = new Map<string, ApprovalRequest>([
      ['stale-delete-read-failed', openApproval()],
      ['stale-delete-update-failed', openApproval()],
      ['stale-delete-retired', openApproval()],
    ]);
    const approvalsList = vi.fn(async () => ({ items: [...stored].map(([artifactId, request]) => ({ artifactId, status: request.status,
      actionId: request.actionId, summary: request.summary, serverId: 'home', updatedAtMs: request.updatedAtMs })),
      nextCursor: null, queryPlan: { kind: 'approval_artifact_header_scan' as const, hydratedTranscripts: false as const } }));
    const approvalsUpdate = vi.fn(async ({ artifactId, request }: { artifactId: string; request: ApprovalRequest }) => {
      if (artifactId === 'stale-delete-update-failed') return { ok: false as const, errorCode: 'update_failed', error: 'update_failed' };
      stored.set(artifactId, request);
      return { ok: true as const };
    });
    const recordApprovalRetirementWarning = vi.fn();
    const executor = createActionExecutor({
      managedMachineReferences: async () => ({ homeId: 'home', machineId: 'guest', coverage: 'complete', references: [], unavailable: [] }),
      managedMachineAction: async () => ({ kind: 'accepted', managedId: 'managed', intentRevision: 5,
        operation: { operationId: 'delete-operation' } }),
      approvalsList,
      approvalsGet: async ({ artifactId }) => {
        if (artifactId === 'stale-delete-read-failed') throw Object.assign(new Error('private body unavailable'), { code: 'read_failed' });
        return stored.get(artifactId) ?? null;
      },
      approvalsUpdate,
      recordApprovalRetirementWarning,
      isActionApprovalRequired: () => false,
    } as unknown as ActionExecutorDeps);

    expect(await executor.execute('machines.managed.delete', actionArgs, { surface: 'ui', authority: 'present_user',
      serverId: 'home', presentUserConfirmation: { actionId: 'machines.managed.delete' } }))
      .toMatchObject({ ok: true });
    expect(approvalsList).toHaveBeenCalledWith(expect.objectContaining({ status: 'open', actionId: 'machines.managed.delete' }));
    expect(approvalsUpdate).toHaveBeenCalledTimes(2);
    expect(stored.get('stale-delete-read-failed')).toMatchObject({ status: 'open' });
    expect(stored.get('stale-delete-update-failed')).toMatchObject({ status: 'open' });
    expect(stored.get('stale-delete-retired')).toMatchObject({ status: 'canceled', actionId: 'machines.managed.delete' });
    expect(recordApprovalRetirementWarning).toHaveBeenCalledWith({ artifactId: 'stale-delete-read-failed', code: 'read_failed' });
    expect(recordApprovalRetirementWarning).toHaveBeenCalledWith({ artifactId: 'stale-delete-update-failed', code: 'update_failed' });

    const listFailureWarning = vi.fn(() => { throw new Error('diagnostic unavailable'); });
    const listFailureExecutor = createActionExecutor({
      managedMachineReferences: async () => ({ homeId: 'home', machineId: 'guest', coverage: 'complete', references: [], unavailable: [] }),
      managedMachineAction: async () => ({ kind: 'accepted', managedId: 'managed', intentRevision: 6,
        operation: { operationId: 'delete-operation-list-failed' } }),
      approvalsList: async () => { throw Object.assign(new Error('queue unavailable'), { code: 'list_failed' }); },
      approvalsGet: async () => null,
      approvalsUpdate: async () => ({ ok: true }),
      recordApprovalRetirementWarning: listFailureWarning,
      isActionApprovalRequired: () => false,
    } as unknown as ActionExecutorDeps);
    expect(await listFailureExecutor.execute('machines.managed.delete', actionArgs, { surface: 'ui', authority: 'present_user',
      serverId: 'home', presentUserConfirmation: { actionId: 'machines.managed.delete' } }))
      .toMatchObject({ ok: true });
    expect(listFailureWarning).toHaveBeenCalledWith({ code: 'list_failed' });
  });

  it('reads requester dependencies before any Delete admission and preserves partial coverage without retargeting references', async () => {
    const census = { homeId: 'home', machineId: 'guest', coverage: 'partial',
      references: [{ kind: 'board', id: 'original-board', name: 'Original board' }], unavailable: ['assignments'] } as const;
    // Account Artifact/settings reads are the system boundary; the Action's
    // parsing, placement, requester context and output validation stay real.
    const managedMachineReferences = vi.fn(async (_args: unknown) => census);
    const managedMachineAction = vi.fn(async () => { throw new Error('A pre-review must not submit a native effect'); });
    const executor = createActionExecutor({ managedMachineReferences, managedMachineAction } as unknown as ActionExecutorDeps);
    const context = { surface: 'ui' as const, authority: 'present_user' as const, serverId: 'home', expectedAccountId: 'requester' };
    expect(await executor.execute('machines.managed.references.get', { homeId: 'home', managedId: 'managed' }, context))
      .toEqual({ ok: true, result: census });
    expect(managedMachineReferences.mock.calls[0]?.[0]).toMatchObject({ input: { homeId: 'home', managedId: 'managed' }, context });
    expect(managedMachineAction).not.toHaveBeenCalled();
    const missing = createActionExecutor({ managedMachineAction } as unknown as ActionExecutorDeps);
    expect(await missing.execute('machines.managed.references.get', { homeId: 'home', managedId: 'managed' }, context))
      .toEqual({ ok: true, result: { homeId: 'home', machineId: null, coverage: 'partial', references: [], unavailable: ['requester_authority'] } });
  });
  it('submits Delete with the census from the reviewed click without a second dependency read', async () => {
    const census = { homeId: 'home', machineId: 'guest', coverage: 'partial',
      references: [{ kind: 'profile', id: 'profile-one', name: 'Profile one' }], unavailable: ['profiles'] } as const;
    const managedMachineReferences = vi.fn(async () => { throw new Error('Delete confirmation repeated its review'); });
    const managedMachineAction = vi.fn(async () => ({ kind: 'approval_request_created', artifactId: 'delete-approval',
      actionId: 'machines.managed.delete' as const }));
    const executor = createActionExecutor({ managedMachineReferences, managedMachineAction } as unknown as ActionExecutorDeps);
    const result = await executor.execute('machines.managed.delete', {
      homeId: 'home', managedId: 'managed', when: 'now', expectedRevision: 4, intent: 'delete', reviewedDependencies: true,
    }, { surface: 'ui', authority: 'present_user', serverId: 'home', expectedAccountId: 'requester',
      presentUserConfirmation: { actionId: 'machines.managed.delete' }, reviewedMachineReferences: census });

    expect(result).toEqual({ ok: true, result: { kind: 'approval_request_created', artifactId: 'delete-approval',
      actionId: 'machines.managed.delete', machineReferences: census } });
    expect(managedMachineReferences).not.toHaveBeenCalled();
    expect(managedMachineAction).toHaveBeenCalledOnce();
  });
  it.each(['ui', 'cli', 'agent', 'mcp'] as const)('refuses opted-out acquisition before approval or transport on %s', async surface => {
    // Durable allocation and approval Artifact persistence are the boundaries.
    const managedMachineAction = vi.fn(async () => ({ managedId: 'managed' }));
    const approvalsCreate = vi.fn(async () => ({ artifactId: 'approval' }));
    const executor = createActionExecutor({ managedMachineAction, approvalsCreate } as ActionExecutorDeps);
    const context = { surface, authority: 'present_user' as const, managedMachineCreationEnabled: false };
    expect(await executor.execute('machines.managed.acquire', acquireInput, context))
      .toEqual({ ok: false, errorCode: 'creation_disabled', error: 'creation_disabled' });
    expect(await executor.prepare('machines.managed.acquire', acquireInput, context))
      .toMatchObject({ kind: 'settled', result: { ok: false, errorCode: 'creation_disabled' } });
    expect(managedMachineAction).not.toHaveBeenCalled();
    expect(approvalsCreate).not.toHaveBeenCalled();
  });

  it('defaults creation on and keeps retained reads and bootstrap retry available after opt-out', async () => {
    const machine = { id: 'retained', homeId: 'home', custodianAccountId: 'account',
      controller: acquireInput.selection.controller, launch: acquireInput.selection.launch,
      allocation: 'unsubmitted', creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 0,
      retention: acquireInput.selection.retention, wakeOnAcceptedMessage: false } as const;
    const executor = createActionExecutor({ managedMachineAction: async ({ actionId }) =>
      actionId === 'machines.managed.list' ? { machines: [machine] }
        : actionId === 'machines.managed.get' ? machine : { managedId: 'retained' },
    } as ActionExecutorDeps);
    for (const enabled of [undefined, true]) {
      expect(await executor.execute('machines.managed.acquire', acquireInput, { surface: 'cli', authority: 'present_user',
        ...(enabled === undefined ? {} : { managedMachineCreationEnabled: enabled }),
        presentUserConfirmation: { actionId: 'machines.managed.acquire' },
      })).toEqual({ ok: true, result: { managedId: 'retained' } });
    }
    const context = { surface: 'cli' as const, authority: 'present_user' as const, managedMachineCreationEnabled: false };
    expect(await executor.execute('machines.managed.list', { homeId: 'home' }, context))
      .toEqual({ ok: true, result: { machines: [machine] } });
    expect(await executor.execute('machines.managed.get', { homeId: 'home', managedId: 'retained' }, context))
      .toEqual({ ok: true, result: machine });
    expect(await executor.execute('machines.managed.bootstrap.retry', { homeId: 'home', managedId: 'retained', expectedIntentRevision: 0 },
      { ...context, presentUserConfirmation: { actionId: 'machines.managed.bootstrap.retry' } }))
      .toEqual({ ok: true, result: { managedId: 'retained' } });
  });

  it('refuses a known external Agent continuation before compute when its original grant cannot start on new compute', async () => {
    const managedMachineAction = vi.fn(async () => ({ managedId: 'managed', operation: { operationId: 'operation' } }));
    const executor = createActionExecutor({ managedMachineAction, isActionApprovalRequired: () => false } as unknown as ActionExecutorDeps);
    const start = { creationKey: 'start', directory: { kind: 'managed' }, agentTarget };
    const context = { surface: 'api' as const, authority: 'account_automation' as const,
      externalActionTarget: { kind: 'machine' as const, machineId: 'controller' },
      externalActionCredential: { accountId: 'account', principalId: 'account', credentialId: 'pat', grant: {
        ...API_TOKEN_FULL_GRANT_V1, actions: { families: [], ids: ['machines.managed.acquire'] },
      } } };
    expect(await executor.execute('machines.managed.acquire', { ...acquireInput, agentStart: start }, context))
      .toMatchObject({ ok: false, errorCode: 'credential_scope_denied' });
    expect(await executor.execute('machines.managed.acquire', { ...acquireInput, agentStart: start }, {
      ...context, externalActionCredential: { ...context.externalActionCredential, grant: {
        ...API_TOKEN_FULL_GRANT_V1, targets: { machines: ['controller'], sessions: [] },
      } },
    })).toMatchObject({ ok: false, errorCode: 'credential_scope_denied' });
    expect(managedMachineAction).not.toHaveBeenCalled();
    expect(await executor.execute('machines.managed.acquire', acquireInput, context)).toMatchObject({ ok: true });
  });
  it('cancels an admitted unsubmitted row after ordinary confirmation without controller or online context', async () => {
    const canceled = { id: 'waiting', homeId: 'home', custodianAccountId: 'account',
      controller: acquireInput.selection.controller, launch: acquireInput.selection.launch,
      allocation: 'unsubmitted', creationState: 'canceled', desired: 'delete', desiredWhen: 'now', intentRevision: 1,
      retention: acquireInput.selection.retention, wakeOnAcceptedMessage: false,
    } as const;
    // The public Account HTTP response is the substituted system boundary;
    // placement, schema admission, confirmation and output validation stay real.
    const deps = { sessionSpawnNew: async () => { throw new Error('Unexpected Agent start'); },
      managedMachineAction: async () => ({ machine: canceled }),
    } satisfies Partial<ActionExecutorDeps>;
    // The isolated public transport fixture intentionally omits unrelated ports.
    const executor = createActionExecutor(deps as ActionExecutorDeps);
    expect(await executor.execute('machines.managed.cancel', {
      homeId: 'home', managedId: 'waiting', expectedIntentRevision: 0,
    }, { surface: 'cli', authority: 'present_user',
      presentUserConfirmation: { actionId: 'machines.managed.cancel' },
    })).toEqual({ ok: true, result: { machine: canceled } });
  });
  it('validates provisioner results through the canonical family output contract', async () => {
    const dimensions = { size: [], image: [], location: [], network: [], duration: [] };
    let networkResult: unknown = { dimensions };
    const executor = createActionExecutor({ managedMachineAction: async () => networkResult,
      isActionApprovalRequired: () => false } as unknown as ActionExecutorDeps);
    const input = { homeId: 'home', controller: acquireInput.selection.controller,
      contribution: acquireInput.selection.launch.provider, selectors: {} };
    expect(await executor.execute('machines.provisioners.options', input, { surface: 'cli' }))
      .toMatchObject({ ok: true, result: { dimensions } });
    networkResult = { choices: 'malformed' };
    expect(await executor.execute('machines.provisioners.options', input, { surface: 'cli' }))
      .toEqual({ ok: false, errorCode: 'invalid_action_output', error: 'invalid_action_output' });
  });

  it('refuses an Agent continuation before approval or acquisition but admits bare compute without Agent context', async () => {
    // Durable acquisition and approval storage are network/persistence boundaries.
    const managedMachineAction = vi.fn(async (_args: unknown) => ({ managedId: 'managed', operation: { operationId: 'operation' } }));
    const approvalsCreate = vi.fn();
    const executor = createActionExecutor({ managedMachineAction, approvalsCreate,
      isActionApprovalRequired: () => false } as unknown as ActionExecutorDeps);
    expect(await executor.execute('machines.managed.acquire', { ...acquireInput, agentStart: {
      creationKey: 'start-1', directory: { kind: 'path', path: '/repo' }, agentTarget,
    } }, { ...agentContext, sessionAgentSpawnPolicyV1: {
      ...DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1, allowCrossMachine: false,
    } })).toMatchObject({ ok: false, errorCode: 'policy_denied_field',
      details: { field: 'executionTarget.machineId' } });
    expect(managedMachineAction).not.toHaveBeenCalled();
    expect(approvalsCreate).not.toHaveBeenCalled();
    expect(await executor.execute('machines.managed.acquire', acquireInput, { surface: 'cli' }))
      .toMatchObject({ ok: true, result: { managedId: 'managed', operation: { operationId: 'operation' } } });
  });

  it('retains admitted child depth and role selection at the real acquisition transport boundary', async () => {
    const managedMachineAction = vi.fn(async (_args: unknown) => ({ managedId: 'managed', operation: { operationId: 'operation' } }));
    const executor = createActionExecutor({ managedMachineAction,
      isActionApprovalRequired: () => false } as unknown as ActionExecutorDeps);
    const result = await executor.execute('machines.managed.acquire', { ...acquireInput, agentStart: {
      creationKey: 'start-1', directory: { kind: 'path', path: '/repo' }, agentTarget, roleId: 'worker',
    } }, { ...agentContext, actionsSettings: ActionsSettingsV1Schema.parse({ v: 1 }), agentStartContext: { ...agentContext.agentStartContext, roles: {
      worker: { roleId: 'worker', name: 'Worker', instructions: 'Complete the task',
        engine: { agentTargetKey: 'agent:role.agent/worker', modelId: 'role-model' },
        runsAs: { kind: 'session' }, workspaceWrites: 'deny', secondOpinion: 'off', enabled: true },
    } } });
    expect(result).toMatchObject({ ok: true });
    expect(managedMachineAction.mock.calls[0]?.[0]).toMatchObject({
      input: { agentStart: { creationKey: 'start-1', agentTarget: {
        kind: 'agent', identity: { pluginId: 'role.agent', localId: 'worker' },
      }, modelSelection: { ref: { modelId: 'role-model' } } } },
      context: { agentStartWorkDepth: 1, agentStartWorkspaceWrites: 'deny' },
    });
  });

  it('fails closed for unsupported hosts and preserves typed transport refusals', async () => {
    const executor = createActionExecutor({ isActionApprovalRequired: () => false } as unknown as ActionExecutorDeps);
    expect(await executor.execute('machines.managed.list', { homeId: 'home' }, { surface: 'cli' }))
      .toMatchObject({ ok: false, errorCode: 'unsupported_action' });
    const refused = createActionExecutor({ isActionApprovalRequired: () => false,
      managedMachineAction: async () => ({ ok: false, errorCode: 'permission_denied', error: 'permission_denied' }),
    } as unknown as ActionExecutorDeps);
    expect(await refused.execute('machines.managed.get', { homeId: 'home', managedId: 'managed' }, { surface: 'cli' }))
      .toEqual({ ok: false, errorCode: 'permission_denied', error: 'permission_denied' });
    const unavailable = createActionExecutor({ managedMachineAction: async () => {
      throw Object.assign(new Error('Controller unavailable at /repo/workspace'), { code: 'controller_unavailable' });
    } } as unknown as ActionExecutorDeps);
    expect(await unavailable.execute('machines.managed.list', { homeId: 'home' }, { surface: 'cli' }))
      .toEqual({ ok: false, errorCode: 'controller_unavailable', error: 'Controller unavailable at /repo/workspace',
        failureCause: { phase: 'machines.managed.list', errorClass: 'Error', errorCode: 'controller_unavailable', httpStatus: null } });
  });
});
