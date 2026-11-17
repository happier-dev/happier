import { describe, expect, it } from 'vitest';
import { createActionExecutor, readHostReviewedChildOperationV1 } from './actionExecutor.js';
import { ActionsSettingsV1Schema } from './actionSettings.js';
import { ApprovalProfileV1Schema } from './approvalProfiles.js';
import { bindApprovalProfileV1 } from './approvalProfileArtifactV1.js';
import { createDeploymentApprovalScopeResolverV1 } from '../deployments/deploymentApprovalScopeV1.js';
import { DeploymentEnvironmentHeaderV1Schema } from '../deployments/deploymentActionsV1.js';
import { createHostReviewedChildPortV1, invokeHostReviewedChildV1, readHostReviewedParentV1 } from './executor/deploymentRoleChild.js';
import * as reviewedChildIssuer from './executor/deploymentRoleChild.js';
import { computeActionInputApprovalDigestV1 } from './decisionAuthority.js';
import { ExternalActionExecutionAuthorizationV1Schema } from './externalActionApi.js';
import { API_TOKEN_FULL_GRANT_V1 } from '../auth/apiTokenGrant.js';
import type { ActionExecutorContext } from './executor/types.js';
import type { ActionId } from './actionIds.js';
import { ApprovalRequestV2Schema, type ApprovalRequest } from '../approvals/approvalRequestV1.js';
import { decideApprovalRequestTransition } from '../approvals/approvalRequestTransition.js';
import { ActionDefinitionSummaryV1Schema } from './actionDefinitionV1.js';
import {
  buildMachineSetupTargetApplyInput,
  machineSetupApplyTargetFromPlanV1,
  MachineSetupPlanResultV1Schema,
  SESSION_SPAWN_MACHINE_SETUP_CHILDREN_V1,
} from '../machines/managed/actionsV1.js';
import { SessionSpawnNewActionInputV2Schema } from '../sessions/creation/sessionSpawnNewInputV2.js';
import { projectNativeJsonValueForTransport } from '../json/strictJsonValue.js';
import { PROVIDER_BROKER_OPEN_HTTP_PATH_V1 } from '../providers/brokerRouteGrantV1.js';

const parent = { actionId: 'machines.setup.apply', input: { homeId: 'home', machineId: 'machine' } };
const child = { action: { pluginId: 'acme.fixture', localId: 'inspect' }, role: 'inspect',
  input: { machineId: 'machine', config: { network: 'reviewed' } } };
const context: ActionExecutorContext = { surface: 'cli', authority: 'present_user',
  actionCaller: { kind: 'host' }, serverId: 'home', runtimeAccountId: 'owner',
  actionRequestId: 'parent-request', externalActionTarget: { kind: 'machine', machineId: 'machine' },
  actionsSettings: ActionsSettingsV1Schema.parse({ v: 1, actions: {
    'action.invoke': { approvalRequiredSurfaces: ['cli'] },
    'acme.fixture/actions/inspect': { approvalRequiredSurfaces: ['cli'] },
  } }) };

describe('generic reviewed host children', () => {
  it('retains native demanded children and their review through explicit approval creation', async () => {
    const input = { rootPath: '/workspace', path: 'README.md' };
    const demanded = { action: 'machines.work.summary.get' as const, role: 'inspect',
      input: { serverId: 'home', machineId: 'machine' } };
    let stored: ApprovalRequest | null = null;
    const effects: string[] = [];
    const executor = createActionExecutor({
      // The host preparer and Artifact storage are external boundaries. Child
      // admission, retained review, decision transition, and replay remain real.
      prepareHostReviewedChildren: async ({ actionId }) => actionId === 'daemon.filesystem.readFile'
        ? { children: [demanded], approvalPreview: { reviewedService: 'web' } } : null,
      approvalsCreate: async ({ request }) => {
        stored = ApprovalRequestV2Schema.parse(request);
        return { artifactId: 'explicit-native-review' };
      },
      approvalsGet: async () => stored,
      approvalsUpdate: async ({ request, expectedStatus }) => {
        if (!stored) throw new Error('Missing original approval');
        const next = ApprovalRequestV2Schema.parse(request);
        const transition = decideApprovalRequestTransition(stored, next, { expectedStatus });
        if (!transition.ok) return transition;
        stored = next;
        return { ok: true };
      },
      isApprovalExecutionOriginCurrent: async () => true,
      filesystemActionExecute: async ({ context }) => {
        const result = await context.hostReviewedChild!.invoke(demanded);
        if (!result.ok) return result;
        effects.push('read');
        return { success: true, content: 'requested file' };
      },
      machineWorkSummaryGet: async () => { effects.push('inspect'); return { kind: 'current', requesters: [] }; },
    });
    const original: ActionExecutorContext = { ...context, serverIdentityId: 'home-identity', machineId: 'machine',
      surface: 'ui', actionsSettings: ActionsSettingsV1Schema.parse({ v: 1 }) };
    const created = await executor.execute('approval.request.create', {
      actionId: 'daemon.filesystem.readFile', actionArgs: input,
      summary: 'Review requested file', createdBy: { surface: 'cli' },
    }, original);
    expect(created, JSON.stringify(created)).toMatchObject({ ok: true });
    expect(effects).toEqual([]);
    expect(stored).toMatchObject({ preview: {
      hostReviewedChildren: { children: [demanded] }, hostReviewedContent: { reviewedService: 'web' },
    } });
    expect(await executor.execute('approval.request.decide', {
      artifactId: 'explicit-native-review', decision: 'approve',
    }, original)).toMatchObject({ ok: true, result: { status: 'executed', execution: { ok: true } } });
    expect(effects).toEqual(['inspect', 'read']);
  });

  it.each([true, false])('folds genuine new-session software setup into one native review without approval Artifacts (accept=%s)', async accept => {
    const setup = { homeId: 'home', machineId: 'machine' };
    const softwarePlan = MachineSetupPlanResultV1Schema.parse({
      desiredRevision: 0,
      sources: [{ kind: 'direct', setup: { scripts: [{ body: 'echo reviewed software' }] } }],
      exclusions: [], support: [], recipePlans: [],
    });
    const applyInput = buildMachineSetupTargetApplyInput(machineSetupApplyTargetFromPlanV1(setup, softwarePlan));
    const spawnInput = SessionSpawnNewActionInputV2Schema.parse({
      creationKey: 'reviewed-software-session', executionTarget: { serverId: 'home', machineId: 'machine' },
      directory: { kind: 'path', path: '/repo' },
      agentTarget: { kind: 'agent', identity: { pluginId: 'native.agent', localId: 'agent' } },
      machineSetupPlanInput: setup,
    });
    const reviews: { actionId: ActionId; preview?: unknown }[] = [];
    const effects: string[] = [];
    let artifacts = 0;
    const executor = createActionExecutor({
      // Native dialogs, Machine setup, and the spawn transport are external boundaries.
      // Declaration-owned children, their policy, and their admission remain real.
      presentUserActionConfirmation: async ({ actionId, preview }) => {
        reviews.push({ actionId, preview });
        return accept;
      },
      approvalsCreate: async () => { artifacts++; return { artifactId: 'must-not-create' }; },
      machineSetupPlan: async () => softwarePlan,
      machineSetupApply: async ({ input }) => {
        expect(input).toEqual(applyInput);
        effects.push('setup');
        return { operationId: 'software-operation' };
      },
      sessionSpawnNew: async ({ context: childContext, machineSetupPlanInput }) => {
        expect(machineSetupPlanInput).toEqual(setup);
        const children = SESSION_SPAWN_MACHINE_SETUP_CHILDREN_V1;
        const planned = await childContext!.hostReviewedChild!.invoke({ ...children.plan,
          input: projectNativeJsonValueForTransport({ ...machineSetupPlanInput, mode: 'effects' }) });
        expect(planned).toMatchObject({ ok: true });
        if (!planned.ok) throw new Error('Declared software planning child was refused');
        const plan = MachineSetupPlanResultV1Schema.parse(planned.result);
        const applied = await childContext!.hostReviewedChild!.invoke({ ...children.apply,
          input: projectNativeJsonValueForTransport(buildMachineSetupTargetApplyInput(machineSetupApplyTargetFromPlanV1(setup, plan))) });
        expect(applied).toMatchObject({ ok: true, result: { operationId: 'software-operation' } });
        if (!applied.ok) throw new Error('Declared software apply child was refused');
        effects.push('spawn');
        return { type: 'pending', retryWithSameCreationKey: true, outcome: 'accepted' };
      },
    });
    const ownUi: ActionExecutorContext = { ...context, surface: 'ui',
      actionsSettings: ActionsSettingsV1Schema.parse({ v: 1 }) };
    const direct = await executor.execute('machines.setup.apply', applyInput, { ...ownUi, actionRequestId: 'direct-software' });
    expect(direct).toMatchObject(accept ? { ok: true } : { ok: false, errorCode: 'approval_canceled' });
    expect(reviews.map(review => review.actionId)).toEqual(['machines.setup.apply']);
    expect(effects).toEqual(accept ? ['setup'] : []);
    const directReviewCount = reviews.length;
    reviews.length = 0;
    effects.length = 0;

    const spawned = await executor.execute('session.spawn_new', spawnInput, { ...ownUi, actionRequestId: 'spawn-with-software' });
    expect(spawned).toMatchObject(accept ? { ok: true, result: { type: 'pending' } }
      : { ok: false, errorCode: 'approval_canceled' });
    expect(reviews).toHaveLength(directReviewCount);
    expect(reviews).toEqual([{ actionId: 'session.spawn_new', preview: expect.objectContaining({
      hostReviewedContent: expect.objectContaining({ machineSetup: softwarePlan }),
    }) }]);
    expect(effects).toEqual(accept ? ['setup', 'spawn'] : []);
    expect(artifacts).toBe(0);
  });

  it('restores only an exact verified signed leaf without inventing parent or credential consent', async () => {
    const input = { homeId: 'home', machineId: 'machine' };
    const child = { actionId: 'machines.setup.apply' as const, role: 'session_spawn_setup_apply',
      inputDigest: computeActionInputApprovalDigestV1('machines.setup.apply', input), input };
    await reviewedChildIssuer.invokeHostAdmittedSignedReviewedChildV1({ context, child,
      execute: async (value, admitted) => {
        expect(value).toEqual(input);
        expect(reviewedChildIssuer.readHostAdmittedReviewedChildV1(admitted)).toEqual(child);
        expect(reviewedChildIssuer.readHostAdmittedReviewedChildV1(JSON.parse(JSON.stringify(admitted)))).toBeNull();
        expect(readHostReviewedChildOperationV1(admitted, child.actionId, { ...input, machineId: 'other' })).toBeNull();
        expect(readHostReviewedChildOperationV1(admitted, child.actionId, input)).toBeNull();
        expect(readHostReviewedParentV1(admitted)).toBeNull();
        expect(reviewedChildIssuer.readHostReviewedChildRootV1(admitted, child.actionId, input)).toBeNull();
        expect(reviewedChildIssuer.readHostReviewedChildOriginalAuthorizationV1(admitted)).toBeUndefined();
        expect(reviewedChildIssuer.hasHostReviewedChildCredentialScopeAdmissionV1(admitted, child.actionId, input)).toBe(false);
        return { ok: true };
      },
    });
  });

  it.each(['none', 'admitted', 'grant', 'target', 'input'] as const)('spends concrete child scope admission only for its original grant and operand (%s)', async change => {
    const plan = { action: 'machines.setup.plan' as const, role: 'plan', input: { homeId: 'home', machineId: 'machine', mode: 'effects' as const } };
    const grant = { ...API_TOKEN_FULL_GRANT_V1, actions: { families: [], ids: ['daemon.filesystem.readFile', plan.action] },
      targets: { sessions: [], machines: ['machine'] } };
    const credential = { accountId: 'owner', principalId: 'pat', credentialId: 'credential', grant };
    const target = { kind: 'machine' as const, machineId: 'machine' };
    let planned = 0;
    let childResult: Awaited<ReturnType<NonNullable<ActionExecutorContext['hostReviewedChild']>['invoke']>> | undefined;
    const executor = createActionExecutor({
      prepareHostReviewedChildren: async ({ actionId }) => actionId === 'daemon.filesystem.readFile' ? { children: [plan] } : null,
      filesystemActionExecute: async ({ context }) => {
        // Already admitted work spends its private fact instead of evaluating the same grant again.
        if (change === 'admitted') grant.actions.ids.splice(grant.actions.ids.indexOf(plan.action), 1);
        if (change === 'grant') credential.grant = { ...grant, actions: { families: [], ids: ['daemon.filesystem.readFile'] } };
        if (change === 'target') target.machineId = 'other';
        childResult = await context.hostReviewedChild!.invoke(change === 'input'
          ? { ...plan, input: { ...plan.input, machineId: 'other' } } : plan);
        return { success: true, content: 'requested file' };
      },
      machineSetupPlan: async () => { planned++; return { desiredRevision: 0, sources: [{ kind: 'direct', setup: {} }], exclusions: [], support: [], recipePlans: [] }; },
    });
    expect(await executor.execute('daemon.filesystem.readFile', { rootPath: '/workspace', path: 'README.md' }, {
      ...context, surface: 'ui', authority: 'account_automation', externalActionTarget: target, externalActionCredential: credential,
    })).toMatchObject({ ok: true });
    const admitted = change === 'none' || change === 'admitted';
    expect(childResult, JSON.stringify(childResult)).toMatchObject(admitted ? { ok: true } : { ok: false, errorCode: 'credential_scope_denied' });
    expect(planned).toBe(admitted ? 1 : 0);
  });

  it('does not accept a concrete child scope admission supplied through public execution context', async () => {
    const grant = { ...API_TOKEN_FULL_GRANT_V1, actions: { families: [], ids: ['daemon.filesystem.readFile'] } };
    let planned = 0;
    const executor = createActionExecutor({ machineSetupPlan: async () => {
      planned++; return { desiredRevision: 0, sources: [], exclusions: [], support: [], recipePlans: [] };
    } });
    expect(await executor.execute('machines.setup.plan', { homeId: 'home', machineId: 'machine' }, {
      ...context, externalActionCredential: { accountId: 'owner', principalId: 'pat', credentialId: 'credential', grant },
      ...{ credentialScopeAdmission: { grant, target: context.externalActionTarget } },
    })).toMatchObject({ ok: false, errorCode: 'credential_scope_denied' });
    expect(planned).toBe(0);
  });
  it('keeps a direct person original port usable by its admitted nested power without fabricating confirmation', async () => {
    const input = { rootPath: '/workspace', path: 'README.md' };
    const power = { action: 'machines.managed.power.set' as const, role: 'managed-wake', input: {
      homeId: 'home', managedId: 'managed', when: 'now' as const, expectedRevision: 1, intent: 'start' as const,
    } };
    const inspect = { action: 'machines.work.summary.get' as const, role: 'inspect', input: { serverId: 'home', machineId: 'machine' } };
    let rootPort: ActionExecutorContext['hostReviewedChild'];
    let powerPort: ActionExecutorContext['hostReviewedChild'];
    let reviews = 0;
    const effects: string[] = [];
    const executor = createActionExecutor({
      prepareHostReviewedChildren: async ({ actionId }) => actionId === 'daemon.filesystem.readFile'
        ? { children: [power, inspect] } : null,
      approvalsCreate: async () => { reviews++; return { artifactId: 'must-not-ask' }; },
      filesystemActionExecute: async ({ context }) => {
        rootPort = context.hostReviewedChild;
        const result = await rootPort!.invoke(power);
        if (!result.ok) return result;
        return { success: true, content: 'requested file' };
      },
      managedMachineAction: async ({ context }) => {
        powerPort = context.hostReviewedChild;
        if (!powerPort) return { kind: 'conflict', currentRevision: 1 };
        expect(readHostReviewedParentV1(context)).toEqual({ actionId: 'daemon.filesystem.readFile', input });
        const result = await powerPort.invoke(inspect);
        if (!result.ok) return result;
        effects.push('power');
        return { kind: 'conflict', currentRevision: 1 };
      },
      machineWorkSummaryGet: async () => { effects.push('inspect'); return { kind: 'current', requesters: [] }; },
    });
    expect(await executor.execute('daemon.filesystem.readFile', input, { ...context, surface: 'ui' }))
      .toMatchObject({ ok: true, result: { content: 'requested file' } });
    expect(rootPort).toBeDefined();
    expect(rootPort?.parent).toBeUndefined();
    expect(powerPort).toBe(rootPort);
    expect(reviews).toBe(0);
    expect(effects).toEqual(['inspect', 'power']);
  });

  it.each([
    { decision: 'approve', authority: 'present_user', signed: false, changed: false },
    { decision: 'reject', authority: 'present_user', signed: false, changed: false },
    { decision: 'approve', authority: 'account_automation', signed: false, changed: false },
    { decision: 'approve', authority: 'present_user', signed: true, changed: false },
    { decision: 'approve', authority: 'account_automation', signed: false, changed: true },
  ] as const)('keeps one original review through nested power and refuses undeclared roles ($decision, $authority, signed=$signed, changed=$changed)', async ({ decision, authority, signed, changed }) => {
    const input = { rootPath: '/workspace', path: 'README.md' };
    const power = { action: 'machines.managed.power.set' as const, role: 'managed-wake', input: {
      homeId: 'home', managedId: 'managed', when: 'now' as const, expectedRevision: 1, intent: 'start' as const,
    } };
    const inspect = { action: 'machines.work.summary.get' as const, role: 'inspect',
      input: { serverId: 'home', machineId: 'machine' } };
    const plan = { children: [power, inspect] };
    let preparationPlan = plan;
    const effects: string[] = [];
    let reviews = 0;
    let stored: ApprovalRequest | null = null;
    const nestedPreparations: string[] = [];
    let rootPort: ActionExecutorContext['hostReviewedChild'];
    let powerPort: ActionExecutorContext['hostReviewedChild'];
    const executor = createActionExecutor({
      prepareHostReviewedChildren: async ({ actionId }) => {
        if (actionId === 'daemon.filesystem.readFile') return preparationPlan;
        if (actionId === power.action || actionId === inspect.action) nestedPreparations.push(actionId);
        return null;
      },
      approvalsCreate: async ({ request }) => {
        reviews++;
        stored = ApprovalRequestV2Schema.parse(request);
        return { artifactId: 'original-review' };
      },
      approvalsGet: async () => stored,
      approvalsUpdate: async ({ request, expectedStatus }) => {
        if (!stored) throw new Error('Missing original approval');
        const next = ApprovalRequestV2Schema.parse(request);
        const transition = decideApprovalRequestTransition(stored, next, { expectedStatus });
        if (!transition.ok) return transition;
        stored = next;
        return { ok: true };
      },
      isApprovalExecutionOriginCurrent: async () => true,
      filesystemActionExecute: async ({ context }) => {
        rootPort = context.hostReviewedChild;
        const result = await rootPort!.invoke(power);
        if (!result.ok) return result;
        return { success: true, content: 'requested file' };
      },
      managedMachineAction: async ({ context }) => {
        powerPort = context.hostReviewedChild;
        if (!powerPort) return { kind: 'conflict', currentRevision: 1 };
        expect(context.hostReviewedChild?.parent).toEqual({ actionId: 'daemon.filesystem.readFile', input });
        expect(await context.hostReviewedChild!.invoke({ ...inspect, role: 'foreign' }))
          .toMatchObject({ ok: false, errorCode: 'credential_scope_denied' });
        const result = await context.hostReviewedChild!.invoke(inspect);
        if (!result.ok) return result;
        effects.push('power');
        return { kind: 'conflict', currentRevision: 1 };
      },
      machineWorkSummaryGet: async () => { effects.push('inspect'); return { kind: 'current', requesters: [] }; },
    });
    const original: ActionExecutorContext = { ...context, serverIdentityId: 'home-identity', machineId: 'machine', surface: 'agent', authority: 'account_automation',
      actionsSettings: ActionsSettingsV1Schema.parse({ v: 1 }) };
    expect(await executor.execute('daemon.filesystem.readFile', input, original))
      .toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
    expect(effects).toEqual([]);
    if (changed) preparationPlan = { children: [inspect] };
    // Home verification is the transport boundary; this is its admitted Account decision binding.
    const decisionAuthorization = signed ? ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'verified-decision', binding: {
      serverIdentityId: 'home-identity', accountId: 'owner', custodianAccountId: 'owner', machineId: 'machine',
      installationId: 'installation', actionId: 'approval.request.decide', requestId: 'decision-request',
      requestEnvelopeDigest: 'A'.repeat(43), target: { kind: 'machine', machineId: 'machine' },
      authentication: { kind: 'account', tokenEpoch: 1 },
      approvalDecisionAdmission: { artifactId: 'original-review', decision },
    } }) : undefined;
    const decided = await executor.execute('approval.request.decide', { artifactId: 'original-review', decision },
      { ...original, surface: 'ui', authority, ...(decisionAuthorization ? {
        actionRequestId: 'decision-request', externalActionExecutionAuthorization: decisionAuthorization,
      } : {}) });
    if (decision === 'reject') {
      expect(decided).toMatchObject({ ok: true, result: { status: 'rejected' } });
      expect(reviews).toBe(1);
      expect(rootPort).toBeUndefined();
      expect(effects).toEqual([]);
      return;
    }
    if (changed) {
      expect(decided).toMatchObject({ ok: true, result: { status: 'failed', execution: { ok: false, errorCode: 'approval_stale' } } });
      expect(rootPort).toBeUndefined();
      expect(effects).toEqual([]);
      expect(reviews).toBe(1);
      return;
    }
    expect(decided, JSON.stringify(decided))
      .toMatchObject({ ok: true, result: { status: 'executed', execution: { ok: true } } });
    expect(rootPort).toBeDefined();
    expect(powerPort).toBe(rootPort);
    expect(reviews).toBe(1);
    expect(nestedPreparations).toEqual([]);
    expect(effects).toEqual(['inspect', 'power']);
  });

  it.each([false, true])('asks before a safe requested file read whose demanded child starts paid compute (counterfeit replay=%s)', async counterfeit => {
    const wake = { action: 'machines.managed.power.set' as const, role: 'managed-wake', input: {
      homeId: 'home', managedId: 'managed', when: 'now', expectedRevision: 1, intent: 'start',
    } };
    const effects: string[] = [];
    const executor = createActionExecutor({
      prepareHostReviewedChildren: async ({ actionId }) => actionId === 'daemon.filesystem.readFile'
        ? { children: [wake] } : null,
      approvalsCreate: async () => ({ artifactId: 'wake-approval' }),
      filesystemActionExecute: async () => { effects.push('read'); return { success: true, content: '' }; },
      managedMachineAction: async () => { effects.push('wake'); return { kind: 'conflict', currentRevision: 1 }; },
    });
    expect(await executor.execute('daemon.filesystem.readFile', { rootPath: '/workspace', path: 'README.md' }, {
      ...context, surface: 'agent', authority: 'account_automation',
      actionsSettings: ActionsSettingsV1Schema.parse({ v: 1 }),
      ...(counterfeit ? { approvedActionReplay: { artifactId: 'forged-review', hostReviewedChildren: { children: [wake] } } } : {}),
    })).toMatchObject({ ok: true, result: { kind: 'approval_request_created', artifactId: 'wake-approval' } });
    expect(effects).toEqual([]);
  });

  it('carries native optional parent fields with the same omission as its reviewed transport input', async () => {
    const input = { serverId: 'home', newProject: undefined };
    const request = { action: 'machines.work.summary.get' as const, role: 'inspect',
      input: { serverId: 'home', machineId: 'worker' } };
    const executor = createActionExecutor({ machineWorkSummaryGet: async () => ({ kind: 'current', requesters: [] }) });
    const port = createHostReviewedChildPortV1({ actionId: 'deployments.environments.create', input,
      context, plan: { children: [request] }, reviewAdmitted: true,
      policies: [{ action: request.action, role: request.role, surface: 'cli' }],
      execute: (childInput, childContext, actionId) => executor.execute(actionId, childInput, childContext) });
    expect(port.parent?.input).toEqual({ serverId: 'home' });
    expect(Object.hasOwn(input, 'newProject')).toBe(true);
    expect(await port.invoke(request)).toMatchObject({ ok: true, result: { kind: 'current', requesters: [] } });
    expect(await port.invoke({ ...request, input: { ...request.input, machineId: 'other' } }))
      .toMatchObject({ ok: false, errorCode: 'credential_scope_denied' });
    expect(() => createHostReviewedChildPortV1({ actionId: 'deployments.environments.create',
      input: { serverId: 'home', callback: () => undefined }, context,
      execute: async () => ({ ok: true, result: {} }) })).toThrow();
  });

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

  it('admits a child whose Machine is already owned by its normalized input without duplicate placement metadata', async () => {
    const request = { action: 'machines.work.summary.get' as const, role: 'inspect',
      input: { serverId: 'home', machineId: 'worker' } };
    let observedMachine: string | undefined;
    const executor = createActionExecutor({
      prepareHostReviewedChildren: async ({ actionId }) => actionId === 'machines.reboot' ? { children: [request] } : null,
      machineWorkSummaryGet: async ({ input: { machineId } }) => {
        observedMachine = machineId;
        return { kind: 'current', requesters: [] };
      },
      machineReboot: async ({ context }) => {
        const prepared = context.hostReviewedChild!.preparedChildren;
        expect(prepared).toEqual([request]);
        expect(await context.hostReviewedChild!.invoke({ ...prepared![0]!, input: { serverId: 'home', machineId: 'unreviewed' } }))
          .toMatchObject({ ok: false, errorCode: 'credential_scope_denied' });
        const result = await context.hostReviewedChild!.invoke(prepared![0]!);
        if (!result.ok) return result;
        return { kind: 'unavailable', reason: 'needs_attendance' };
      },
    });
    expect(await executor.execute('machines.reboot', {
      serverId: 'home', machineId: 'machine', expectedInstallationId: 'installation',
    }, { ...context, bypassApprovals: true }))
      .toMatchObject({ ok: true, result: { kind: 'unavailable', reason: 'needs_attendance' } });
    expect(observedMachine).toBe('worker');
  });

  it('runs the exact reviewed non-deployment child through canonical admission without another approval', async () => {
    const executor = createActionExecutor({});
    const result = await invokeHostReviewedChildV1({ parent, context, child,
      admittedReview: { action: child.action, role: child.role, surface: 'cli', requiredActionIds: ['action.invoke'] },
      execute: async (input, childContext) => {
        let identityReads = 0;
        const admittedIdentityKeys = new Set<PropertyKey>(['authority', 'externalActionExecutionAuthorization',
          'externalActionCredential', 'serverId', 'serverIdentityId', 'runtimeAccountId', 'actionCaller',
          'rpcSessionAuthorization', 'operationAcceptance', 'externalActionTarget']);
        const observed = new Proxy(childContext, { get(target, key, receiver) {
          if (admittedIdentityKeys.has(key)) identityReads++;
          return Reflect.get(target, key, receiver);
        } });
        expect(readHostReviewedChildOperationV1(observed, 'action.invoke', input)?.parent).toEqual(parent);
        expect(identityReads).toBe(0);
        // A serialized requester cannot carry the private in-process proof.
        expect(readHostReviewedChildOperationV1(JSON.parse(JSON.stringify(childContext)), 'action.invoke', input)).toBeNull();
        return executor.execute('action.invoke', input, childContext);
      } });
    // No plugin is installed: reaching its canonical runtime proves both
    // explicit Require policies consumed the parent's admitted role review.
    expect(result).toMatchObject({ ok: false, errorCode: 'contributed_action_unavailable' });
  });

  it('re-enters a dynamically issued reviewed child through the host route with its private proof', async () => {
    const input = { homeId: 'home', managedId: 'managed', expectedRevision: 1,
      when: 'now' as const, intent: 'start' as const };
    const child = { action: { pluginId: 'acme.fixture', localId: 'power' }, role: 'power', input: { resource: { id: 'private' } } };
    let routed = 0;
    const executor = createActionExecutor({
      managedMachineAction: async ({ context }) => {
        const parent = context.hostReviewedChild?.parent;
        expect(parent).toEqual({ actionId: 'machines.managed.power.set', input });
        if (!parent) return { ok: false, errorCode: 'credential_scope_denied', error: 'credential_scope_denied' };
        const port = createHostReviewedChildPortV1({ actionId: parent.actionId, input: parent.input, context,
          reviewAdmitted: true, plan: { children: [child] },
          policies: [{ action: child.action, role: child.role, surface: 'cli' }],
          execute: async (body, childContext) => {
            const reenter = childContext.executeHostReviewedChildAction;
            expect(reenter).toBeTypeOf('function');
            if (!reenter) return { ok: false, errorCode: 'credential_scope_denied', error: 'credential_scope_denied' };
            return await reenter('action.invoke', body, childContext);
          } });
        const result = await port.invoke(child);
        if (!result.ok) return result;
        return { kind: 'accepted', managedId: input.managedId, intentRevision: 2 };
      },
      routeHostChildAction: async ({ actionId, input: childInput, context: childContext }) => {
        routed++;
        expect(actionId).toBe('action.invoke');
        expect(readHostReviewedChildOperationV1(childContext, actionId, childInput)?.parent)
          .toEqual({ actionId: 'machines.managed.power.set', input });
        // The proof and callback are host-local, never part of a serialized child request.
        expect(readHostReviewedChildOperationV1(JSON.parse(JSON.stringify(childContext)), actionId, childInput)).toBeNull();
        return { ok: true, result: { kind: 'confirmed' } };
      },
    });
    const requestId = 'dynamic-reviewed-child';
    const execution = await executor.execute('machines.managed.power.set', input, {
      ...context, actionsSettings: ActionsSettingsV1Schema.parse({ v: 1 }),
      actionRequestId: requestId, presentUserConfirmation: { actionId: 'machines.managed.power.set',
        inputDigest: computeActionInputApprovalDigestV1('machines.managed.power.set', input), requestId,
        accountId: context.runtimeAccountId!, serverId: context.serverId!, target: context.externalActionTarget! },
    });
    expect(execution, JSON.stringify(execution)).toMatchObject({ ok: true,
      result: { kind: 'accepted', managedId: input.managedId, intentRevision: 2 } });
    expect(routed).toBe(1);
  });

  it.each(['settings', 'profile'] as const)('folds demanded child Require from %s into the parent and supplies its port only after exact review', async policy => {
    const input = { serverId: 'home', machineId: 'machine', expectedInstallationId: 'installation' };
    const plan = { children: [child] };
    let entered = 0;
    const executor = createActionExecutor({
      listContributedActionDefinitions: () => [ActionDefinitionSummaryV1Schema.parse({ id: 'acme.fixture/actions/inspect',
        title: 'Inspect', description: null, safety: 'safe', placements: [], slash: null, bindings: null,
        examples: null, surfaces: { cli: true }, inputHints: null })],
      prepareHostReviewedChildren: async ({ actionId }) => actionId === 'machines.reboot' ? plan : null,
      machineReboot: async ({ context }) => {
        entered++;
        return context.hostReviewedChild!.invoke(child);
      },
    });
    const root = { ...context, interactivePresentation: 'unavailable' as const, bypassApprovals: true,
      ...(policy !== 'settings' ? { approvalProfileId: 'test:child-review', actionsSettings: ActionsSettingsV1Schema.parse({ v: 1,
      }), approvalProfile: bindApprovalProfileV1([{ id: 'test:child-review', access: 'owner',
        revision: { headerVersion: 1, bodyVersion: 1 }, profile: ApprovalProfileV1Schema.parse({ id: 'test:child-review',
          name: 'Child review', actions: { 'acme.fixture/actions/inspect': { approvalRequiredSurfaces: ['cli'] } } }) }],
      'test:child-review') } : {}) };
    expect(await executor.execute('machines.reboot', input, root))
      .toMatchObject({ ok: false, errorCode: 'action_interactive_review_required' });
    expect(entered).toBe(0);
    const reviewed = { ...root, actionRequestId: 'reboot', approvedActionReplay: { artifactId: 'approval', hostReviewedChildren: plan },
      presentUserApproval: { artifactId: 'approval', actionId: 'machines.reboot' as const, requestId: 'reboot',
        decidingAccountId: 'owner', inputDigest: computeActionInputApprovalDigestV1('machines.reboot', input) } };
    expect(await executor.execute('machines.reboot', input, reviewed))
      .toMatchObject({ ok: false, errorCode: 'contributed_action_unavailable' });
    expect(entered).toBe(1);
    expect(await executor.execute('machines.reboot', { ...input, machineId: 'other' }, reviewed))
      .toMatchObject({ ok: false, errorCode: 'approval_stale' });
    expect(entered).toBe(1);
  });

  it('uses the same port for an exact built-in child and refuses input outside the reviewed plan', async () => {
    const input = { serverId: 'home', machineId: 'machine', expectedInstallationId: 'installation' };
    const request = { action: 'machines.work.summary.get' as const, role: 'inspect',
      input: { serverId: 'home', machineId: 'machine' } };
    const plan = { children: [request] };
    let reads = 0;
    const executor = createActionExecutor({
      prepareHostReviewedChildren: async ({ actionId }) => actionId === 'machines.reboot' ? plan : null,
      machineWorkSummaryGet: async () => { reads++; return { kind: 'current', requesters: [] }; },
      machineReboot: async ({ context }) => {
        const port = context.hostReviewedChild!;
        const result = await port.invoke(request);
        if (!result.ok) return result;
        expect(result.result).toEqual({ kind: 'current', requesters: [] });
        expect(await port.invoke({ ...request, input: { ...request.input, machineId: 'other' } }))
          .toMatchObject({ ok: false, errorCode: 'credential_scope_denied' });
        return { kind: 'unavailable', reason: 'needs_attendance' };
      },
    });
    expect(await executor.execute('machines.reboot', input, { ...context, bypassApprovals: true }))
      .toMatchObject({ ok: true, result: { kind: 'unavailable', reason: 'needs_attendance' } });
    expect(reads).toBe(1);
  });

  it('binds a generated child to its known scope operands without dropping the legitimate child', async () => {
    const declaration = { action: 'machines.work.summary.get' as const, role: 'inspect',
      scopeInput: { serverId: 'home', machineId: 'worker' } };
    let reads = 0;
    const executor = createActionExecutor({
      prepareHostReviewedChildren: async ({ actionId }) => actionId === 'machines.reboot'
        ? { children: [declaration] } : null,
      machineWorkSummaryGet: async () => { reads++; return { kind: 'current', requesters: [] }; },
      machineReboot: async ({ context }) => {
        const port = context.hostReviewedChild!;
        const request = { action: declaration.action, role: declaration.role, input: declaration.scopeInput };
        expect(await port.invoke({ ...request, input: { ...request.input, machineId: 'other' } }))
          .toMatchObject({ ok: false, errorCode: 'credential_scope_denied' });
        expect(await port.invoke({ ...request, input: { ...request.input, serverId: 'other-home' } }))
          .toMatchObject({ ok: false, errorCode: 'credential_scope_denied' });
        expect(await port.invoke(request)).toMatchObject({ ok: true, result: { kind: 'current', requesters: [] } });
        return { kind: 'unavailable', reason: 'needs_attendance' };
      },
    });
    expect(await executor.execute('machines.reboot', {
      serverId: 'home', machineId: 'machine', expectedInstallationId: 'installation',
    }, { ...context, bypassApprovals: true })).toMatchObject({ ok: true });
    expect(reads).toBe(1);
  });

  it('folds a generated child Environment Require before the waived parent owner can act', async () => {
    const environment = DeploymentEnvironmentHeaderV1Schema.parse({
      v: 1, id: 'reviewed-environment', serverId: 'home', projectSourceId: 'source', revision: 3,
      owner: { kind: 'account', accountId: 'owner' }, protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers',
      controllerMachineId: 'controller', runtimeTargetLinkId: 'runtime', contentArtifactId: 'content',
      contentHeaderVersion: 1, contentBodyVersion: 1, createdByAccountId: 'owner', createdAtMs: 1, updatedAtMs: 1,
      capabilities: { role: 'manager', read: true, deploy: true, manage: true, manageBindings: true, manageTargets: true, delete: true },
    });
    let effects = 0;
    const executor = createActionExecutor({
      prepareHostReviewedChildren: async ({ actionId }) => actionId === 'machines.reboot' ? { children: [{
        action: 'deployments.bindings.set', role: 'bindings', scopeInput: { serverId: 'home', environmentId: environment.id },
      }] } : null,
      // Environment metadata HTTP is the boundary; the scope resolver and policy stay real.
      resolveEnvironmentApprovalScope: createDeploymentApprovalScopeResolverV1(async () => ({ ok: true, environment, targetLinks: [] })),
      machineReboot: async () => { effects++; return { kind: 'unavailable', reason: 'needs_attendance' }; },
    });
    const result = await executor.execute('machines.reboot', {
      serverId: 'home', machineId: 'machine', expectedInstallationId: 'installation',
    }, { ...context, surface: 'ui', interactivePresentation: 'unavailable', actionsSettings: ActionsSettingsV1Schema.parse({ v: 1,
      approvalWaivedSurfaces: { 'machines.reboot': ['ui'], 'deployments.bindings.set': ['ui'] },
      scopedApprovalPreferences: [{ actionId: 'deployments.bindings.set', scope: { kind: 'environment', environmentId: environment.id },
        approvalRequiredSurfaces: ['ui'], approvalWaivedSurfaces: [] }],
    }) });
    expect(result).toMatchObject({ ok: false, errorCode: 'action_interactive_review_required' });
    expect(effects).toBe(0);
  });

  it('retains a signed SOURCE root while admitting its independently reviewed physical worker', async () => {
    const root = { actionId: 'machines.reboot', input: { serverId: 'home', machineId: 'source', expectedInstallationId: 'source-installation' } };
    const grant = { ...API_TOKEN_FULL_GRANT_V1, actions: { families: [], ids: ['machines.reboot'] },
      targets: { sessions: [], machines: ['source'], environments: [] } };
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'fixture-source', binding: {
      serverIdentityId: 'home-identity', accountId: 'owner', principalId: 'owner', credentialId: 'source-token', grant,
      custodianAccountId: 'owner', machineId: 'source', installationId: 'source-installation', actionId: 'machines.reboot',
      requestId: 'source-request', requestEnvelopeDigest: 'A'.repeat(43), target: { kind: 'machine', machineId: 'source' },
    } });
    const rootContext: ActionExecutorContext = { ...context, serverIdentityId: 'home-identity',
      externalActionExecutionAuthorization: authorization, externalActionTarget: authorization.binding.target,
      externalActionCredential: { accountId: 'owner', principalId: 'owner', credentialId: 'source-token', grant } };
    const receivingAdmission = { actorAccountId: 'owner', custodianAccountId: 'worker-owner', machineId: 'machine',
      installationId: 'installation', role: 'use' as const, encryptionMode: 'plain' as const };
    let entered = 0;
    const execute = async (_input: unknown, childContext: ActionExecutorContext) => {
      entered++;
      expect(childContext.externalActionExecutionAuthorization).toBe(authorization);
      expect(childContext.externalActionTarget).toEqual(authorization.binding.target);
      return { ok: true as const, result: {} };
    };
    expect(await invokeHostReviewedChildV1({ parent: root, context: rootContext, child,
      receivingAdmission, execute })).toMatchObject({ ok: true });
    expect(await invokeHostReviewedChildV1({ parent: root, context: rootContext, child,
      receivingAdmission: { ...receivingAdmission, actorAccountId: 'other' }, execute }))
      .toMatchObject({ ok: false, errorCode: 'credential_scope_denied' });
    expect(await invokeHostReviewedChildV1({ parent: root,
      context: { ...rootContext, runtimeAccountId: 'other' }, child, execute }))
      .toMatchObject({ ok: false, errorCode: 'credential_scope_denied' });
    expect(entered).toBe(1);
  });

  it('keeps preparation reads on their own admitted purpose when a core continuation invokes its writer', async () => {
    const root = { actionId: 'deployments.environments.moveToRepository', input: { serverId: 'home', environmentId: 'environment' } };
    const update = { action: 'deployments.environments.update' as const, role: 'move.definition',
      input: { serverId: 'home', environmentId: 'environment', expectedRevision: 1,
        contentArtifactId: 'candidate', contentHeaderVersion: 1, contentBodyVersion: 1 } };
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'root-token', binding: {
      serverIdentityId: 'home', accountId: 'owner', custodianAccountId: 'owner', machineId: 'machine',
      installationId: 'installation', actionId: root.actionId, requestId: 'root-request',
      requestEnvelopeDigest: 'A'.repeat(43), target: context.externalActionTarget,
      authentication: { kind: 'account', tokenEpoch: 1 },
    } });
    const requests: unknown[] = [];
    Object.defineProperty(authorization, 'requesterHttpProjection', { value: {
      accountId: 'owner', serverId: 'home', serverIdentityId: 'home', serverHttpBaseUrl: 'https://home.test',
      isCurrent: async () => true,
      createRequestHeaders: async (request: unknown) => { requests.push(request); return {}; },
    } });
    const read = { effectActionId: 'deployments.environments.get', method: 'GET', path: '/v1/deployments/environments/environment' };
    const artifactRead = { effectActionId: update.action, method: 'GET', path: '/v1/artifacts/candidate' };
    const write = { effectActionId: update.action, method: 'PATCH', path: read.path, body: update.input };
    await invokeHostReviewedChildV1({ parent: root, context: { ...context, externalActionExecutionAuthorization: authorization },
      child: update, admittedReview: { action: update.action, role: update.role, surface: 'cli' },
      execute: async (_input, childContext) => {
        const http = childContext.externalActionExecutionAuthorization!.requesterHttpProjection!;
        await http.createRequestHeaders(read);
        await http.createRequestHeaders(artifactRead);
        await http.createRequestHeaders(write);
        return { ok: true, result: null };
      } });
    expect(requests).toEqual([read, { ...artifactRead, effectActionId: root.actionId }, { ...write, reviewedChild: {
      actionId: update.action, role: update.role, inputDigest: computeActionInputApprovalDigestV1(update.action, update.input),
    } }]);
  });

  it('projects only admitted live children onto the root HTTP port and keeps private root facets', async () => {
    const root = { actionId: 'machines.reboot', input: { serverId: 'home', machineId: 'machine', expectedInstallationId: 'installation' } };
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'root-token', binding: {
      serverIdentityId: 'home-identity', accountId: 'owner', custodianAccountId: 'owner', machineId: 'machine',
      installationId: 'installation', actionId: root.actionId, requestId: 'root-request',
      requestEnvelopeDigest: 'A'.repeat(43), target: context.externalActionTarget,
      authentication: { kind: 'account', tokenEpoch: 1 },
    } });
    const networkRequests: unknown[] = [];
    const requesterHttpProjection = { accountId: 'owner', serverId: 'home', serverIdentityId: 'home-identity',
      serverHttpBaseUrl: 'https://home.test', isCurrent: async () => true,
      createRequestHeaders: async (request: unknown) => { networkRequests.push(request); return {}; } };
    const requesterAccountExecutor = createActionExecutor({});
    Object.defineProperties(authorization, {
      requesterHttpProjection: { value: requesterHttpProjection, enumerable: false },
      requesterAccountExecutor: { value: requesterAccountExecutor, enumerable: false },
    });
    const abort = new AbortController();
    const rootContext = { ...context, signal: abort.signal, externalActionExecutionAuthorization: authorization };
    const request = { effectActionId: 'deployments.environment.get', method: 'GET', path: '/v1/deployments/environments/new' };
    let expectsAdmittedProof = false;
    const execute = async (_input: unknown, childContext: ActionExecutorContext) => {
      // Read through the module so the RED names the missing capability without
      // introducing an unloadable named import into the shared package graph.
      const readProof = Reflect.get(reviewedChildIssuer, 'readHostAdmittedReviewedChildV1');
      const expectedProof = expectsAdmittedProof ? { actionId: 'acme.fixture/actions/inspect',
        role: child.role, input: child.input,
        inputDigest: computeActionInputApprovalDigestV1('acme.fixture/actions/inspect' as ActionId, child.input) } : null;
      expect(typeof readProof === 'function' ? readProof(childContext) : null).toEqual(expectedProof);
      if (typeof readProof === 'function') {
        expect(readProof({ ...childContext })).toEqual(expectedProof);
        expect(readProof(JSON.parse(JSON.stringify(childContext)))).toBeNull();
        expect(readProof(context)).toBeNull();
      }
      const carried = childContext.externalActionExecutionAuthorization!;
      expect(carried.token).toBe(authorization.token);
      expect(carried.binding).toBe(authorization.binding);
      expect(carried.requesterAccountExecutor).toBe(requesterAccountExecutor);
      expect(Object.getOwnPropertyDescriptor(carried, 'requesterAccountExecutor')?.enumerable).toBe(false);
      await carried.requesterHttpProjection!.createRequestHeaders(request);
      if (expectsAdmittedProof) {
        const parentRequest = { ...request, effectActionId: root.actionId };
        await carried.requesterHttpProjection!.createRequestHeaders(parentRequest);
        // Host admission reads keep the root purpose; the plugin child proof
        // describes the plugin's own calls, not the host's deployment reads.
        expect(networkRequests.pop()).toEqual(parentRequest);
        const consumer = { kind: 'action_operation', operationId: authorization.binding.requestId,
          actionId: 'acme.fixture/actions/inspect', pluginVersion: '1.0.0',
          purpose: { consumer: child.action, purpose: 'cloud-api' } };
        const reviewedChild = { actionId: consumer.actionId, role: child.role,
          inputDigest: computeActionInputApprovalDigestV1('acme.fixture/actions/inspect', child.input) };
        const credentialRequests = [
          { effectActionId: root.actionId, method: 'POST', path: PROVIDER_BROKER_OPEN_HTTP_PATH_V1,
            body: { v: 3, resourceId: 'resource', initiatorMachineId: 'machine', consumer, inputDigest: reviewedChild.inputDigest } },
          { effectActionId: root.actionId, method: 'POST', path: '/v2/teams/team/credential-resources/resource/direct-material',
            body: { resourceId: 'resource', consumer, slot: { kind: 'connected_service_purpose', purpose: consumer.purpose },
              disclosedMember: { service: { pluginId: 'acme.fixture', localId: 'cloud' }, accountId: 'provider' } } },
        ];
        for (const credentialRequest of credentialRequests) {
          await carried.requesterHttpProjection!.createRequestHeaders(credentialRequest);
          expect(networkRequests.pop()).toEqual({ ...credentialRequest, reviewedChild });
          const changed = { ...credentialRequest, body: { ...credentialRequest.body,
            consumer: { ...consumer, operationId: 'unrelated-operation' } } };
          await carried.requesterHttpProjection!.createRequestHeaders({ ...changed, reviewedChild });
          expect(networkRequests.pop()).toEqual(changed);
        }
      }
      return { ok: true as const, result: {} };
    };
    // A serialized role alone and an independently Home-bound child retain
    // their incumbent HTTP ceiling instead of borrowing the parent's.
    await invokeHostReviewedChildV1({ parent: root, context: rootContext, child, execute });
    expect(networkRequests.pop()).toEqual(request);
    const policy = { action: child.action, role: child.role, surface: 'cli' as const };
    await invokeHostReviewedChildV1({ parent: { ...root, actionId: 'another-root' }, context: rootContext,
      child, admittedReview: policy, execute });
    expect(networkRequests.pop()).toEqual(request);
    expectsAdmittedProof = true;
    await invokeHostReviewedChildV1({ parent: root, context: rootContext, child, admittedReview: policy, execute });
    expect(networkRequests.pop()).toEqual({ ...request, effectActionId: 'acme.fixture/actions/inspect',
      reviewedChild: { actionId: 'acme.fixture/actions/inspect', role: child.role,
        inputDigest: computeActionInputApprovalDigestV1('acme.fixture/actions/inspect' as ActionId, child.input) } });
    await invokeHostReviewedChildV1({ parent: root, context: rootContext, child, admittedReview: policy,
      execute: async (_input, childContext) => {
        abort.abort();
        const readProof = Reflect.get(reviewedChildIssuer, 'readHostAdmittedReviewedChildV1');
        expect(typeof readProof === 'function' ? readProof(childContext) : null).toBeNull();
        expect(await childContext.externalActionExecutionAuthorization!.requesterHttpProjection!.createRequestHeaders(request)).toBeNull();
        return { ok: true as const, result: {} };
      } });
    expect(networkRequests).toEqual([]);
    expect(authorization.requesterHttpProjection).toBe(requesterHttpProjection);
  });
});
