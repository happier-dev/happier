import { describe, expect, it, vi } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { z } from 'zod/mini';

import { RPC_ERROR_CODES } from '../rpc/index.js';
import { RpcError } from '../rpc/errors.js';
import { deriveSessionCreationTagV1 } from '../sessions/creation/sessionCreationIdentityV1.js';
import { createActionExecutor } from './actionExecutor.js';
import type { ActionExecutorDeps } from './executor/types.js';
import type { ResolvedRolesSnapshotV1 } from '../prompts/roles/rolesV1.js';
import { API_TOKEN_FULL_GRANT_V1 } from '../auth/apiTokenGrant.js';
import { DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1 } from '../account/settings/sessionAgentSpawnPolicyV1.js';
import { buildBackendTargetKeyV2 } from '../backends/targets/backendTargetRefV2.js';
import { ActionDefinitionV1Schema } from './actionDefinitionV1.js';
import { ActionsSettingsV1Schema, normalizeActionsSettingsV1 } from './actionSettings.js';
import { admitSessionSpawnNewActionInputV2, SessionSpawnNewActionInputV2Schema } from '../sessions/creation/sessionSpawnNewInputV2.js';
import { ApprovalRequestV2Schema, type ApprovalRequestV2 } from '../approvals/approvalRequestV1.js';
import { decideApprovalRequestTransition } from '../approvals/approvalRequestTransition.js';
import { createBlockingApprovalCoordinator } from './blockingApprovalCoordinator.js';
import { invokeHostReviewedChildV1, readHostAdmittedReviewedChildV1, readHostAdmittedReviewedRootV1,
  readHostReviewedChildRootV1 } from './executor/deploymentRoleChild.js';
import { projectNativeJsonValueForTransport } from '../json/strictJsonValue.js';

const canonicalInput = {
  creationKey: 'plugin-operation-7',
  executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
  directory: { kind: 'path', path: '/workspace/project' },
  organizationPlacement: { sectionId: null, tagIds: [] },
  agentTarget: {
    kind: 'agent',
    identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
  },
} as const;

const apiSpawnInput = {
  creationKey: 'api-operation-7',
  directory: { kind: 'path', path: '/workspace/project' },
  organizationPlacement: { sectionId: null, tagIds: [] },
  agentTarget: {
    kind: 'agent',
    identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
  },
} as const;

const canonicalBirthInput = admitSessionSpawnNewActionInputV2(SessionSpawnNewActionInputV2Schema.parse(canonicalInput));

const agentStartContext = {
  caller: { kind: 'session', sessionId: 'parent-session', starterDepth: 0, turnDepth: 0 },
  baseline: { machineId: 'parent-machine', directory: canonicalInput.directory.path, configuration: { agentTarget: canonicalInput.agentTarget } },
  roles: {}, ledSubtreeSessionIds: [], workDepthLimit: 4, callerPermissionCeiling: 'yolo',
} as const;

function createExternalSpawnApprovalContext(requestId: string) {
  const target = { kind: 'machine' as const, machineId: 'machine-host' };
  const credentialId = '11111111-1111-4111-8111-111111111111';
  return {
    surface: 'api' as const,
    authority: 'account_automation' as const,
    actionCaller: { kind: 'host' as const },
    serverId: 'server-host',
    actionRequestId: requestId,
    externalActionCredential: { accountId: 'account-1', principalId: 'account-1', credentialId, grant: API_TOKEN_FULL_GRANT_V1 },
    externalActionTarget: target,
    externalActionExecutionAuthorization: {
      v: 1 as const,
      token: 'opaque-authorization',
      binding: {
        serverIdentityId: 'stable-home-1',
        accountId: 'account-1',
        principalId: 'account-1',
        credentialId,
        grant: API_TOKEN_FULL_GRANT_V1,
        machineId: target.machineId,
        custodianAccountId: 'account-1',
        installationId: 'installation-1',
        actionId: 'session.spawn_new' as const,
        requestId,
        requestEnvelopeDigest: 'a'.repeat(43),
        target,
      },
    },
    signExternalActionApprovalInput: () => 'a'.repeat(86),
  };
}

describe('session.spawn_new canonical execution', () => {
  it.each([true, false])('uses native confirmation for a saved UI profile-change Ask without an Inbox request (accept=%s)', async accept => {
    const confirmations: unknown[] = [];
    const requests: unknown[] = [];
    const births: unknown[] = [];
    // Native confirmation, Session creation and Artifact persistence are system
    // boundaries; parsing, profile-control routing and dispatch remain real.
    const executor = createActionExecutor({
      presentUserActionConfirmation: async request => { confirmations.push(request); return accept; },
      sessionSpawnNew: async request => { births.push(request);
        return { type: 'pending', retryWithSameCreationKey: true, outcome: 'accepted' }; },
      approvalsCreate: async ({ request }) => { requests.push(request); return { artifactId: 'unexpected-self-approval' }; },
    }, { confirmUiDefault: true });
    const result = await executor.execute('session.spawn_new', { ...canonicalInput, approvalProfileId: null }, {
      surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
      serverId: 'server-1', runtimeAccountId: 'account-1', approvalProfileId: 'builtin:apply-safe',
      actionsSettings: normalizeActionsSettingsV1({ v: 1, actions: {
        'session.approval_profile.set': { approvalRequiredSurfaces: ['ui'] },
      }, approvalWaivedSurfaces: { 'session.spawn_new': ['ui'] } }),
    });
    expect(result).toMatchObject(accept ? { ok: true, result: { type: 'pending', outcome: 'accepted' } }
      : { ok: false, errorCode: 'approval_canceled' });
    expect(confirmations).toMatchObject([{ actionId: 'session.spawn_new', input: { approvalProfileId: null } }]);
    expect(births).toHaveLength(accept ? 1 : 0);
    expect(requests).toHaveLength(0);
  });

  it.each([true, false])('checks the create grant against the Role-stamped Agent (matching=%s)', async matching => {
    const roleAgentTarget = { kind: 'agent' as const, identity: { pluginId: 'happier.agent.claude', localId: 'claude' } };
    const sessionSpawnNew = vi.fn<ActionExecutorDeps['sessionSpawnNew']>(async () => ({
      type: 'pending', retryWithSameCreationKey: true, outcome: 'accepted',
    }));
    const context = createExternalSpawnApprovalContext('role-grant');
    const roleTargetKey = buildBackendTargetKeyV2(roleAgentTarget);
    const grant = { ...API_TOKEN_FULL_GRANT_V1, create: {
      machineId: 'machine-host', directory: 'managed' as const,
      agentTargetKey: buildBackendTargetKeyV2(matching ? roleAgentTarget : apiSpawnInput.agentTarget),
      placement: { folderId: null, tagIds: [] },
    } };
    const result = await createActionExecutor({ sessionSpawnNew }).execute('session.spawn_new', {
      ...apiSpawnInput, directory: { kind: 'managed' }, roleId: 'builder',
    }, { ...context, bypassApprovals: true,
      externalActionCredential: { ...context.externalActionCredential, grant },
      externalActionExecutionAuthorization: { ...context.externalActionExecutionAuthorization,
        binding: { ...context.externalActionExecutionAuthorization.binding, grant } },
      agentStartContext: { ...agentStartContext, caller: { kind: 'originless', runId: 'role-grant', runDepth: 0 },
        baseline: { ...agentStartContext.baseline, machineId: 'machine-host' }, roles: {
          builder: { roleId: 'builder', name: 'Builder', instructions: 'Build it', engine: { agentTargetKey: roleTargetKey },
            runsAs: { kind: 'session' }, workspaceWrites: 'allow', secondOpinion: 'off', enabled: true },
        } },
    });
    if (matching) {
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
      expect(sessionSpawnNew).toHaveBeenCalledWith(expect.objectContaining({
        admittedInput: expect.objectContaining({ agentTarget: roleAgentTarget }),
      }));
    } else {
      expect(result, JSON.stringify(result)).toMatchObject({ ok: false, errorCode: 'credential_scope_denied' });
      expect(sessionSpawnNew).not.toHaveBeenCalled();
    }
  });

  it('returns unsupported_action when this host has no Session spawn implementation', async () => {
    // The missing native host implementation is the boundary; parsing and dispatch stay real.
    const executor = createActionExecutor({} as ActionExecutorDeps);
    await expect(executor.execute('session.spawn_new', canonicalInput, {
      surface: 'cli', authority: 'present_user',
    })).resolves.toEqual({
      ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.spawn_new',
    });
  });
  const attestedContext = { externalPrincipalId: 'sales@batiplus.ch', sourceMessageId: '<lead@example.test>' };

  it.each(['exact', 'different operation', 'different caller', 'aborted'] as const)(
    'holds a Workflow Session birth in its original native operation until the real approval decision (%s)', async custody => {
    const lifetime = new AbortController();
    const coordinator = createBlockingApprovalCoordinator();
    let stored: ApprovalRequestV2 | null = null;
    let effects = 0;
    let creationTag: string | undefined;
    let waiting!: () => void;
    const waitStarted = new Promise<'waiting'>(resolve => { waiting = () => resolve('waiting'); });
    const caller = { kind: 'workflowRun' as const, runId: 'workflow-run', authorization: {
      principal: { kind: 'host' as const }, admittedPermissionCeiling: 'default' as const } };
    const operationAcceptance = { operationId: 'workflow-startup', actionId: 'session.spawn_new' as const, accept: () => {} };
    // Artifact persistence and native creation are genuine system boundaries.
    // Routing, approval transitions, live decision custody and dispatch stay real.
    const executor = createActionExecutor({
      hostActionApprovalLifetime: { operationId: 'workflow-startup', signal: lifetime.signal },
      sessionSpawnNew: async args => { effects++; creationTag = args.sessionCreationTag;
        return { type: 'pending', retryWithSameCreationKey: true, outcome: 'accepted' }; },
      approvalsCreate: async ({ request }) => { stored = ApprovalRequestV2Schema.parse(request); return { artifactId: 'workflow-startup-review' }; },
      approvalsGet: async () => stored,
      approvalsUpdate: async ({ request }) => {
        if (!stored) throw new Error('Missing startup approval');
        const transition = decideApprovalRequestTransition(stored, request);
        if (!transition.ok) return transition;
        stored = ApprovalRequestV2Schema.parse(request);
        coordinator.notifyApprovalUpdated({ artifactId: 'workflow-startup-review', request: stored });
        return { ok: true };
      },
      approvalsResolveBlockingDecision: args => coordinator.resolveBlockingDecision(args),
      approvalsWaitForDecision: async args => {
        const decision = coordinator.waitForDecision(args);
        waiting();
        const result = await decision;
        return { ...result, request: ApprovalRequestV2Schema.parse(result.request) };
      },
    });
    try {
      const pending = executor.execute('session.spawn_new', { ...canonicalInput, approvalProfileId: null }, {
        surface: 'agent', authority: 'account_automation', serverId: 'server-1', serverIdentityId: 'server-1',
        runtimeAccountId: 'account-1', actionRequestId: 'workflow-startup', signal: lifetime.signal,
        executionRunTargetMachineId: 'machine-1', executionRunWorkflowRunId: 'workflow-run', agentStartWorkDepth: 1,
        approvalProfileChange: true,
        actionCaller: caller,
        actionRequestAttributionV1: { requestRef: 'person-request', requester: { serverId: 'server-1', accountId: 'account-1' },
          persona: { serverId: 'server-1', sessionId: 'origin-session' }, origin: null },
        operationAcceptance,
        sessionAgentSpawnPolicyV1: DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1,
        agentStartContext: { ...agentStartContext, caller: { kind: 'originless', runId: 'workflow-run', runDepth: 0 },
          baseline: { machineId: 'machine-1', directory: canonicalInput.directory.path } },
        actionsSettings: normalizeActionsSettingsV1({ v: 1, approvalWaivedSurfaces: { 'session.spawn_new': ['agent'] } }),
      });
      expect(await Promise.race([waitStarted, pending])).toBe('waiting');
      expect(effects).toBe(0);
      expect(stored).toMatchObject({ status: 'open', approval: { flow: 'blocking' } });
      if (custody === 'different operation') operationAcceptance.operationId = 'another-operation';
      if (custody === 'different caller') caller.runId = 'another-workflow';
      if (custody === 'aborted') {
        lifetime.abort();
        const result = await pending;
        expect(result, JSON.stringify(result)).toMatchObject({ ok: false, errorCode: 'action_failed' });
        expect(effects).toBe(0);
        return;
      }
      expect(await executor.execute('approval.request.decide', { artifactId: 'workflow-startup-review', decision: 'approve' }, {
        surface: 'ui', authority: 'present_user', serverId: 'server-1', runtimeAccountId: 'account-1',
      })).toMatchObject({ ok: true });
      const result = await pending;
      if (custody !== 'exact') {
        expect(result, JSON.stringify(result)).toMatchObject({ ok: false, errorCode: 'approval_stale' });
        expect(effects).toBe(0);
        return;
      }
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { type: 'pending', outcome: 'accepted' } });
      expect(effects).toBe(1);
      expect(creationTag).toBe(deriveSessionCreationTagV1({
        callerCreationNamespace: JSON.stringify(['workflow', 'server-1', 'workflow-run']), creationKey: canonicalInput.creationKey,
      }));
      expect(stored).toMatchObject({ status: 'executed' });
    } finally { lifetime.abort(); coordinator.dispose(); }
  });

  it.each([
    ['template.instantiate', 'create_bot', true],
    ['deployments.prepare', 'prepare-session', false],
  ] as const)('keeps %s readiness review in its original native operation', async (rootActionId, sessionRole, withPlacement) => {
    const lifetime = new AbortController();
    const coordinator = createBlockingApprovalCoordinator();
    let stored: ApprovalRequestV2 | null = null;
    let installed = 0;
    let launched = 0;
    let readinessResult: unknown;
    let waiting!: () => void;
    const waitStarted = new Promise<'waiting'>(resolve => { waiting = () => resolve('waiting'); });
    const parent = { actionId: rootActionId, input: { serverId: 'server-1' } };
    const sessionInput = { creationKey: canonicalInput.creationKey, executionTarget: canonicalInput.executionTarget,
      directory: canonicalInput.directory, agentTarget: canonicalInput.agentTarget,
      ...(withPlacement ? { organizationPlacement: canonicalInput.organizationPlacement } : {}) };
    // Session creation is waived, but this parent has no person review.
    // Its Agent install therefore retains its own Require and native operation.
    const executor = createActionExecutor({
      hostActionApprovalLifetime: { operationId: 'workflow-startup', signal: lifetime.signal },
      sessionSpawnNew: async args => {
        if (!args.invokeAgentReadinessAction) throw new Error('Missing readiness callback');
        const result = await args.invokeAgentReadinessAction('machines.agents.install', {
          machineId: 'machine-1', agentId: 'codex', intent: 'install',
        });
        readinessResult = result;
        if (!result.ok) return { type: 'error', code: 'agent_cli_missing', agentId: 'codex', retryable: false };
        launched++;
        return { type: 'pending', retryWithSameCreationKey: true, outcome: 'accepted' };
      },
      // The Machine install RPC is the effect boundary.
      machineAgentInstallStart: async args => {
        installed++;
        expect(args.signal).toBe(lifetime.signal);
        expect(args.context?.operationAcceptance?.actionId).toBe(rootActionId);
        expect(args.context && readHostReviewedChildRootV1(args.context, 'machines.agents.install', {
          machineId: 'machine-1', agentId: 'codex', intent: 'install', consent: { vendorRecipe: true },
        })).toEqual(parent);
        return { ok: true, jobId: 'agent-install' };
      },
      approvalsCreate: async ({ request }) => { stored = ApprovalRequestV2Schema.parse(request); return { artifactId: 'nested-agent-review' }; },
      approvalsGet: async () => stored,
      isApprovalExecutionOriginCurrent: async () => true,
      approvalsUpdate: async ({ request }) => {
        if (!stored) throw new Error('Missing Agent approval');
        const transition = decideApprovalRequestTransition(stored, request);
        if (!transition.ok) return transition;
        stored = ApprovalRequestV2Schema.parse(request);
        coordinator.notifyApprovalUpdated({ artifactId: 'nested-agent-review', request: stored });
        return { ok: true };
      },
      approvalsResolveBlockingDecision: args => coordinator.resolveBlockingDecision(args),
      approvalsWaitForDecision: async args => {
        const decision = coordinator.waitForDecision(args);
        waiting();
        const result = await decision;
        return { ...result, request: ApprovalRequestV2Schema.parse(result.request) };
      },
    });
    try {
      const pending = invokeHostReviewedChildV1({ parent,
        context: {
          surface: 'agent', authority: 'account_automation', serverId: 'server-1', serverIdentityId: 'server-1',
          runtimeAccountId: 'account-1', actionRequestId: 'workflow-startup', signal: lifetime.signal,
          executionRunTargetMachineId: 'machine-1', executionRunWorkflowRunId: 'workflow-run', agentStartWorkDepth: 1,
          actionCaller: { kind: 'workflowRun', runId: 'workflow-run', authorization: {
            principal: { kind: 'host' }, admittedPermissionCeiling: 'default' } },
          actionRequestAttributionV1: { requestRef: 'person-request', requester: { serverId: 'server-1', accountId: 'account-1' },
            persona: { serverId: 'server-1', sessionId: 'origin-session' }, origin: null },
          operationAcceptance: { operationId: 'workflow-startup', actionId: rootActionId, accept: () => {} },
          sessionAgentSpawnPolicyV1: DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1,
          agentStartContext: { ...agentStartContext, caller: { kind: 'originless', runId: 'workflow-run', runDepth: 0 },
            baseline: { machineId: 'machine-1', directory: canonicalInput.directory.path } },
          actionsSettings: normalizeActionsSettingsV1({ v: 1, approvalWaivedSurfaces: { 'session.spawn_new': ['agent'] },
            actions: { 'machines.agents.install': { approvalRequiredSurfaces: ['agent'] } } }),
        },
        child: { action: 'session.spawn_new', role: sessionRole, input: projectNativeJsonValueForTransport(sessionInput) },
        execute: (input, context) => executor.execute('session.spawn_new', input, context),
      });
      expect(await Promise.race([waitStarted, pending]), JSON.stringify(readinessResult)).toBe('waiting');
      expect(installed).toBe(0);
      expect(launched).toBe(0);
      expect(stored).toMatchObject({ actionId: 'machines.agents.install', status: 'open', approval: { flow: 'blocking' } });
      expect(await executor.execute('approval.request.decide', { artifactId: 'nested-agent-review', decision: 'approve' }, {
        surface: 'ui', authority: 'present_user', serverId: 'server-1', runtimeAccountId: 'account-1',
      })).toMatchObject({ ok: true });
      const result = await pending;
      expect(readinessResult, JSON.stringify(readinessResult)).toMatchObject({ ok: true });
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { type: 'pending', outcome: 'accepted' } });
      expect(installed).toBe(1);
      expect(launched).toBe(1);
      expect(stored).toMatchObject({ status: 'executed' });
    } finally { lifetime.abort(); coordinator.dispose(); }
  });

  it('retains an Agent Template root after Session admission stamps the operation operand', async () => {
    const parent = { actionId: 'template.instantiate', input: { serverId: 'server-1' } };
    const target = { kind: 'machine' as const, machineId: 'machine-1' };
    const inherited = { v: 2 as const, bindingsByServiceId: {} };
    let inventoryRoot: unknown;
    let inventoryLeaf: unknown;
    let readinessResult: unknown;
    let operationInput: unknown;
    const executor = createActionExecutor({
      // The daemon operation lifecycle is a host boundary. Its executor callback
      // re-enters the real Action owner with the admitted operand and lifetime.
      runActionOperation: async request => {
        operationInput = request.input;
        return request.execute({ ...request.context, operationAcceptance: {
          operationId: 'template-child-operation', actionId: request.actionId, accept() {},
        } });
      },
      sessionSpawnNew: async args => {
        if (!args.invokeAgentReadinessAction) throw new Error('Missing readiness callback');
        readinessResult = await args.invokeAgentReadinessAction('machines.agents.list', {
          machineId: target.machineId, agentId: 'codex', refresh: true,
        });
        return { type: 'pending', retryWithSameCreationKey: true, outcome: 'accepted' };
      },
      // Native Machine inventory is the network effect boundary.
      machinesAgentsList: async (_input, context) => {
        inventoryRoot = readHostAdmittedReviewedRootV1(context);
        inventoryLeaf = readHostAdmittedReviewedChildV1(context);
        return { items: [] };
      },
    });
    const result = await invokeHostReviewedChildV1({ parent,
      context: {
        surface: 'agent', authority: 'account_automation', serverId: 'server-1', serverIdentityId: 'stable-home',
        runtimeAccountId: 'account-1', actionRequestId: 'agent-copy-request', defaultSessionId: 'parent-session',
        actionCaller: agentStartContext.caller,
        agentStartContext: { ...agentStartContext, baseline: { ...agentStartContext.baseline,
          machineId: target.machineId, configuration: { agentTarget: canonicalInput.agentTarget, connectedServices: inherited } } },
        callerPermissionMode: 'default',
        causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'default' },
        sessionInputSource: { sourceSessionId: 'parent-session', sourceTurnId: 'parent-turn', via: 'action' },
        sessionAgentSpawnPolicyV1: DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1,
        externalActionTarget: target,
        externalActionExecutionAuthorization: { v: 1, token: 'original-template-root', binding: {
          serverIdentityId: 'stable-home', accountId: 'account-1', custodianAccountId: 'account-1',
          authentication: { kind: 'terminal', tokenEpoch: 1 }, accountEncryptionMode: 'e2ee',
          machineId: target.machineId, installationId: 'installation-1', actionId: 'template.instantiate',
          requestId: 'agent-copy-request', requestEnvelopeDigest: 'a'.repeat(43), target,
        } },
      },
      child: { action: 'session.spawn_new', role: 'create_bot', input: projectNativeJsonValueForTransport(canonicalInput) },
      admittedReview: { action: 'session.spawn_new', role: 'create_bot', surface: 'agent' },
      execute: (input, context) => executor.execute('session.spawn_new', input, context),
    });
    expect(operationInput).toMatchObject({ connectedServices: inherited });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { type: 'pending', outcome: 'accepted' } });
    expect(readinessResult, JSON.stringify(readinessResult)).toMatchObject({ ok: true });
    expect(inventoryRoot).toEqual(parent);
    expect(inventoryLeaf).toMatchObject({ actionId: 'machines.agents.list', role: 'session_agent_inventory' });
  });

  it.each(['agent', 'mcp', 'cli'] as const)('returns repairable directory validation facts on %s', async surface => {
    const sessionSpawnNew = vi.fn<ActionExecutorDeps['sessionSpawnNew']>(async () => {
      throw new Error('Invalid input must not create a Session');
    });
    const result = await createActionExecutor({ sessionSpawnNew } as ActionExecutorDeps).execute('session.spawn_new', {
      ...canonicalInput, directory: { kind: 'local', path: '/private/submitted-path' },
    }, { surface, authority: surface === 'cli' ? 'present_user' : 'account_automation' });
    expect(result).toMatchObject({ ok: false, errorCode: 'invalid_parameters', details: { issues: [{
      code: 'invalid_union', path: ['directory', 'kind'], acceptedValues: ['path', 'managed'],
    }] } });
    expect(JSON.stringify(result)).not.toContain('/private/submitted-path');
    expect(sessionSpawnNew).not.toHaveBeenCalled();
  });

  it('keeps a Discussion-owned slot on one birth identity across caller surfaces and uncertain replies', async () => {
    // Native Session creation is the external boundary; Action parsing and birth identity stay real.
    const births: Parameters<NonNullable<ActionExecutorDeps['sessionSpawnNew']>>[0][] = [];
    const sessionSpawnNew: ActionExecutorDeps['sessionSpawnNew'] = async args => {
      births.push(args);
      return { type: 'pending', retryWithSameCreationKey: true, outcome: 'unknown' };
    };
    const executor = createActionExecutor({ sessionSpawnNew } as ActionExecutorDeps);
    const discussionParticipant = { discussionId: 'discussion-1', participantSlotId: 'reviewer-slot' };
    for (const surface of ['ui', 'cli', 'plugin', 'agent'] as const) {
      const response = await executor.execute('session.spawn_new', {
        ...canonicalInput, creationKey: `lost-response-${surface}`, discussionParticipant,
      }, { surface, authority: 'present_user', serverId: 'server-1',
        actionsSettings: normalizeActionsSettingsV1({ v: 1, approvalWaivedSurfaces: { 'session.spawn_new': [surface] } }),
        ...(surface === 'plugin' ? { actionCaller: { kind: 'plugin', pluginId: 'acme.reviewers' } as const } : {}),
        ...(surface === 'agent' ? { actionCaller: { kind: 'workflowRun' as const, runId: 'workflow-run',
          authorization: { principal: { kind: 'host' as const }, admittedPermissionCeiling: 'default' as const } },
          executionRunWorkflowRunId: 'workflow-run', agentStartWorkDepth: 1 } : {}),
      });
      expect(response).toMatchObject({ ok: true, result: { type: 'pending', outcome: 'unknown' } });
    }
    expect(births).toHaveLength(4);
    for (const [index, surface] of ['ui', 'cli', 'plugin', 'agent'].entries()) {
      expect(births[index]?.admittedInput).toEqual({ ...canonicalBirthInput,
        creationKey: `lost-response-${surface}`, discussionParticipant });
    }
    const expectedTag = births[0]?.sessionCreationTag;
    expect(expectedTag).toBeTruthy();
    for (const birth of births) {
      expect(birth).toMatchObject({ creationKey: 'reviewer-slot', sessionCreationTag: expectedTag,
        originKind: 'discussion', discussionParticipant });
      expect(birth.initialInput).toBeUndefined();
      expect(birth.originSessionId).toBeUndefined();
      expect(birth.originRunId).toBeUndefined();
      expect(birth.manager).toBeUndefined();
    }
  });

  it.each([
    { failure: new RpcError('private Machine content details', 'MACHINE_ENCRYPTION_UNAVAILABLE'), code: 'spawn_failed', retryable: false },
    { failure: new RpcError('Forbidden', RPC_ERROR_CODES.FORBIDDEN, {
      phase: 'rpc.admission.machine', errorClass: 'Error', errorCode: 'machine_unavailable', httpStatus: 403,
    }), code: 'permission_denied', retryable: false },
    { failure: new RpcError('RPC method not available', RPC_ERROR_CODES.METHOD_NOT_AVAILABLE), code: 'incompatible_target', retryable: false },
    { failure: Object.assign(new Error('Machine RPC timed out'), { code: 'MACHINE_RPC_TIMEOUT' }), code: 'spawn_failed', retryable: true },
    { failure: new Error('Target preparation failed'), code: 'spawn_failed', retryable: true },
  ])('does not claim the daemon is offline when directory preflight fails with $code', async ({ failure, code, retryable }) => {
    let spawned = false;
    const deps = {
      // The transported target read and native Session launch are system boundaries.
      sessionSpawnNewDirectoryApprovalPreflight: async () => { throw failure; },
      sessionSpawnNew: async () => { spawned = true; throw new Error('Must not launch'); },
    } satisfies Partial<ActionExecutorDeps>;
    const result = await createActionExecutor(deps as ActionExecutorDeps).execute('session.spawn_new', canonicalInput,
      { surface: 'ui', authority: 'present_user' });
    expect(result).toMatchObject({ ok: false, errorCode: code, details: { type: 'error', code, retryable } });
    if (failure instanceof RpcError && failure.failureCause) {
      expect(result).toMatchObject({ details: { failureCause: failure.failureCause } });
    }
    if (failure instanceof RpcError && failure.rpcErrorCode === 'MACHINE_ENCRYPTION_UNAVAILABLE') {
      expect(result).toMatchObject({ details: { launchError: {
        kind: 'launch_error', code: failure.rpcErrorCode, message: failure.rpcErrorCode,
      } } });
      expect(JSON.stringify(result)).not.toContain('private Machine content details');
    }
    if (code === 'incompatible_target') expect(result).toMatchObject({ details: {
      incompatibleTarget: { reason: 'target_preparation_rpc_unavailable' },
    } });
    expect(spawned).toBe(false);
  });

  it.each([false, true].flatMap(observed => [
    { observed, label: 'canonical', inherited: canonicalInput.agentTarget, expected: canonicalInput.agentTarget },
    { observed, label: 'bundled routing', inherited: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' }, expected: canonicalInput.agentTarget },
    { observed, label: 'configured ACP routing',
      inherited: { kind: 'backend', backendId: 'review-bot', configuredBackendId: 'review-bot', sourceKind: 'configured' },
      expected: { kind: 'agent', identity: { pluginId: 'happier.agent.custom-acp', localId: 'custom-acp' }, definitionId: 'review-bot' } },
    { observed, label: 'qualified plugin routing', inherited: { kind: 'backend', backendId: 'acme.agents/reviewer', sourceKind: 'built_in' },
      expected: { kind: 'agent', identity: { pluginId: 'acme.agents', localId: 'reviewer' } } },
  ] as const))('resolves inherited Machine and Agent choices before parsing an installed Session spawn ($label, observed=$observed)', async ({ observed, inherited, expected }) => {
    // Native Session creation is the process boundary; inheritance and admission stay real.
    const sessionSpawnNew = vi.fn<ActionExecutorDeps['sessionSpawnNew']>(async () => ({
      type: 'pending', retryWithSameCreationKey: true, outcome: 'accepted',
    }));
    const executor = createActionExecutor({ sessionSpawnNew,
      // Installed-plugin observation is an external notification boundary.
      ...(observed ? { observeActionExecution: async () => {} } : {}),
    } as unknown as ActionExecutorDeps);
    const result = await executor.execute('session.spawn_new', {
      creationKey: 'inherited-session-child',
      directory: { kind: 'path', path: '/workspace/project' },
      initialInput: { text: 'Reply READY, then idle.' },
    }, {
      surface: 'agent', authority: 'account_automation',
      serverId: 'server-1', runtimeAccountId: 'account-1', defaultSessionId: 'parent-session',
      actionCaller: { kind: 'session', sessionId: 'parent-session', starterDepth: 0, turnDepth: 0 },
      agentStartContext: { ...agentStartContext, baseline: { ...agentStartContext.baseline,
        configuration: { agentTarget: inherited } } }, callerPermissionMode: 'default',
      causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'default' },
      sessionInputSource: { sourceSessionId: 'parent-session', sourceTurnId: 'parent-turn-1', via: 'action' },
      sessionAgentSpawnPolicyV1: DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1,
    });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { type: 'pending', outcome: 'accepted' } });
    expect(sessionSpawnNew.mock.calls[0]?.[0]).toMatchObject({
      executionTarget: { serverId: 'server-1', machineId: 'parent-machine' },
      agentTarget: expected,
      manager: { sessionId: 'parent-session' },
    });
  });

  it.each(['omitted', 'pool', 'explicit', 'native', 'inheritedNative', 'otherAgent', 'otherMachine'] as const)(
    'resolves a Session child Connected choice at canonical admission: %s', async choice => {
    const inherited = { v: 2 as const, bindingsByServiceId: {
      'acme.auth/subscription': choice === 'pool'
        ? { source: 'connected' as const, selection: 'group' as const, groupId: 'parent-pool', profileId: 'current-member' }
        : { source: 'connected' as const, selection: 'profile' as const, profileId: 'parent-selected' },
    } };
    const explicit = { v: 2 as const, bindingsByServiceId: choice === 'native' ? {} : {
      'acme.auth/subscription': { source: 'connected' as const, selection: 'profile' as const, profileId: 'explicit-child' },
    } };
    const target = { kind: 'agent' as const, identity: { pluginId: 'acme.agents', localId: choice === 'otherAgent' ? 'other' : 'reviewer' } };
    let launched: Parameters<NonNullable<ActionExecutorDeps['sessionSpawnNew']>>[0] | undefined;
    const executor = createActionExecutor({ sessionSpawnNew: async input => {
      launched = input;
      return { type: 'pending', retryWithSameCreationKey: true, outcome: 'accepted' };
    } } satisfies Partial<ActionExecutorDeps>);
    const result = await executor.execute('session.spawn_new', { ...canonicalInput, agentTarget: target,
      ...(choice === 'explicit' || choice === 'native' ? { connectedServices: explicit } : {}),
    }, { surface: 'agent', authority: 'account_automation', serverId: 'server-1', runtimeAccountId: 'account-1',
      defaultSessionId: 'parent-session', actionCaller: agentStartContext.caller,
      agentStartContext: { ...agentStartContext, baseline: { ...agentStartContext.baseline,
        machineId: choice === 'otherMachine' ? 'other-machine' : canonicalInput.executionTarget.machineId, configuration: {
        agentTarget: { ...target, identity: { ...target.identity, localId: 'reviewer' } },
        connectedServices: choice === 'inheritedNative' ? null : inherited,
      } } }, callerPermissionMode: 'default',
      causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'default' },
      sessionInputSource: { sourceSessionId: 'parent-session', sourceTurnId: 'parent-turn-1', via: 'action' },
      sessionAgentSpawnPolicyV1: DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1 });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    expect(launched?.connectedServices).toEqual(choice === 'pool' ? { v: 2, bindingsByServiceId: {
      'acme.auth/subscription': { source: 'connected', selection: 'group', groupId: 'parent-pool' },
    } } : choice === 'inheritedNative' ? { v: 2, bindingsByServiceId: {} } : choice === 'omitted' ? inherited
      : choice === 'otherAgent' || choice === 'otherMachine' ? undefined : explicit);
  });

  it('carries attestation only for the host-stamped plugin spawn caller', async () => {
    const sessionSpawnNew = vi.fn<ActionExecutorDeps['sessionSpawnNew']>(async () => ({
      type: 'pending', retryWithSameCreationKey: true, outcome: 'accepted',
    }));
    const executor = createActionExecutor({ sessionSpawnNew } as unknown as ActionExecutorDeps);
    expect(await executor.execute('session.spawn_new', { ...canonicalInput, attestedContext }, {
      surface: 'plugin', authority: 'account_automation',
      actionCaller: { kind: 'plugin', pluginId: 'happier.channels' },
    })).toMatchObject({ ok: true });
    expect(sessionSpawnNew.mock.calls[0]?.[0]).toMatchObject({ attestedContext });
  });

  it.each(['ui', 'agent', 'mcp', 'cli', 'api', 'plugin'] as const)(
    'refuses attestation from an unstamped %s caller before spawn', async (surface) => {
      const sessionSpawnNew = vi.fn<ActionExecutorDeps['sessionSpawnNew']>();
      const executor = createActionExecutor({ sessionSpawnNew } as unknown as ActionExecutorDeps);
      // Plugin provenance is required at public ingress, before attestation admission.
      const errorCode = surface === 'plugin' ? 'plugin_action_caller_required' : 'session_attested_context_forbidden';
      expect(await executor.execute('session.spawn_new', { ...canonicalInput, attestedContext }, {
        surface, authority: 'present_user', actionCaller: { kind: 'host' },
      })).toEqual({ ok: false, errorCode, error: errorCode });
      expect(sessionSpawnNew).not.toHaveBeenCalled();
    },
  );

  it('refuses API-token attestation even with a valid spawn grant', async () => {
    const sessionSpawnNew = vi.fn<ActionExecutorDeps['sessionSpawnNew']>();
    const executor = createActionExecutor({ sessionSpawnNew } as unknown as ActionExecutorDeps);
    const result = await executor.execute('session.spawn_new', { ...canonicalInput, attestedContext }, {
      ...createExternalSpawnApprovalContext('attestation-spoof'),
    });
    expect(result).toMatchObject({ ok: false, errorCode: 'session_attested_context_forbidden' });
    expect(sessionSpawnNew).not.toHaveBeenCalled();
  });

  it.each([
    { roleId: 'orchestrator', ref: 'builtin:plan-with-a-panel', events: ['sessionStarted'], inputs: { request: 'Plan the issue with a panel before implementing it.' } },
    { roleId: 'builder', ref: 'builtin:review-and-converge', events: ['parentTurnCompleted'], inputs: {} },
  ])('admits an Agent-created $roleId with its inherited $ref trigger', async ({ roleId, ref, events, inputs }) => {
    // Native Session creation is the system boundary; Action parsing, role and Agent admission remain real.
    const sessionSpawnNew = vi.fn<ActionExecutorDeps['sessionSpawnNew']>(async () => ({
      type: 'pending', retryWithSameCreationKey: true, outcome: 'accepted',
    }));
    const executor = createActionExecutor({ sessionSpawnNew } as unknown as ActionExecutorDeps);
    const initialTriggers = [{
      target: { kind: 'workflow', ref },
      trigger: { kind: 'sessionLifecycle', enabled: true, events, policy: { kind: 'firstMatch' } },
      inputs,
      onComplete: { kind: 'originating_session' },
    }];
    const result = await executor.execute('session.spawn_new', {
      ...canonicalInput, roleId, initialTriggers,
    }, {
      surface: 'agent', authority: 'account_automation',
      serverId: 'server-1', runtimeAccountId: 'account-1', defaultSessionId: 'parent-session',
      agentStartContext: { ...agentStartContext, roles: {
        [roleId]: { roleId, name: roleId, instructions: 'Complete the brief.',
          engine: { agentTargetKey: buildBackendTargetKeyV2(canonicalInput.agentTarget) },
          runsAs: { kind: 'session' }, workspaceWrites: 'deny', secondOpinion: 'off', enabled: true },
      } }, callerPermissionMode: 'yolo',
      causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'yolo' },
      sessionInputSource: { sourceSessionId: 'parent-session', sourceTurnId: 'parent-turn-1', via: 'action' },
      sessionAgentSpawnPolicyV1: DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1,
    });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { type: 'pending', outcome: 'accepted' } });
    expect(sessionSpawnNew.mock.calls[0]?.[0]).toMatchObject({
      roleId, initialTriggers, manager: { sessionId: 'parent-session' },
    });
    expect(sessionSpawnNew.mock.calls[0]?.[0].initialTriggers?.[0]?.inputs).not.toHaveProperty('engines');
  });

  it.each([{ FEATURE_FLAG: 'enabled' }, {}])('refuses the environment policy before approval or native spawn: %j', async (environmentVariables) => {
    // Approval storage and native Session creation are genuine system boundaries.
    const approvalsCreate = vi.fn();
    const sessionSpawnNew = vi.fn();
    // Unused transport dependencies are omitted: policy rejection precedes every effect.
    const executor = createActionExecutor({ approvalsCreate, sessionSpawnNew, readActionsSettings: context => ActionsSettingsV1Schema.parse({ v: 1, actions: { 'session.spawn_new': { approvalRequiredSurfaces: [context.surface] } } }) } as unknown as ActionExecutorDeps);
    expect(await executor.execute('session.spawn_new', { ...canonicalInput, environmentVariables }, {
      surface: 'agent', defaultSessionId: 'parent-session', agentStartContext,
      callerPermissionMode: 'yolo',
      causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'yolo' },
      sessionInputSource: { sourceSessionId: 'parent-session', sourceTurnId: 'parent-turn-1', via: 'action' },
      sessionAgentSpawnPolicyV1: { ...DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1, allowEnvironmentVariables: false },
    })).toMatchObject({ ok: false, errorCode: 'policy_denied_field',
      details: { code: 'policy_denied_field', field: 'environmentVariables' } });
    expect(approvalsCreate).not.toHaveBeenCalled();
    expect(sessionSpawnNew).not.toHaveBeenCalled();
  });

  it('snapshots the host-resolved complete roles and notes without inheriting the lead role selection', async () => {
    const roles: ResolvedRolesSnapshotV1 = {
      builder: { roleId: 'builder', name: 'Builder', instructions: 'Resolved project and Account instructions',
        engine: { agentTargetKey: 'agent:codex', modelId: 'worker-model', effort: 'high' },
        runsAs: { kind: 'session' }, workspaceWrites: 'allow', secondOpinion: 'encouraged', enabled: true },
      orchestrator: { roleId: 'orchestrator', name: 'Orchestrator', instructions: 'Lead only',
        engine: { agentTargetKey: 'agent:codex' }, runsAs: { kind: 'session' },
        workspaceWrites: 'deny', secondOpinion: 'off', enabled: true },
    };
    const sessionSpawnNew = vi.fn<ActionExecutorDeps['sessionSpawnNew']>(async () => ({ type: 'pending' as const,
      retryWithSameCreationKey: true as const, outcome: 'accepted' as const }));
    const executor = createActionExecutor({ sessionSpawnNew } as unknown as ActionExecutorDeps);
    const context = {
      surface: 'plugin' as const,
      actionCaller: { kind: 'plugin' as const, pluginId: 'plugin.example', contributionLocalId: 'feature-a' },
      defaultSessionId: 'parent-session',
      agentStartContext: { ...agentStartContext, roles },
      sessionRoleConfiguration: { sessionRoles: {}, overrides: {}, notes: 'Finish the bounded worker task' },
    };

    expect((await executor.execute('session.spawn_new', { ...canonicalInput, roleId: 'builder' }, context)).ok).toBe(true);
    expect(sessionSpawnNew.mock.calls[0]?.[0]).toMatchObject({ initialSessionRolesV1: {
      roleId: 'builder', inheritedFrom: 'parent-session', overrides: {}, sessionRoles: roles,
      notes: 'Finish the bounded worker task',
    } });
    expect(sessionSpawnNew.mock.calls[0]?.[0].initialSessionRolesV1).not.toHaveProperty('memoryDocRef');
    roles.builder!.instructions = 'A later edit';
    expect(sessionSpawnNew.mock.calls[0]?.[0].initialSessionRolesV1?.sessionRoles.builder?.instructions)
      .toBe('Resolved project and Account instructions');

    expect((await executor.execute('session.spawn_new', canonicalInput, context)).ok).toBe(true);
    expect(sessionSpawnNew.mock.calls[1]?.[0].initialSessionRolesV1).not.toHaveProperty('roleId');
  });

  it('rejects a caller-supplied role snapshot before spawn dispatch', async () => {
    const sessionSpawnNew = vi.fn();
    const executor = createActionExecutor({ sessionSpawnNew } as unknown as ActionExecutorDeps);
    const result = await executor.execute('session.spawn_new', {
      ...canonicalInput, initialSessionRolesV1: { overrides: {}, sessionRoles: {}, notes: 'forged' },
    }, { surface: 'plugin', actionCaller: { kind: 'plugin', pluginId: 'plugin.example', contributionLocalId: 'feature-a' } });
    expect(result).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    expect(sessionSpawnNew).not.toHaveBeenCalled();
  });

  it('signs the exact materialized API spawn input persisted for deferred replay', async () => {
    const approvalsCreate = vi.fn(async () => ({ artifactId: 'approval-api-spawn' }));
    const signExternalActionApprovalInput = vi.fn(() => 'a'.repeat(86));
    const executor = createActionExecutor({
      approvalsCreate,
      sessionSpawnNew: vi.fn(),
      readActionsSettings: context => ActionsSettingsV1Schema.parse({ v: 1, actions: { 'session.spawn_new': { approvalRequiredSurfaces: [context.surface] } } }),
    } as unknown as ActionExecutorDeps);
    const { creationKey: _creationKey, ...input } = apiSpawnInput;
    const target = { kind: 'machine' as const, machineId: 'machine-1' };

    const result = await executor.execute('session.spawn_new', input, {
      surface: 'api',
      authority: 'account_automation',
      serverId: 'server-1',
      actionRequestId: 'spawn-request-1',
      actionCaller: { kind: 'host' },
      externalActionCredential: {
        accountId: 'account-1',
        principalId: 'account-1',
        credentialId: '11111111-1111-4111-8111-111111111111',
        grant: API_TOKEN_FULL_GRANT_V1,
      },
      externalActionTarget: target,
      externalActionExecutionAuthorization: {
        v: 1,
        token: 'opaque-authorization',
        binding: {
          serverIdentityId: 'stable-home-1',
          accountId: 'account-1',
          principalId: 'account-1',
          credentialId: '11111111-1111-4111-8111-111111111111',
          grant: API_TOKEN_FULL_GRANT_V1,
          machineId: 'machine-1',
          custodianAccountId: 'account-1',
          installationId: 'installation-1',
          actionId: 'session.spawn_new',
          requestId: 'spawn-request-1',
          requestEnvelopeDigest: 'a'.repeat(43),
          target,
        },
      },
      signExternalActionApprovalInput,
    });
    expect(result).toEqual({
      ok: true,
      result: {
        kind: 'approval_request_created',
        artifactId: 'approval-api-spawn',
        actionId: 'session.spawn_new',
      },
    });

    const persistedRequest = approvalsCreate.mock.calls[0]?.[0].request;
    expect(persistedRequest.actionArgs).toMatchObject({
      creationKey: 'action-request:spawn-request-1',
    });
    expect(signExternalActionApprovalInput).toHaveBeenCalledWith(expect.objectContaining({
      actionId: 'session.spawn_new',
      input: persistedRequest.actionArgs,
    }));
  });

  it('enforces the live Agent spawn policy before creating an approval artifact', async () => {
    const approvalsCreate = vi.fn();
    const sessionSpawnNew = vi.fn();
    const executor = createActionExecutor({
      approvalsCreate,
      sessionSpawnNew,
      resolveAgentStartContext: async () => agentStartContext,
      readActionsSettings: context => ActionsSettingsV1Schema.parse({ v: 1, actions: { 'session.spawn_new': { approvalRequiredSurfaces: [context.surface] } } }),
    } as unknown as ActionExecutorDeps);

    await expect(executor.execute('session.spawn_new', canonicalInput, {
      surface: 'agent',
      defaultSessionId: 'parent-session',
      callerPermissionMode: 'yolo',
      causalPermissionAuthority: {
        kind: 'admittedSessionInputV1',
        admittedPermissionCeiling: 'yolo',
      },
      sessionInputSource: {
        sourceSessionId: 'parent-session',
        sourceTurnId: 'parent-turn-1',
        via: 'action',
      },
      sessionAgentSpawnPolicyV1: {
        v: 1,
        allowCustomDirectory: true,
        allowCrossMachine: false,
        allowBackendTargetOverride: true,
        allowModelOverride: true,
        allowPermissionModeOverride: true,
        allowAgentModeOverride: true,
        allowConfigOptionOverrides: true,
        allowProfileOverride: true,
        allowConnectedServicesOverride: true,
        allowMcpSelectionOverride: true,
        allowTranscriptStorageOverride: true,
        permissionCeiling: null,
      },
    })).resolves.toEqual({
      ok: false,
      errorCode: 'policy_denied_field',
      error: 'policy_denied_field',
      details: { code: 'policy_denied_field', field: 'executionTarget.machineId' },
    });
    expect(approvalsCreate).not.toHaveBeenCalled();
    expect(sessionSpawnNew).not.toHaveBeenCalled();
  });

  it('persists the Agent spawn permission ceiling in the approval input', async () => {
    const approvalsCreate = vi.fn(async ({ request }: { request: Record<string, unknown> }) => ({
      artifactId: 'approval-agent-spawn',
      request,
    }));
    const executor = createActionExecutor({
      approvalsCreate,
      sessionSpawnNew: vi.fn(),
      resolveAgentStartContext: async () => agentStartContext,
      readActionsSettings: context => ActionsSettingsV1Schema.parse({ v: 1, actions: { 'session.spawn_new': { approvalRequiredSurfaces: [context.surface] } } }),
    } as unknown as ActionExecutorDeps);

    await executor.execute('session.spawn_new', { ...canonicalInput, permissionMode: 'read-only' }, {
      surface: 'agent',
      defaultSessionId: 'parent-session',
      callerPermissionMode: 'yolo',
      causalPermissionAuthority: {
        kind: 'admittedSessionInputV1',
        admittedPermissionCeiling: 'yolo',
      },
      sessionAgentSpawnPolicyV1: {
        v: 1,
        allowCustomDirectory: true,
        allowCrossMachine: true,
        allowBackendTargetOverride: true,
        allowModelOverride: true,
        allowPermissionModeOverride: true,
        allowAgentModeOverride: true,
        allowConfigOptionOverrides: true,
        allowProfileOverride: true,
        allowConnectedServicesOverride: true,
        allowMcpSelectionOverride: true,
        allowTranscriptStorageOverride: true,
        permissionCeiling: 'read-only',
      },
    });

    expect(approvalsCreate).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({
        actionArgs: expect.objectContaining({ permissionMode: 'read-only' }),
      }),
    }));
  });

  it('binds API session spawn placement only from host-stamped daemon context', async () => {
    const sessionSpawnNew = vi.fn(async () => ({
      type: 'pending' as const,
      retryWithSameCreationKey: true as const,
      outcome: 'accepted' as const,
    }));
    const executor = createActionExecutor({
      sessionSpawnNew,
    } as unknown as ActionExecutorDeps);

    await expect(executor.execute('session.spawn_new', apiSpawnInput, {
      surface: 'api',
      authority: 'present_user',
      actionCaller: { kind: 'host' },
      serverId: 'server-host',
      externalActionTarget: { kind: 'machine', machineId: 'machine-host' },
    })).resolves.toMatchObject({ ok: true });

    expect(sessionSpawnNew).toHaveBeenCalledWith(expect.objectContaining({
      executionTarget: { serverId: 'server-host', machineId: 'machine-host' },
    }));
  });

  it('rejects deterministic user Session identity without host-stamped present-user authority', async () => {
    const sessionSpawnNew = vi.fn();
    const executor = createActionExecutor({
      sessionSpawnNew,
    } as unknown as ActionExecutorDeps);

    await expect(executor.execute('session.spawn_new', apiSpawnInput, {
      surface: 'api',
      actionCaller: { kind: 'host' },
      serverId: 'server-host',
      externalActionTarget: { kind: 'machine', machineId: 'machine-host' },
    })).resolves.toEqual({
      ok: false,
      errorCode: 'invalid_parameters',
      error: 'invalid_parameters',
    });
    expect(sessionSpawnNew).not.toHaveBeenCalled();
  });

  it('derives deterministic Account-automation Session identity only from a verified API principal', async () => {
    const sessionSpawnNew = vi.fn(async () => ({
      type: 'pending' as const,
      retryWithSameCreationKey: true as const,
      outcome: 'accepted' as const,
    }));
    const executor = createActionExecutor({
      sessionSpawnNew,
    } as unknown as ActionExecutorDeps);

    await expect(executor.execute('session.spawn_new', apiSpawnInput, {
      surface: 'api',
      authority: 'account_automation',
      actionCaller: { kind: 'host' },
      serverId: 'server-host',
      externalActionTarget: { kind: 'machine', machineId: 'machine-host' },
      externalActionCredential: {
        accountId: 'account-1',
        principalId: 'principal-1',
        credentialId: 'credential-1',
        grant: API_TOKEN_FULL_GRANT_V1,
      },
    })).resolves.toMatchObject({ ok: true });

    expect(sessionSpawnNew).toHaveBeenCalledWith(expect.objectContaining({
      sessionCreationTag: deriveSessionCreationTagV1({
        callerCreationNamespace: 'api-principal:account-1:principal-1',
        creationKey: apiSpawnInput.creationKey,
      }),
    }));
  });

  it('fails deterministic Account-automation Session spawn closed without verified API principal identity', async () => {
    const sessionSpawnNew = vi.fn();
    const executor = createActionExecutor({
      sessionSpawnNew,
    } as unknown as ActionExecutorDeps);

    await expect(executor.execute('session.spawn_new', apiSpawnInput, {
      surface: 'api',
      authority: 'account_automation',
      actionCaller: { kind: 'host' },
      serverId: 'server-host',
      externalActionTarget: { kind: 'machine', machineId: 'machine-host' },
    })).resolves.toEqual({
      ok: false,
      errorCode: 'invalid_parameters',
      error: 'invalid_parameters',
    });
    await expect(executor.execute('session.spawn_new', apiSpawnInput, {
      surface: 'api',
      authority: 'account_automation',
      actionCaller: { kind: 'host' },
      serverId: 'server-host',
      externalActionTarget: { kind: 'machine', machineId: 'machine-host' },
      externalActionCredential: {
        accountId: 'account-1',
        principalId: '',
        credentialId: 'credential-1',
        grant: API_TOKEN_FULL_GRANT_V1,
      },
    })).resolves.toEqual({
      ok: false,
      errorCode: 'invalid_parameters',
      error: 'invalid_parameters',
    });
    expect(sessionSpawnNew).not.toHaveBeenCalled();
  });

  it.each(['voice', 'cli'] as const)('binds host %s creation retries to the admitted Home and Account without promoting authority', async (surface) => {
    const sessionSpawnNew = vi.fn<ActionExecutorDeps['sessionSpawnNew']>(async () => ({
      type: 'pending', retryWithSameCreationKey: true, outcome: 'accepted',
    }));
    const executor = createActionExecutor({ sessionSpawnNew } as unknown as ActionExecutorDeps);
    const context = {
      surface, authority: 'account_automation' as const,
      serverId: 'server-1', runtimeAccountId: 'account-1',
      actionRequestId: 'host-request-1',
    };
    const { creationKey: _creationKey, ...input } = canonicalInput;
    for (const scope of [context, { ...context, actionCaller: { kind: 'host' as const } },
      { ...context, runtimeAccountId: 'account-2' }, { ...context, serverId: 'server-2' }]) {
      expect(await executor.execute('session.spawn_new', input, scope)).toMatchObject({ ok: true });
    }
    const args = sessionSpawnNew.mock.calls.map(([args]) => args);
    expect(args[0]?.sessionCreationTag).toBe(deriveSessionCreationTagV1({
      callerCreationNamespace: JSON.stringify([surface, 'server-1', 'account-1']),
      creationKey: 'action-request:host-request-1',
    }));
    expect(args[1]?.sessionCreationTag).toBe(args[0]?.sessionCreationTag);
    expect(new Set(args.map((args) => args.sessionCreationTag)).size).toBe(3);
    expect(args.every((args) => args.context?.authority === 'account_automation')).toBe(true);
  });

  it.each((['voice', 'cli'] as const).flatMap((surface) => [
    { surface, serverId: 'server-1' },
    { surface, runtimeAccountId: 'account-1' },
    { surface, serverId: 'server-1', runtimeAccountId: 'account-1', authority: undefined },
  ]))('refuses host creation with incomplete admitted scope: %j', async (scope) => {
    const sessionSpawnNew = vi.fn();
    const executor = createActionExecutor({ sessionSpawnNew } as unknown as ActionExecutorDeps);
    expect(await executor.execute('session.spawn_new', canonicalInput, {
      authority: 'account_automation', actionCaller: { kind: 'host' }, ...scope,
    })).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    expect(sessionSpawnNew).not.toHaveBeenCalled();
  });

  it.each(['voice', 'cli'] as const)('retains required approval for a scoped host %s creation', async (surface) => {
    const sessionSpawnNew = vi.fn();
    const approvalsCreate = vi.fn(async () => ({ artifactId: 'voice-spawn-approval' }));
    const executor = createActionExecutor({ sessionSpawnNew, approvalsCreate, readActionsSettings: context => ActionsSettingsV1Schema.parse({ v: 1, actions: { 'session.spawn_new': { approvalRequiredSurfaces: [context.surface] } } }) } as unknown as ActionExecutorDeps);
    expect(await executor.execute('session.spawn_new', canonicalInput, {
      surface, authority: 'account_automation', actionCaller: { kind: 'host' },
      serverId: 'server-1', runtimeAccountId: 'account-1',
    })).toMatchObject({ ok: true, result: { kind: 'approval_request_created', artifactId: 'voice-spawn-approval' } });
    expect(sessionSpawnNew).not.toHaveBeenCalled();
  });

  it.each([
    ['missing target', {}],
    ['Session target', { externalActionTarget: { kind: 'session' as const, sessionId: 'session-1' } }],
  ])('rejects API session spawn with a %s before creating a Session', async (_name, targetContext) => {
    const sessionSpawnNew = vi.fn();
    const executor = createActionExecutor({
      sessionSpawnNew,
    } as unknown as ActionExecutorDeps);

    await expect(executor.execute('session.spawn_new', apiSpawnInput, {
      surface: 'api',
      authority: 'present_user',
      actionCaller: { kind: 'host' },
      serverId: 'server-host',
      ...targetContext,
    })).resolves.toEqual({
      ok: false,
      errorCode: 'invalid_parameters',
      error: 'invalid_parameters',
    });

    expect(sessionSpawnNew).not.toHaveBeenCalled();
  });

  it('persists and replays the host-bound canonical target for an API spawn approval', async () => {
    const sessionSpawnNew = vi.fn(async () => ({
      type: 'pending' as const,
      retryWithSameCreationKey: true as const,
      outcome: 'accepted' as const,
    }));
    let persistedApproval: unknown = null;
    const approvalsCreate = vi.fn(async ({ request }: Readonly<{ request: unknown }>) => {
      persistedApproval = request;
      return { artifactId: 'approval-api-spawn-1' };
    });
    const approvalsGet = vi.fn(async () => persistedApproval);
    const approvalsUpdate = vi.fn(async ({ request }: Readonly<{ request: unknown }>) => {
      persistedApproval = request;
      return { ok: true as const };
    });
    const executor = createActionExecutor({
      sessionSpawnNew,
      approvalsCreate,
      approvalsGet,
      approvalsUpdate,
      isApprovalExecutionOriginCurrent: async () => true,
      readActionsSettings: context => ActionsSettingsV1Schema.parse({ v: 1, actions: { 'session.spawn_new': { approvalRequiredSurfaces: ['api'] } } }),
    } as unknown as ActionExecutorDeps);

    await expect(executor.execute(
      'session.spawn_new',
      apiSpawnInput,
      createExternalSpawnApprovalContext('api-spawn-approval-1'),
    )).resolves.toMatchObject({
      ok: true,
      result: { kind: 'approval_request_created', artifactId: 'approval-api-spawn-1' },
    });
    expect(persistedApproval).toMatchObject({
      actionId: 'session.spawn_new',
      actionArgs: expect.objectContaining({
        executionTarget: { serverId: 'server-host', machineId: 'machine-host' },
      }),
    });

    await expect(executor.execute('approval.request.decide', {
      artifactId: 'approval-api-spawn-1',
      decision: 'approve',
    }, { surface: 'cli', authority: 'present_user' })).resolves.toMatchObject({ ok: true });
    expect(sessionSpawnNew).toHaveBeenCalledWith(expect.objectContaining({
      executionTarget: { serverId: 'server-host', machineId: 'machine-host' },
    }));
  });

  it('replays an API spawn approval when its creation identity came from the host request id', async () => {
    const sessionSpawnNew = vi.fn(async () => ({
      type: 'pending' as const,
      retryWithSameCreationKey: true as const,
      outcome: 'accepted' as const,
    }));
    let persistedApproval: Record<string, unknown> | null = null;
    const approvalsCreate = vi.fn(async ({ request }: Readonly<{ request: Record<string, unknown> }>) => {
      persistedApproval = request;
      return { artifactId: 'approval-api-request-id-spawn-1' };
    });
    const approvalsGet = vi.fn(async () => persistedApproval);
    const approvalsUpdate = vi.fn(async ({ request }: Readonly<{ request: Record<string, unknown> }>) => {
      persistedApproval = request;
      return { ok: true as const };
    });
    const executor = createActionExecutor({
      sessionSpawnNew,
      approvalsCreate,
      approvalsGet,
      approvalsUpdate,
      isApprovalExecutionOriginCurrent: async () => true,
      readActionsSettings: context => ActionsSettingsV1Schema.parse({ v: 1, actions: { 'session.spawn_new': { approvalRequiredSurfaces: ['api'] } } }),
    } as unknown as ActionExecutorDeps);
    const { creationKey: _creationKey, ...apiInputWithoutCreationKey } = apiSpawnInput;

    await expect(executor.execute(
      'session.spawn_new',
      apiInputWithoutCreationKey,
      createExternalSpawnApprovalContext('api-request-identity-7'),
    )).resolves.toMatchObject({
      ok: true,
      result: { kind: 'approval_request_created', artifactId: 'approval-api-request-id-spawn-1' },
    });

    await expect(executor.execute('approval.request.decide', {
      artifactId: 'approval-api-request-id-spawn-1',
      decision: 'approve',
    }, { surface: 'cli', authority: 'present_user' })).resolves.toMatchObject({
      ok: true,
      result: { status: 'executed', execution: { ok: true } },
    });

    expect(persistedApproval).toMatchObject({
      actionArgs: expect.objectContaining({
        creationKey: 'action-request:api-request-identity-7',
        executionTarget: { serverId: 'server-host', machineId: 'machine-host' },
      }),
      status: 'executed',
    });
    expect(sessionSpawnNew).toHaveBeenCalledWith(expect.objectContaining({
      creationKey: 'action-request:api-request-identity-7',
      executionTarget: { serverId: 'server-host', machineId: 'machine-host' },
    }));
  });

  it('replays a manually-created spawn approval with its host request identity', async () => {
    const sessionSpawnNew = vi.fn(async () => ({
      type: 'pending' as const,
      retryWithSameCreationKey: true as const,
      outcome: 'accepted' as const,
    }));
    let persistedApproval: Record<string, unknown> | null = null;
    const approvalsCreate = vi.fn(async ({ request }: Readonly<{ request: Record<string, unknown> }>) => {
      persistedApproval = request;
      return { artifactId: 'approval-manual-request-id-spawn-1' };
    });
    const approvalsGet = vi.fn(async () => persistedApproval);
    const approvalsUpdate = vi.fn(async ({ request }: Readonly<{ request: Record<string, unknown> }>) => {
      persistedApproval = request;
      return { ok: true as const };
    });
    const executor = createActionExecutor({
      sessionSpawnNew,
      approvalsCreate,
      approvalsGet,
      approvalsUpdate,
      isApprovalExecutionOriginCurrent: async () => true,
    } as unknown as ActionExecutorDeps);
    const { creationKey: _creationKey, ...inputWithoutCreationKey } = canonicalInput;

    await expect(executor.execute('approval.request.create', {
      actionId: 'session.spawn_new',
      actionArgs: inputWithoutCreationKey,
      summary: 'Create a session',
      createdBy: { surface: 'system' },
    }, {
      surface: 'cli',
      authority: 'present_user',
      actionRequestId: 'manual-request-identity-7',
    })).resolves.toMatchObject({ ok: true });

    await expect(executor.execute('approval.request.decide', {
      artifactId: 'approval-manual-request-id-spawn-1',
      decision: 'approve',
    }, { surface: 'cli', authority: 'present_user' })).resolves.toMatchObject({
      ok: true,
      result: { status: 'executed', execution: { ok: true } },
    });

    expect(persistedApproval).toMatchObject({
      actionArgs: expect.objectContaining({
        creationKey: 'action-request:manual-request-identity-7',
        executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
      }),
      status: 'executed',
    });
    expect(sessionSpawnNew).toHaveBeenCalledWith(expect.objectContaining({
      creationKey: 'action-request:manual-request-identity-7',
    }));
  });

  it('projects compact spawn input schemas and hints when API callers discover Action specs', async () => {
    const executor = createActionExecutor({
    } as unknown as ActionExecutorDeps);
    const context = {
      surface: 'api' as const,
      authority: 'account_automation' as const,
      actionCaller: { kind: 'host' as const },
    };

    const getResult = await executor.execute('action.spec.get', {
      id: 'session.spawn_new',
    }, context);
    const searchResult = await executor.execute('action.spec.search', {
      query: 'session.spawn_new',
      limit: 1,
    }, context);

    // Reused schema nodes may be local references after the trigger contract
    // reaches this catalog. Assert the advertised directory shape, not Zod's
    // choice to inline or reuse that shape.
    const discovery = z.object({ result: z.object({ actionSpec: z.object({ inputSchema: z.object({
      properties: z.object({ directory: z.record(z.string(), z.unknown()) }),
      $defs: z.optional(z.record(z.string(), z.record(z.string(), z.unknown()))),
      definitions: z.optional(z.record(z.string(), z.record(z.string(), z.unknown()))),
    }) }) }) }).parse(getResult);
    const advertisedSchema = discovery.result.actionSpec.inputSchema;
    const reference = advertisedSchema.properties.directory.$ref;
    if (typeof reference === 'string') expect(reference).toMatch(/^#\/(?:\$defs|definitions)\/[^/]+$/u);
    const directorySchema = typeof reference === 'string'
      ? reference.startsWith('#/$defs/')
        ? advertisedSchema.$defs?.[reference.slice('#/$defs/'.length)]
        : advertisedSchema.definitions?.[reference.slice('#/definitions/'.length)]
      : advertisedSchema.properties.directory;
    expect(directorySchema).toMatchObject({
      oneOf: expect.arrayContaining([
        expect.objectContaining({ type: 'object', properties: expect.objectContaining({
          kind: expect.objectContaining({ const: 'path' }),
          path: expect.objectContaining({ type: 'string', minLength: 1 }),
        }) }),
        expect.objectContaining({ type: 'object', properties: expect.objectContaining({
          kind: expect.objectContaining({ const: 'managed' }),
        }) }),
      ]),
    });

    expect(getResult, JSON.stringify(getResult)).toMatchObject({
      ok: true,
      result: {
        actionSpec: {
          kindVersion: 1,
          inputHints: {
            fields: expect.arrayContaining([
              expect.objectContaining({ path: 'directory' }),
            ]),
          },
        },
      },
    });
    if (!getResult.ok) throw new Error('Action discovery failed');
    const { actionSpec: definition } = z.object({ actionSpec: ActionDefinitionV1Schema }).parse(getResult.result);
    const projectedInput = z.object({
      properties: z.record(z.string(), z.unknown()),
      $defs: z.optional(z.record(z.string(), z.unknown())),
    }).parse(definition.inputSchema);
    const ajv = new Ajv2020({ strict: false });
    addFormats(ajv);
    // Validate this field's advertised semantics whether Zod emits it inline or by reference.
    const validate = ajv.compile({ ...directorySchema, $defs: projectedInput.$defs });
    expect(validate(apiSpawnInput.directory)).toBe(true);
    expect(validate({ kind: 'managed' })).toBe(true);
    expect(validate({ kind: 'path', path: '' })).toBe(false);
    expect(validate({ kind: 'unknown' })).toBe(false);
    // Public projection retains an optional canonical target; API admission
    // binds it to the stamped envelope rather than asking callers to select it.
    expect(definition.inputSchema).toMatchObject({
      properties: { executionTarget: expect.any(Object) },
    });
    expect(definition.inputSchema.required ?? []).not.toContain('executionTarget');
    expect(getResult).not.toMatchObject({
      result: {
        actionSpec: {
          inputHints: {
            fields: expect.arrayContaining([
              expect.objectContaining({ path: 'executionTarget.serverId' }),
            ]),
          },
        },
      },
    });
    expect(getResult).not.toMatchObject({
      result: {
        actionSpec: {
          inputHints: {
            fields: expect.arrayContaining([
              expect.objectContaining({ path: 'executionTarget.machineId' }),
            ]),
          },
        },
      },
    });
    expect(searchResult).toMatchObject({
      ok: true,
      result: {
        actionSpecs: [expect.objectContaining({
          id: 'session.spawn_new',
          inputHints: expect.objectContaining({
            fields: expect.arrayContaining([
              expect.objectContaining({ path: 'directory' }),
            ]),
          }),
        })],
      },
    });
    expect(searchResult).not.toMatchObject({
      result: {
        actionSpecs: [expect.objectContaining({
          id: 'session.spawn_new',
          inputHints: {
            fields: expect.arrayContaining([
              expect.objectContaining({ path: 'executionTarget.serverId' }),
            ]),
          },
        })],
      },
    });
    expect(searchResult).not.toMatchObject({
      result: {
        actionSpecs: [expect.objectContaining({
          id: 'session.spawn_new',
          inputHints: {
            fields: expect.arrayContaining([
              expect.objectContaining({ path: 'executionTarget.machineId' }),
            ]),
          },
        })],
      },
    });
  });

  it('host-stamps plugin creation identity and forwards only canonical intent', async () => {
    const sessionSpawnNew = vi.fn(async () => ({
      type: 'pending' as const,
      retryWithSameCreationKey: true as const,
      outcome: 'accepted' as const,
    }));
    const executor = createActionExecutor({ sessionSpawnNew } as unknown as ActionExecutorDeps);

    const context = {
      surface: 'plugin',
      actionCaller: {
        kind: 'plugin',
        pluginId: 'plugin.example',
        contributionLocalId: 'feature-a',
      },
      actionRequestId: 'attempt-1',
    } as const;
    const result = await executor.execute('session.spawn_new', canonicalInput, context);

    expect(result).toEqual({
      ok: true,
      result: {
        type: 'pending',
        retryWithSameCreationKey: true,
        outcome: 'accepted',
      },
    });
    expect(sessionSpawnNew).toHaveBeenCalledWith(expect.objectContaining({
      ...canonicalBirthInput,
      approvalProfileId: undefined,
      admittedInput: canonicalBirthInput,
      creationKey: 'plugin-operation-7',
      sessionCreationTag: deriveSessionCreationTagV1({
        callerCreationNamespace: 'plugin:plugin.example',
        creationKey: 'plugin-operation-7',
      }),
      callerSurface: 'plugin',
      context: expect.objectContaining(context),
      invokeAgentReadinessAction: expect.any(Function),
      actionCaller: {
        kind: 'plugin',
        pluginId: 'plugin.example',
        contributionLocalId: 'feature-a',
      },
      actionRequestId: 'attempt-1',
    }));
  });

  it('uses the host-stamped Automation Run namespace without exposing it in Action input', async () => {
    const sessionSpawnNew = vi.fn(async () => ({
      type: 'pending' as const,
      retryWithSameCreationKey: true as const,
      outcome: 'accepted' as const,
    }));
    const executor = createActionExecutor({ sessionSpawnNew } as unknown as ActionExecutorDeps);

    await executor.execute('session.spawn_new', {
      ...canonicalInput,
      creationKey: 'automation-run:run-42',
    }, {
      surface: 'cli',
      actionCaller: {
        kind: 'automationRun',
        automationId: 'automation-7',
        runId: 'run-42',
        cause: { kind: 'manual', invokedAt: 1 },
      },
    });

    expect(sessionSpawnNew).toHaveBeenCalledWith(expect.objectContaining({
      creationKey: 'automation-run:run-42',
      sessionCreationTag: deriveSessionCreationTagV1({
        callerCreationNamespace: 'automation:automation-7',
        creationKey: 'automation-run:run-42',
      }),
      actionCaller: {
        kind: 'automationRun',
        automationId: 'automation-7',
        runId: 'run-42',
        cause: { kind: 'manual', invokedAt: 1 },
      },
    }));
  });

  it('rejects an Automation Run caller whose V2 creation key is not that Run', async () => {
    const sessionSpawnNew = vi.fn(async () => ({
      type: 'pending' as const,
      retryWithSameCreationKey: true as const,
      outcome: 'accepted' as const,
    }));
    const executor = createActionExecutor({ sessionSpawnNew } as unknown as ActionExecutorDeps);

    const result = await executor.execute('session.spawn_new', {
      ...canonicalInput,
      creationKey: 'automation-run:other-run',
    }, {
      surface: 'cli',
      actionCaller: {
        kind: 'automationRun',
        automationId: 'automation-7',
        runId: 'run-42',
        cause: { kind: 'manual', invokedAt: 1 },
      },
    });

    expect(result).toEqual({
      ok: false,
      errorCode: 'invalid_parameters',
      error: 'invalid_parameters',
    });
    expect(sessionSpawnNew).not.toHaveBeenCalled();
  });

  it('derives a stable user creation key only from durable Action request identity', async () => {
    const sessionSpawnNew = vi.fn(async () => ({
      type: 'pending' as const,
      retryWithSameCreationKey: true as const,
      outcome: 'unknown' as const,
    }));
    const executor = createActionExecutor({ sessionSpawnNew } as unknown as ActionExecutorDeps);
    const { creationKey: _creationKey, ...withoutCreationKey } = canonicalInput;

    await executor.execute('session.spawn_new', withoutCreationKey, {
      surface: 'cli',
      authority: 'present_user',
      actionRequestId: 'request-9',
    });

    expect(sessionSpawnNew).toHaveBeenCalledWith(expect.objectContaining({
      creationKey: 'action-request:request-9',
      actionCaller: { kind: 'host' },
      sessionCreationTag: deriveSessionCreationTagV1({
        callerCreationNamespace: 'user',
        creationKey: 'action-request:request-9',
      }),
    }));
  });

  it('preserves a typed method-unavailable Session-spawn transport error', async () => {
    const sessionSpawnNew = vi.fn(async () => {
      throw new RpcError('RPC method not available', RPC_ERROR_CODES.METHOD_NOT_AVAILABLE);
    });
    const executor = createActionExecutor({ sessionSpawnNew } as unknown as ActionExecutorDeps);

    const result = await executor.execute('session.spawn_new', canonicalInput, {
      surface: 'voice',
      authority: 'present_user',
    });

    expect(result).toEqual({
      ok: false,
      errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
      error: 'RPC method not available',
      failureCause: {
        errorClass: 'RpcError', errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
        httpStatus: null, phase: 'dispatch',
      },
    });
  });

  it.each([
    { tag: '  predecessor metadata label  ' },
    { codexBackendMode: 'acp' },
  ])('rejects live legacy spawn extras before Session birth or approval: %j', async legacyExtras => {
    const sessionSpawnNew = vi.fn(async () => ({
      type: 'pending' as const,
      retryWithSameCreationKey: true as const,
      outcome: 'accepted' as const,
    }));
    const approvalsCreate = vi.fn(async () => ({ artifactId: 'must-not-create' }));
    const executor = createActionExecutor({ sessionSpawnNew, approvalsCreate,
      readActionsSettings: context => ActionsSettingsV1Schema.parse({ v: 1, actions: { 'session.spawn_new': { approvalRequiredSurfaces: [context.surface] } } }) } satisfies Partial<ActionExecutorDeps>);
    const { creationKey: _creationKey, ...inputWithoutCreationKey } = canonicalInput;

    const result = await executor.execute('session.spawn_new', {
      ...inputWithoutCreationKey,
      // `tag` is accepted only while replaying a provenance-bounded predecessor
      // approval artifact. It is never a live public Action field.
      ...legacyExtras,
    }, {
      surface: 'cli',
      authority: 'present_user',
      actionRequestId: 'legacy-request-7',
    });

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'invalid_parameters',
      error: 'invalid_parameters',
    });
    expect(sessionSpawnNew).not.toHaveBeenCalled();
    expect(approvalsCreate).not.toHaveBeenCalled();
  });

  it('reads but never replays a provenance-pinned predecessor approval', async () => {
    const sessionSpawnNew = vi.fn(async () => ({
      type: 'pending' as const,
      retryWithSameCreationKey: true as const,
      outcome: 'accepted' as const,
    }));
    const predecessorActionArgs = {
      // Pinned predecessor artifact vocabulary: remote-dev@1649b084249241dd68806d5150f498e944632442.
      tag: 'predecessor metadata label',
      agentId: 'codex',
      modelId: 'gpt-5',
      directory: '/workspace/project',
      machineId: 'machine-1',
      prompt: 'Inspect this repository.',
    } as const;
    let persistedApproval: Record<string, unknown> = {
      v: 1,
      status: 'open',
      createdAtMs: 100,
      updatedAtMs: 100,
      createdBy: { surface: 'cli' },
      requestedSurface: 'cli',
      actionId: 'session.spawn_new',
      actionArgs: predecessorActionArgs,
      summary: 'Create session',
      serverId: 'server-1',
    };
    const approvalsGet = vi.fn(async () => persistedApproval);
    const approvalsUpdate = vi.fn(async ({ request }: { request: Record<string, unknown> }) => {
      persistedApproval = request;
      return { ok: true as const };
    });
    const executor = createActionExecutor({
      sessionSpawnNew,
      approvalsGet,
      approvalsUpdate,
      isApprovalExecutionOriginCurrent: async () => true,
    } as unknown as ActionExecutorDeps);

    const decide = () => executor.execute('approval.request.decide', {
      artifactId: 'approval-remote-dev-1',
      decision: 'approve',
    }, { surface: 'cli', authority: 'present_user' });

    await expect(decide()).resolves.toMatchObject({ ok: false, effectAttempted: false, errorCode: 'approval_stale' });
    await expect(decide()).resolves.toMatchObject({ ok: false, effectAttempted: false, errorCode: 'approval_stale' });
    expect(sessionSpawnNew).not.toHaveBeenCalled();
    expect(persistedApproval).toMatchObject({ status: 'approved' });
    expect(persistedApproval.execution).toBeUndefined();
    expect(approvalsUpdate).toHaveBeenCalledTimes(1);
  });

  it('executes a live canonical Action without a legacy approval compatibility path', async () => {
    const sessionSpawnNew = vi.fn(async () => ({
      type: 'pending' as const,
      retryWithSameCreationKey: true as const,
      outcome: 'accepted' as const,
    }));
    const executor = createActionExecutor({
      sessionSpawnNew,
    } as unknown as ActionExecutorDeps);

    const result = await executor.execute('session.spawn_new', {
      ...canonicalInput,
    }, {
      surface: 'plugin',
      actionCaller: {
        kind: 'plugin',
        pluginId: 'plugin.example',
        contributionLocalId: 'feature-a',
      },
    });

    expect(result.ok).toBe(true);
  });

  it('does not expose an unsupported legacy approval artifact to Session-spawn observers', async () => {
    const sessionSpawnNew = vi.fn(async () => ({
      type: 'pending' as const,
      retryWithSameCreationKey: true as const,
      outcome: 'accepted' as const,
    }));
    const observeActionExecution = vi.fn(async () => undefined);
    const predecessorActionArgs = {
      agentId: 'codex',
      directory: '/workspace/project',
      machineId: 'machine-1',
      environmentVariables: { TOKEN: 'must-not-reach-observation' },
    } as const;
    let persistedApproval: Record<string, unknown> = {
      v: 1,
      status: 'open',
      createdAtMs: 100,
      updatedAtMs: 100,
      createdBy: { surface: 'cli' },
      requestedSurface: 'cli',
      actionId: 'session.spawn_new',
      actionArgs: predecessorActionArgs,
      summary: 'Create session',
      serverId: 'server-1',
    };
    const approvalsGet = vi.fn(async () => persistedApproval);
    const approvalsUpdate = vi.fn(async ({ request }: { request: Record<string, unknown> }) => {
      persistedApproval = request;
      return { ok: true as const };
    });
    const executor = createActionExecutor({
      sessionSpawnNew,
      approvalsGet,
      approvalsUpdate,
      observeActionExecution,
    } as unknown as ActionExecutorDeps);

    const decide = () => executor.execute('approval.request.decide', {
      artifactId: 'approval-remote-dev-env-1',
      decision: 'approve',
    }, { surface: 'cli', authority: 'present_user' });

    await expect(decide()).resolves.toMatchObject({ ok: false, effectAttempted: false, errorCode: 'approval_stale' });
    await expect(decide()).resolves.toMatchObject({ ok: false, effectAttempted: false, errorCode: 'approval_stale' });
    expect(sessionSpawnNew).not.toHaveBeenCalled();
    expect(observeActionExecution).not.toHaveBeenCalledWith(expect.objectContaining({
      actionId: 'session.spawn_new',
      input: expect.objectContaining({ environmentVariables: predecessorActionArgs.environmentVariables }),
    }));
    expect(persistedApproval).toMatchObject({ status: 'approved' });
    expect(persistedApproval.execution).toBeUndefined();
    expect(approvalsUpdate).toHaveBeenCalledTimes(1);
  });

  it.each([
    { surface: 'ui', authority: 'present_user', ask: false, waived: false },
    { surface: 'rpc', authority: 'present_user', ask: false, waived: false },
    { surface: 'ui', authority: 'present_user', ask: true, waived: false },
    { surface: 'rpc', authority: 'present_user', ask: true, waived: false },
    { surface: 'agent', authority: 'account_automation', ask: false, waived: false },
    { surface: 'agent', authority: 'account_automation', ask: false, waived: true },
  ] as const)('resolves missing-directory spawn through Action policy for $surface/$authority (Ask=$ask, waived=$waived)', async ({ surface, authority, ask, waived }) => {
    const directoryApproval = { v: 1 as const, executionTarget: canonicalInput.executionTarget,
      directory: canonicalInput.directory.path };
    const effects: Parameters<NonNullable<ActionExecutorDeps['sessionSpawnNew']>>[0][] = [];
    const requests: unknown[] = [];
    const confirmations: unknown[] = [];
    // Target inspection/spawn, native consent and the Account Artifact store are system
    // boundaries. The executor, declaration, policy and request codec stay real.
    const deps = {
      sessionSpawnNewDirectoryApprovalPreflight: async () => ({ type: 'approval_required' as const, approval: directoryApproval }),
      sessionSpawnNew: async (input) => {
        effects.push(input);
        return { type: 'pending' as const, retryWithSameCreationKey: true as const, outcome: 'accepted' as const };
      },
      approvalsCreate: async ({ request }) => { requests.push(request); return { artifactId: 'directory-policy-approval' }; },
      presentUserActionConfirmation: async request => { confirmations.push(request); return true; },
      resolveAgentStartContext: async () => agentStartContext,
    } satisfies Partial<ActionExecutorDeps>;
    const executor = createActionExecutor(deps as ActionExecutorDeps, { confirmUiDefault: true });
    const requiresApproval = surface !== 'ui' && (ask || (surface === 'agent' && !waived));
    const result = await executor.execute('session.spawn_new', canonicalInput, {
      surface, authority, actionCaller: surface === 'agent' ? agentStartContext.caller : { kind: 'host' },
      serverId: 'server-1', runtimeAccountId: 'account-1',
      ...(surface === 'agent' ? { defaultSessionId: 'parent-session' } : {}),
      actionsSettings: normalizeActionsSettingsV1({ v: 1, actions: ask ? { 'session.spawn_new': { approvalRequiredSurfaces: [surface] } } : {},
        ...(waived ? { approvalWaivedSurfaces: { 'session.spawn_new': [surface] } } : {}),
      }),
    });
    expect(result).toMatchObject(requiresApproval
      ? { ok: true, result: { kind: 'approval_request_created', actionId: 'session.spawn_new' } }
      : { ok: true, result: { type: 'pending', outcome: 'accepted' } });
    expect(effects).toHaveLength(requiresApproval ? 0 : 1);
    if (!requiresApproval) expect(effects[0]).toMatchObject({ sessionCreationDirectoryApproval: directoryApproval,
      context: { authority }, actionCaller: surface === 'agent' ? agentStartContext.caller : { kind: 'host' },
    });
    expect(requests).toHaveLength(requiresApproval ? 1 : 0);
    expect(confirmations).toHaveLength(surface === 'ui' ? 1 : 0);
  });

  // Owner decision 2026-11-12 (W7): an Agent placing a Session on one of the person's managed
  // targets asks by default; the person can waive it for that surface in Action settings.
  it.each([
    { surface: 'agent', authority: 'account_automation', placed: true, waived: false, requiresApproval: true },
    { surface: 'agent', authority: 'account_automation', placed: true, waived: true, requiresApproval: false },
    { surface: 'mcp', authority: 'account_automation', placed: true, waived: false, requiresApproval: true },
    { surface: 'agent', authority: 'account_automation', placed: false, waived: false, requiresApproval: false },
    { surface: 'ui', authority: 'present_user', placed: true, waived: false, requiresApproval: false },
  ] as const)('routes managed-target placement through Action policy for $surface (placed=$placed, waived=$waived)', async ({ surface, authority, placed, waived, requiresApproval }) => {
    const managedTargetPlacement = { managedId: 'managed-1', workspaceRoot: '/workspace/project' };
    const effects: Parameters<NonNullable<ActionExecutorDeps['sessionSpawnNew']>>[0][] = [];
    const requests: unknown[] = [];
    const confirmations: unknown[] = [];
    // Session creation, native consent and the Account Artifact store are system
    // boundaries. The executor, declaration, policy and request codec stay real.
    const deps = {
      sessionSpawnNew: async (input) => {
        effects.push(input);
        return { type: 'pending' as const, retryWithSameCreationKey: true as const, outcome: 'accepted' as const };
      },
      approvalsCreate: async ({ request }) => { requests.push(request); return { artifactId: 'placement-approval' }; },
      presentUserActionConfirmation: async request => { confirmations.push(request); return true; },
      resolveAgentStartContext: async () => agentStartContext,
    } satisfies Partial<ActionExecutorDeps>;
    const executor = createActionExecutor(deps as ActionExecutorDeps, { confirmUiDefault: true });
    const isAgent = surface === 'agent';
    const result = await executor.execute('session.spawn_new', { ...canonicalInput, ...(placed ? { managedTargetPlacement } : {}) }, {
      surface, authority, actionCaller: isAgent ? agentStartContext.caller : { kind: 'host' },
      serverId: 'server-1', runtimeAccountId: 'account-1',
      ...(isAgent ? { defaultSessionId: 'parent-session' } : {}),
      actionsSettings: normalizeActionsSettingsV1({ v: 1, actions: {},
        ...(waived ? { approvalWaivedSurfaces: { 'session.spawn_new': [surface] } } : {}),
      }),
    });
    expect(result, JSON.stringify(result)).toMatchObject(requiresApproval
      ? { ok: true, result: { kind: 'approval_request_created', actionId: 'session.spawn_new' } }
      : { ok: true, result: { type: 'pending', outcome: 'accepted' } });
    expect(effects).toHaveLength(requiresApproval ? 0 : 1);
    if (!requiresApproval && placed) expect(effects[0]).toMatchObject({ managedTargetPlacement });
    expect(requests).toHaveLength(requiresApproval ? 1 : 0);
    if (requiresApproval) expect(JSON.stringify(requests[0])).toContain('managed-1');
    // The person's own UI placement is unaffected: no added confirmation.
    expect(confirmations).toHaveLength(0);
  });

  it('retains the inherited profile and exact target-owned directory approval through Session spawn replay', async () => {
    const directoryApproval = {
      v: 1 as const,
      executionTarget: canonicalInput.executionTarget,
      directory: canonicalInput.directory.path,
    };
    const sessionSpawnNew = vi.fn(async () => ({
      type: 'pending' as const,
      retryWithSameCreationKey: true as const,
      outcome: 'accepted' as const,
    }));
    const sessionSpawnNewDirectoryApprovalPreflight = vi.fn(async () => ({
      type: 'approval_required' as const,
      approval: directoryApproval,
    }));
    let persistedApproval: Record<string, unknown> | null = null;
    const approvalsCreate = vi.fn(async ({ request }: { request: Record<string, unknown> }) => {
      persistedApproval = request;
      return { artifactId: 'approval-directory-1' };
    });
    const approvalsGet = vi.fn(async () => persistedApproval);
    const approvalsUpdate = vi.fn(async ({ request }: { request: Record<string, unknown> }) => {
      persistedApproval = request;
      return { ok: true as const };
    });
    const executor = createActionExecutor({
      sessionSpawnNew,
      sessionSpawnNewDirectoryApprovalPreflight,
      approvalsCreate,
      approvalsGet,
      approvalsUpdate,
      isApprovalExecutionOriginCurrent: async () => true,
    } as unknown as ActionExecutorDeps);

    await expect(executor.execute('session.spawn_new', canonicalInput, {
      surface: 'cli',
      authority: 'present_user',
      approvalProfileId: 'builtin:apply-safe',
    })).resolves.toEqual({
      ok: true,
      result: {
        kind: 'approval_request_created',
        artifactId: 'approval-directory-1',
        actionId: 'session.spawn_new',
        approvalProfile: { status: 'missing', requestedId: 'builtin:apply-safe' },
      },
    });

    expect(sessionSpawnNew).not.toHaveBeenCalled();
    expect(persistedApproval).toMatchObject({
      actionId: 'session.spawn_new',
      executionOriginV1: expect.objectContaining({ approvalProfileId: 'builtin:apply-safe' }),
      approval: { flow: 'deferred', result: 'required' },
      sessionCreationDirectoryApproval: directoryApproval,
    });

    await expect(executor.execute('approval.request.decide', {
      artifactId: 'approval-directory-1',
      decision: 'approve',
    }, { surface: 'cli', authority: 'present_user' })).resolves.toMatchObject({ ok: true });

    expect(sessionSpawnNewDirectoryApprovalPreflight).toHaveBeenCalledTimes(2);
    expect(sessionSpawnNew).toHaveBeenCalledWith(expect.objectContaining({
      sessionCreationDirectoryApproval: directoryApproval,
      approvalProfileId: 'builtin:apply-safe',
    }));
  });

  it('does not forward a legacy V1 directory approval to the target Action owner', async () => {
    const directoryApproval = {
      v: 1 as const,
      executionTarget: canonicalInput.executionTarget,
      directory: canonicalInput.directory.path,
    };
    const sessionSpawnNew = vi.fn(async () => {
      throw new Error('ui_must_not_forward_directory_approval_as_spawn_input');
    });
    let persistedApproval: Record<string, unknown> = {
      v: 1,
      status: 'open',
      createdAtMs: 1,
      updatedAtMs: 1,
      createdBy: { surface: 'mcp' },
      requestedSurface: 'mcp',
      actionId: 'session.spawn_new',
      actionArgs: canonicalInput,
      summary: 'Create session',
      serverId: canonicalInput.executionTarget.serverId,
      sessionCreationDirectoryApproval: directoryApproval,
    };
    const approvalsGet = vi.fn(async () => persistedApproval);
    const approvalsUpdate = vi.fn(async ({ request }: Readonly<{ request: Record<string, unknown> }>) => {
      persistedApproval = request;
      return { ok: true as const };
    });
    const executor = createActionExecutor({
      sessionSpawnNew,
      approvalsGet,
      approvalsUpdate,
    } as unknown as ActionExecutorDeps);
    const controller = new AbortController();

    const decide = () => executor.execute('approval.request.decide', {
      artifactId: 'approval-directory-target-1',
      decision: 'approve',
    }, {
      surface: 'ui',
      authority: 'present_user',
      serverId: canonicalInput.executionTarget.serverId,
      signal: controller.signal,
    });
    await expect(decide()).resolves.toMatchObject({ ok: false, effectAttempted: false, errorCode: 'approval_stale' });
    await expect(decide()).resolves.toMatchObject({ ok: false, effectAttempted: false, errorCode: 'approval_stale' });

    expect(sessionSpawnNew).not.toHaveBeenCalled();
    expect(approvalsUpdate).toHaveBeenCalledTimes(1);
    expect(persistedApproval).toMatchObject({ status: 'approved' });
    expect(persistedApproval.execution).toBeUndefined();
  });

  it('lets the canonical target-action approval owner claim a decision before generic Artifact handling', async () => {
    const targetActionApprovalReplay = vi.fn(async () => ({
      ok: true as const,
      result: { ok: true, status: 'executed' },
    }));
    const approvalsGet = vi.fn(async () => {
      throw new Error('generic_approval_store_must_not_read_target_action_artifact');
    });
    const executor = createActionExecutor({
      targetActionApprovalReplay,
      approvalsGet,
    } as unknown as ActionExecutorDeps);
    const controller = new AbortController();

    await expect(executor.execute('approval.request.decide', {
      artifactId: 'target-action-approval-1',
      decision: 'approve',
    }, {
      surface: 'ui',
      authority: 'present_user',
      signal: controller.signal,
    })).resolves.toEqual({ ok: true, result: { ok: true, status: 'executed' } });

    expect(targetActionApprovalReplay).toHaveBeenCalledExactlyOnceWith({
      artifactId: 'target-action-approval-1',
      decision: 'approve',
      signal: controller.signal,
      context: expect.objectContaining({ surface: 'ui', authority: 'present_user', signal: controller.signal }),
    });
    expect(approvalsGet).not.toHaveBeenCalled();
  });

  it('rejects creation without either caller key or durable Action request identity', async () => {
    const sessionSpawnNew = vi.fn();
    const executor = createActionExecutor({ sessionSpawnNew } as unknown as ActionExecutorDeps);
    const { creationKey: _creationKey, ...withoutCreationKey } = canonicalInput;

    const result = await executor.execute('session.spawn_new', withoutCreationKey, {
      surface: 'plugin',
      actionCaller: { kind: 'plugin', pluginId: 'plugin.example' },
    });

    expect(result).toEqual({
      ok: false,
      errorCode: 'invalid_parameters',
      error: 'invalid_parameters',
    });
    expect(sessionSpawnNew).not.toHaveBeenCalled();
  });
});
