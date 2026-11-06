import { describe, expect, it, vi } from 'vitest';
import { isDeepStrictEqual } from 'node:util';
import tweetnacl from 'tweetnacl';

import { ApprovalRequestSchema, ApprovalRequestPublicSettlementSchema, ApprovalRequestV1Schema, ApprovalRequestV2Schema, requiresExactDaemonApprovalReplay, type ApprovalRequest, type ApprovalRequestV1, type ApprovalRequestV2 } from '../approvals/approvalRequestV1.js';
import { readLiveCliApprovalOriginScope } from '../approvals/liveCliOrigin.js';
import { getActionSpec } from './actionSpecs.js';
import { ActionIdSchema } from './actionIds.js';
import { buildApprovalExecutionOriginV1, createActionExecutor, type ActionExecutorDeps, type ActionExecutorContext } from './actionExecutor.js';
import { computeExternalActionRequestEnvelopeDigestV1 } from './externalActionExecutionAuthorization.js';
import type { ExternalActionExecutionAuthorizationV1 } from './externalActionApi.js';
import { isApprovalRequiredByActionsSettings, requiresAgentEgressRedaction } from './actionApprovalPolicy.js';
import { ActionsSettingsV1Schema } from './actionSettings.js';
import { API_TOKEN_FULL_GRANT_V1 } from '../auth/apiTokenGrant.js';
import { createWorkflowTriggerActions } from './executor/workflowTriggerActions.js';
import { createWorkflowDefinitionActions } from './executor/workflowDefinitions.js';
import { createWorkflowActionExecutor } from './executor/workflowAccountActions.js';
import { AutomationDefinitionReconcileRequestSchema, type AutomationDefinitionDetail } from '../automations/automationApiV3.js';
import { serializeAutomationStoredWorkflowDefinitionRecipeV2 } from '../automations/automationWorkflowRecipeV2.js';
import { resolveWorkflowDefinitionRefV1 } from '../workflows/workflowDefinitionResolverV1.js';
import { decideApprovalRequestTransition } from '../approvals/approvalRequestTransition.js';
import { createWorkBoardArtifactBoundary } from '../boards/workBoardArtifactV1.testkit.js';
import { createWidgetDefinitionArtifactPortV1 } from '../widgets/widgetDefinitionArtifactV1.js';
import { createBlockingApprovalCoordinator } from './blockingApprovalCoordinator.js';
import { signExternalActionApprovalInputV1, verifyExternalActionApprovalInputV1 } from './externalActionExecutionAuthorization.js';
import { computeActionInputApprovalDigestV1 } from './decisionAuthority.js';

const defaultActionsSettings = ActionsSettingsV1Schema.parse({ v: 1 });
const securityTokenSummary = {
  tokenId: 'dd03e74b-4aae-4a0a-81ee-1c23ddc4525d', label: 'Requested embed', displayPrefix: 'hap_v1_dd03e74b',
  createdAt: '2026-10-01T12:00:00.000Z', lastUsedAt: null, expiresAt: null,
  hasEncryptionAccess: false, hasUnattendedTeamAccess: false,
  grant: API_TOKEN_FULL_GRANT_V1, parentTokenId: null, activeChildCount: 0, embedConfig: null,
};
const securityToken = `hap_v1_${securityTokenSummary.tokenId}_${'a'.repeat(43)}`;

describe('approval Machine origin defaults', () => {
  it.each([undefined, 'explicit-machine'] as const)('uses the admitted plugin Machine only behind explicit custody (%s)', explicitMachineId => {
    const context: ActionExecutorContext = {
      surface: 'plugin', authority: 'account_automation', serverId: 'home', serverIdentityId: 'srv_home',
      runtimeAccountId: 'account', actionRequestId: 'request',
      actionCaller: { kind: 'plugin', pluginId: 'example.observer', contributionLocalId: 'observer',
        sourceCustody: { kind: 'development', registeredRootId: 'observer-root' },
        materialization: { pluginId: 'example.observer', machineId: 'source-machine', materializationId: 'materialization' } },
      ...(explicitMachineId ? { externalActionTarget: { kind: 'machine', machineId: explicitMachineId } } : {}),
    };
    const origin = buildApprovalExecutionOriginV1({ actionId: 'automation.event.sources.list',
      input: { transport: { kind: 'checkpointedPull' } }, context, targetSessionId: null });
    expect(origin?.machineId).toBe(explicitMachineId ?? 'source-machine');
    expect(origin?.target).toEqual(context.externalActionTarget);
    expect(origin?.authority).toBe('account_automation');
    expect(context.defaultSessionMachineId).toBeUndefined();
  });
});

describe('Session public link approval narrowing', () => {
  it('admits only turning public networking off while preserving the original share operands', () => {
    const narrowing = getActionSpec('session.public_link.create').approvalNarrowing;
    const original = { sessionId: 'session', maxUses: 3, isConsentRequired: true };
    const off = { ...original, networkOff: true };
    expect(narrowing?.narrow(original, off)).toEqual(off);
    expect(narrowing?.narrow({ ...original, networkOff: true }, original)).toBeNull();
    expect(narrowing?.narrow(original, { ...off, sessionId: 'different' })).toBeNull();
    expect(narrowing?.narrow(original, { ...off, maxUses: 10 })).toBeNull();
    expect(narrowing?.narrow(original, { ...off, isConsentRequired: false })).toBeNull();
  });
});

function createApprovalRequest(
  status: ApprovalRequestV1['status'] = 'open',
  overrides: Partial<ApprovalRequestV1> = {},
): ApprovalRequest {
  const actionId = overrides.actionId ?? 'session.message.send';
  const createdBy = overrides.createdBy ?? { surface: 'mcp', sessionId: 's1' };
  const requestedSurface = overrides.requestedSurface === undefined ? 'mcp' : overrides.requestedSurface;
  const sessionId = createdBy.sessionId ?? 's1';
  const serverId = typeof overrides.serverId === 'string' ? overrides.serverId : 'server-1';
  const executionSurface = requestedSurface === 'plugin'
    ? 'plugin'
    : requestedSurface === 'agent'
      ? 'agent'
      : requestedSurface === 'cli'
        ? 'cli'
        : 'mcp';
  const base: ApprovalRequestV2 = {
    v: 2,
    status,
    createdAtMs: 1,
    updatedAtMs: 1,
    createdBy,
    executionOriginV1: {
      v: 1,
      authority: 'account_automation',
      surface: executionSurface,
      caller: { kind: 'host' },
      serverId,
      machineId: 'machine-1',
      ...(sessionId ? { sessionId, target: { kind: 'session' as const, sessionId } } : {}),
      ...(actionId === 'session.list'
        && (executionSurface === 'agent' || executionSurface === 'mcp' || executionSurface === 'plugin')
        ? { sessionListAccess: 'current_session' as const }
        : {}),
      actionId,
      requestId: 'request-1',
    },
    actionId,
    actionArgs: { sessionId: 's1', message: 'hello' },
    summary: 'Send message',
    requestedSurface,
  };

  const { serverId: _legacyServerId, v: _legacyVersion, ...safeOverrides } = overrides;

  if (status === 'approved') {
    return { ...base, ...safeOverrides, decision: { kind: 'approve', decidedAtMs: 2 } };
  }

  if (status === 'rejected') {
    return { ...base, ...safeOverrides, decision: { kind: 'reject', decidedAtMs: 2 } };
  }

  if (status === 'executed') {
    return {
      ...base,
      ...safeOverrides,
      decision: { kind: 'approve', decidedAtMs: 2 },
      execution: { executedAtMs: 3, ok: true, result: { ok: true } },
    };
  }

  if (status === 'failed') {
    return {
      ...base,
      ...safeOverrides,
      decision: { kind: 'approve', decidedAtMs: 2 },
      execution: { executedAtMs: 3, ok: false, errorCode: 'action_failed', error: 'action_failed' },
    };
  }

  return { ...base, ...safeOverrides };
}

function createExecutor(overrides: Partial<ActionExecutorDeps> = {}) {
  const executor = createActionExecutor({
    executionRunStart: async () => ({}),
    executionRunList: async () => ({}),
    executionRunGet: async () => ({}),
    detachedExecutionRunSend: async () => ({}),
    executionRunStop: async () => ({}),
    executionRunAction: async () => ({}),
    executionRunWait: async () => ({}),
    sessionOpen: async () => ({}),
    sessionFork: async () => ({}),
    sessionRollback: async () => ({}),
    sessionSpawnNew: async () => ({}),
    pathsListRecent: async () => ({ items: [] }),
    machinesList: async () => ({ items: [] }),
    serversList: async () => ({ items: [] }),
    reviewEnginesList: async () => ({ items: [] }),
    agentsBackendsList: async () => ({ items: [] }),
    agentsModelsList: async () => ({ items: [] }),
    sessionSendMessage: async () => ({ status: 'accepted' as const, localId: 'local-1' }),
    sessionPermissionRespond: async () => ({}),
    sessionUserActionAnswer: async () => ({}),
    sessionTargetPrimarySet: async () => ({}),
    sessionTargetTrackedSet: async () => ({}),
    sessionList: async () => ({}),
    sessionActivityGet: async () => ({}),
    sessionRecentMessagesGet: async () => ({}),
    daemonMemorySearch: async () => ({ v: 1, ok: true as const, hits: [] }),
    daemonMemoryGetWindow: async () => ({ v: 1, snippets: [], citations: [] }),
    daemonMemoryEnsureUpToDate: async () => ({}),
    resetGlobalVoiceAgent: async () => {},
    isApprovalExecutionOriginCurrent: async () => true,
    ...overrides,
  });
  return {
    ...executor,
    execute: (
      actionId: Parameters<typeof executor.execute>[0],
      input: Parameters<typeof executor.execute>[1],
      context: Parameters<typeof executor.execute>[2] = {
        surface: 'ui',
        authority: 'present_user',
        actionCaller: { kind: 'host' },
      },
    ) => executor.execute(actionId, input, {
      ...(actionId === 'approval.request.decide'
        ? {}
        : { serverId: 'server-1', actionRequestId: `test-request:${actionId}` }),
      // This approval harness represents a Session-bound host. Agent list
      // admission requires the same explicit corpus boundary as its runtime.
      defaultSessionId: 's1',
      defaultSessionMachineId: 'machine-1',
      sessionListAccess: 'current_session',
      ...context,
    }),
  };
}

describe('Machine reboot Action registration and dispatch', () => {
  it('dispatches the canonical exact-installation Action and rejects extra identity or another Home', async () => {
    const actionId = ActionIdSchema.safeParse('machines.reboot');
    expect(actionId.success).toBe(true);
    if (!actionId.success) throw new Error('The canonical Action catalog must declare reboot');
    const spec = getActionSpec(actionId.data);
    expect(spec.executionPlacement).toBe('machine');
    expect(spec.bindings?.rpcMethod).toBe('machines.reboot');
    expect(spec.operation?.version).toBe(1);
    const input = { serverId: 'server-1', machineId: 'machine-1', expectedInstallationId: 'installation' };
    const effects: unknown[] = [];
    const executor = createExecutor({
      // The receiving daemon is a system boundary; catalog parsing, policy,
      // and dispatch remain real. This boundary cannot reboot the test host.
      machineReboot: async request => {
        effects.push(request.input);
        return { kind: 'accepted', operation: { operationId: 'reboot-operation' }, bootedAt: 1000 };
      },
    });
    const person: ActionExecutorContext = {
      surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, serverId: input.serverId,
      presentUserConfirmation: { actionId: actionId.data },
    };
    expect(await executor.execute(actionId.data, input, person))
      .toMatchObject({ ok: true, result: { kind: 'accepted', bootedAt: 1000 } });
    expect(effects).toEqual([input]);
    expect(await executor.execute(actionId.data, { ...input, requestId: 'second-identity' }, person))
      .toMatchObject({ ok: false });
    expect(await executor.execute(actionId.data, { ...input, serverId: 'other-home' }, person))
      .toMatchObject({ ok: false, errorCode: 'server_target_mismatch' });
    expect(effects).toEqual([input]);
  });
});

describe('Machine reboot approval review', () => {
  it.each(['complete', 'partial', 'unavailable', 'paged', 'wrong-target', 'no-reader'] as const)('presents fresh %s role context before the existing person confirmation without another approval floor', async coverage => {
    const trace: string[] = [];
    const confirmations: unknown[] = [];
    const input = { serverId: 'server-1', machineId: 'machine-1', expectedInstallationId: 'installation' };
    const references = { homeId: 'stable-home', machineId: input.machineId,
      coverage: coverage === 'partial' ? 'partial' as const : 'complete' as const,
      references: [{ kind: 'deployment_environment' as const, id: 'environment', name: 'Production', deploymentRoles: ['edge' as const] }],
      nextCursor: null };
    // Home and Machine reads, the person dialog, and the reboot target are genuine
    // system boundaries; shared preparation, policy and dispatch stay real.
    const ports = {
      machineRebootReferences: coverage === 'no-reader' ? undefined : async (request: Parameters<NonNullable<ActionExecutorDeps['machineRebootReferences']>>[0]) => {
        trace.push('roles');
        expect(request.input).toEqual(input);
        expect(request.context.runtimeAccountId).toBe('account');
        if (coverage === 'unavailable') throw new Error('Home unavailable');
        if (coverage === 'wrong-target') return { ...references, machineId: 'other-machine' };
        if (coverage === 'paged' && !request.cursor) return { ...references, references: [], nextCursor: 'next' };
        return references;
      },
      machineServiceAction: async () => { trace.push('services'); return { kind: 'snapshot', services: [] }; },
      machineReboot: async () => { trace.push('effect'); return { kind: 'unavailable', reason: 'admission_unavailable' }; },
      presentUserActionConfirmation: async (request: Parameters<NonNullable<ActionExecutorDeps['presentUserActionConfirmation']>>[0]) => {
        trace.push('confirmation'); confirmations.push(request); return false;
      },
    };
    const executor = createExecutor(ports);
    const result = await executor.execute('machines.reboot', input, { surface: 'ui', authority: 'present_user',
      actionCaller: { kind: 'host' }, serverId: input.serverId, serverIdentityId: 'stable-home',
      runtimeAccountId: 'account', actionsSettings: defaultActionsSettings });
    expect(confirmations).toEqual([expect.objectContaining({ preview: expect.objectContaining({ machineRebootReview: {
      kind: 'machineReboot', ...input, deploymentReferences: coverage === 'no-reader' ? null
        : coverage === 'unavailable' || coverage === 'wrong-target' ? { ...references, coverage: 'partial', references: [] } : references,
      services: { kind: 'snapshot', services: [] },
    } }) })]);
    expect(trace).toContain('services');
    if (coverage !== 'no-reader') expect(trace).toContain('roles');
    expect(trace.at(-1)).toBe('confirmation');
    expect(trace).not.toContain('effect');
    expect(result).toMatchObject({ ok: false, errorCode: 'approval_canceled' });
  });
});

function sharedRequesterContext(actionId: ApprovalRequest['actionId'], input: unknown): ActionExecutorContext {
  const key = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(39));
  const caller = { kind: 'session' as const, sessionId: 's1', starterDepth: 0, turnDepth: 0 };
  const target = { kind: 'session' as const, sessionId: 's1' };
  const causalPermissionAuthority = { kind: 'admittedSessionInputV1' as const, admittedPermissionCeiling: 'yolo' as const };
  const authorization: ExternalActionExecutionAuthorizationV1 = { v: 1, token: 'home-admitted-source', binding: {
    serverIdentityId: 'stable-home', accountId: 'alice', custodianAccountId: 'alice',
    machineId: 'machine-1', installationId: 'installation', actionId, requestId: 'action-1', target,
    authentication: { kind: 'account', tokenEpoch: 0 },
    requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1({ v: 1, requestId: 'action-1', target, input }),
    sessionActionOrigin: { v: 1, caller, sourceTurnId: 'turn-1', callerPermissionMode: 'yolo', requestId: 'action-1', causalPermissionAuthority },
    sessionActionSource: { machineId: 'machine-1', installationId: 'installation' },
  } };
  return { surface: 'agent', authority: 'account_automation', runtimeAccountId: 'alice',
    defaultSessionId: 's1', serverId: 'server-1', serverIdentityId: 'stable-home', actionRequestId: 'action-1',
    actionCaller: caller, callerPermissionMode: 'yolo', causalPermissionAuthority,
    sessionInputSource: { sourceSessionId: 's1', sourceTurnId: 'turn-1', via: 'action' },
    externalActionExecutionAuthorization: authorization, externalActionTarget: target,
    signExternalActionApprovalInput: args => signExternalActionApprovalInputV1({ authorizationToken: args.authorization.token,
      actionId: args.actionId, target: args.target, input: args.input, privateKey: key.secretKey,
      requesterConfirmation: args.requesterConfirmation, sessionTargetsV1: args.sessionTargetsV1 }),
    actionRequestAttributionV1: { requestRef: 'bob-input', requester: { serverId: 'server-1', accountId: 'bob' },
      persona: { serverId: 'server-1', sessionId: 's1' }, origin: null },
    actionsSettings: ActionsSettingsV1Schema.parse({ v: 1 }),
  };
}

function sharedRequesterCurrentUiContext(input: unknown): ActionExecutorContext {
  const context = sharedRequesterContext('ui.current_context.command.invoke', input);
  const authorization = context.externalActionExecutionAuthorization;
  const sign = context.signExternalActionApprovalInput;
  if (!authorization || !sign) throw new Error('Expected admitted Session authorization');
  return {
    ...context,
    // The Session authorization remains bound to its source Session while the
    // client dispatcher targets the machine that currently owns the UI frame.
    externalActionTarget: { kind: 'machine', machineId: 'machine-1' },
    signExternalActionApprovalInput: args => {
      if (!isDeepStrictEqual(args.target, authorization.binding.target)) {
        throw new Error('approval_origin_unavailable');
      }
      return sign(args);
    },
  };
}

describe('createActionExecutor (approvals)', () => {
  it.each(['open', 'approved'] as const)('refuses a retained personless Workflow %s card before decision or replay effects', async status => {
    let effects = 0;
    let writes = 0;
    const stored = ApprovalRequestV2Schema.parse({ v: 2, status, createdAtMs: 1, updatedAtMs: 2,
      createdBy: { surface: 'agent' }, requestedSurface: 'agent', actionId: 'discussion.post', summary: 'Retained Workflow post',
      actionArgs: { discussionId: 'discussion', localId: 'retained-post',
        content: { v: 1, parts: [{ t: 'text', text: 'Retained output' }] } },
      ...(status === 'approved' ? { decision: { kind: 'approve', authority: 'present_user', decidedAtMs: 2 } } : {}),
      executionOriginV1: { v: 1, authority: 'account_automation', surface: 'agent', serverId: 'server-1',
        accountId: 'alice', machineId: 'machine-1', actionId: 'discussion.post', requestId: 'retained-invocation',
        caller: { kind: 'workflowRun', runId: 'retained-personless', authorization: {
          principal: { kind: 'host' }, admittedPermissionCeiling: 'default',
        } } },
    });
    const executor = createExecutor({ approvalsGet: async () => stored,
      approvalsUpdate: async () => { writes++; return { ok: true }; },
      discussionAction: async () => { effects++; throw new Error('A personless card cannot execute'); },
    });
    const result = status === 'approved'
      ? await executor.replayApprovedApprovalRequest({ artifactId: 'retained-card', callerAuthority: 'present_user',
        currentAccount: { accountId: 'alice', serverId: 'server-1', serverIdentityId: 'server-1' } })
      : await executor.execute('approval.request.decide', { artifactId: 'retained-card', decision: 'approve' },
        { surface: 'ui', authority: 'present_user', serverId: 'server-1', runtimeAccountId: 'alice' });
    expect(result).toMatchObject({ ok: false, errorCode: 'approval_requester_unavailable' });
    expect(effects).toBe(0); expect(writes).toBe(0);
  });

  it.each(['starter', 'missing', 'foreign-account', 'foreign-home'] as const)(
    'binds Sessionless Workflow approval to its authenticated Account starter (%s)', async kind => {
      let stored: ApprovalRequest | null = null;
      let effects = 0;
      let cards = 0;
      const executor = createExecutor({
        approvalsCreate: async ({ request }) => { cards++; stored = ApprovalRequestSchema.parse(request); return { artifactId: 'starter-approval' }; },
        approvalsGet: async () => stored,
        approvalsUpdate: async ({ request }) => { stored = ApprovalRequestSchema.parse(request); return { ok: true }; },
        discussionAction: async () => { effects++; return { v: 1, serverId: 'server-1', messageSeq: 1, message: {
          id: 'published', discussionId: 'discussion', localId: 'workflow-post', seq: 1, authorAccountId: null,
          accountActor: null, producerV1: null, content: { v: 1, parts: [{ t: 'text', text: 'Workflow output' }] },
          mentionedAccountIds: [], createdAt: 1,
          messageRef: { kind: 'discussion', discussion: { serverId: 'server-1', discussionId: 'discussion' }, messageId: 'published' },
        } }; },
      });
      const starter = { requestRef: 'authenticated-start', requester: {
        serverId: kind === 'foreign-home' ? 'other-home' : 'server-1',
        accountId: kind === 'foreign-account' ? 'bob' : 'alice',
      } };
      const caller = { kind: 'workflowRun' as const, runId: 'workflow-person', authorization: {
        principal: { kind: 'host' as const }, admittedPermissionCeiling: 'default' as const,
      }, ...(kind === 'missing' ? {} : { authenticatedStarterV1: starter }) };
      const input = getActionSpec('discussion.post').inputSchema.parse({ discussionId: 'discussion', localId: 'workflow-post',
        content: { v: 1, parts: [{ t: 'text', text: 'Workflow output' }] }, mentionedSessionIds: [] });
      const result = await executor.execute('discussion.post', input, { surface: 'agent', authority: 'account_automation',
        runtimeAccountId: 'alice', serverId: 'server-1', defaultSessionId: undefined, sessionListAccess: undefined, actionCaller: caller });
      if (kind !== 'starter') {
        expect(result).toMatchObject({ ok: false, errorCode: 'approval_requester_unavailable' });
        expect(cards).toBe(0); expect(effects).toBe(0); return;
      }
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { kind: 'approval_request_created', artifactId: 'starter-approval' } });
      expect(stored).toMatchObject({ executionOriginV1: { caller: { authenticatedStarterV1: starter } } });
      expect(cards).toBe(1); expect(effects).toBe(0);
      const decide = (accountId: string) => executor.execute('approval.request.decide', { artifactId: 'starter-approval', decision: 'approve' },
        { surface: 'ui', authority: 'present_user', serverId: 'server-1', runtimeAccountId: accountId });
      expect(await decide('bob')).toMatchObject({ ok: false, errorCode: 'present_user_required' });
      expect(effects).toBe(0);
      expect(await decide('alice')).toMatchObject({ ok: true });
      expect(await decide('alice')).toMatchObject({ ok: true });
      expect(effects).toBe(1);
    });

  it.each(['policy', 'explicit'] as const)('refuses a detached Workflow danger approval without inventing a Session (%s)', async path => {
    let cards = 0;
    let effects = 0;
    const executor = createExecutor({
      approvalsCreate: async () => { cards++; return { artifactId: 'must-not-create' }; },
      executionRunPermissionRespond: async () => { effects++; return { ok: true }; },
    });
    const context: ActionExecutorContext = { surface: 'agent', authority: 'account_automation',
      runtimeAccountId: 'alice', serverId: 'server-1', executionRunWorkflowRunId: 'workflow-1',
      defaultSessionId: undefined, sessionListAccess: undefined, actionCaller: { kind: 'plugin', pluginId: 'example.workflow-agent',
        contributionLocalId: 'agent', occurrenceId: 'agent-occurrence',
        sourceCustody: { kind: 'development', registeredRootId: 'agent-root' } } };
    const input = { runId: 'native-run', requestId: 'permission-1', approved: true };
    const result = path === 'policy'
      ? await executor.execute('execution.run.permission.respond', input, context)
      : await executor.execute('approval.request.create', { actionId: 'execution.run.permission.respond',
        actionArgs: input, summary: 'Approve native permission', createdBy: { surface: 'agent' } }, context);
    expect(result).toMatchObject({ ok: false, errorCode: 'approval_requester_unavailable' });
    expect(cards).toBe(0);
    expect(effects).toBe(0);
  });

  it.each(['direct', 'nested', 'explicit'] as const)('refuses a personless Workflow danger Action before artifacts or effects (%s)', async path => {
    let cards = 0;
    let appends = 0;
    const workflowRunId = '41414141-4141-4141-8141-414141414164';
    const workflowCaller = { kind: 'workflowRun' as const, runId: workflowRunId, authorization: {
      principal: { kind: 'host' as const }, admittedPermissionCeiling: 'default' as const,
    } };
    const executor = createExecutor({
      approvalsCreate: async () => { cards++; return { artifactId: 'must-not-create' }; },
      discussionAction: async () => { appends++; return {}; },
    });
    const caller = path !== 'nested' ? workflowCaller : { kind: 'plugin' as const, pluginId: 'example.workflow-action',
      contributionLocalId: 'action', occurrenceId: 'workflow-action-occurrence',
      sourceCustody: { kind: 'development' as const, registeredRootId: 'workflow-action-root' }, initiatingCaller: workflowCaller };
    const input = getActionSpec('discussion.post').inputSchema.parse({
      discussionId: '41414141-4141-4141-8141-414141414165', localId: '41414141-4141-4141-8141-414141414166',
      content: { v: 1, parts: [{ t: 'text', text: 'Workflow output' }] }, mentionedSessionIds: [],
    });
    const context: ActionExecutorContext = { surface: 'agent', authority: 'account_automation',
      runtimeAccountId: 'alice', serverId: 'server-1', executionRunWorkflowRunId: workflowRunId,
      defaultSessionId: 'trigger-origin', actionCaller: caller };
    const result = path === 'explicit'
      ? await executor.execute('approval.request.create', { actionId: 'discussion.post', actionArgs: input,
        summary: 'Publish Workflow output', createdBy: { surface: 'agent' } }, context)
      : await executor.execute('discussion.post', input, context);
    expect(result, JSON.stringify(result)).toMatchObject({ ok: false, errorCode: 'approval_requester_unavailable' });
    expect(cards).toBe(0);
    expect(appends).toBe(0);
  });

  it.each(['policy', 'explicit'] as const)('refuses Workflow requester consent without a signed binding (%s)', async path => {
    const requests: ApprovalRequest[] = [];
    const appends: unknown[] = [];
    const executor = createExecutor({ approvalsCreate: async ({ request }) => {
      requests.push(request); return { artifactId: 'must-not-create' };
    }, discussionAction: async request => { appends.push(request); return {}; } });
    const input = getActionSpec('discussion.post').inputSchema.parse({
      discussionId: 'discussion', localId: 'workflow-post', content: { v: 1, parts: [{ t: 'text', text: 'Workflow output' }] },
      mentionedSessionIds: [],
    });
    const context: ActionExecutorContext = { surface: 'agent', authority: 'account_automation',
      runtimeAccountId: 'alice', serverId: 'server-1', defaultSessionId: 's1',
      actionCaller: { kind: 'workflowRun', runId: 'workflow-person', authorization: {
        principal: { kind: 'host' }, admittedPermissionCeiling: 'default',
      } }, actionRequestAttributionV1: { requestRef: 'person-input', requester: { serverId: 'server-1', accountId: 'bob' },
        persona: { serverId: 'server-1', sessionId: 's1' }, origin: null },
    };
    const result = path === 'policy' ? await executor.execute('discussion.post', input, context)
      : await executor.execute('approval.request.create', { actionId: 'discussion.post', actionArgs: input,
        summary: 'Publish Workflow output', createdBy: { surface: 'agent' } }, context);
    expect(result).toMatchObject({ ok: false, errorCode: 'approval_requester_unavailable' });
    expect(requests).toEqual([]);
    expect(appends).toEqual([]);
  });

  it('keeps an attributed person-started Workflow danger approval available', async () => {
    const requests: ApprovalRequest[] = [];
    const executor = createExecutor({ approvalsCreate: async ({ request }) => {
      requests.push(ApprovalRequestSchema.parse(request)); return { artifactId: 'person-workflow-approval' };
    } });
    const input = getActionSpec('discussion.post').inputSchema.parse({
      discussionId: '41414141-4141-4141-8141-414141414165', localId: '41414141-4141-4141-8141-414141414166',
      content: { v: 1, parts: [{ t: 'text', text: 'Workflow output' }] }, mentionedSessionIds: [],
    });
    expect(await executor.execute('discussion.post', input, {
      surface: 'agent', authority: 'account_automation', runtimeAccountId: 'alice', serverId: 'server-1',
      actionCaller: { kind: 'workflowRun', runId: 'workflow-person', authorization: {
        principal: { kind: 'host' }, admittedPermissionCeiling: 'default',
      } }, actionRequestAttributionV1: { requestRef: 'person-input', requester: { serverId: 'server-1', accountId: 'alice' },
        persona: { serverId: 'server-1', sessionId: 's1' }, origin: null },
    })).toMatchObject({ ok: true, result: { kind: 'approval_request_created', artifactId: 'person-workflow-approval' } });
    expect(requests).toHaveLength(1);
  });

  it.each(['approve', 'reject', 'cancel'] as const)('refuses subjectless requester-only %s on attribution-absent V1 history', async decision => {
    const row = ApprovalRequestV1Schema.parse({ v: 1, status: 'open', createdAtMs: 1, updatedAtMs: 1,
      createdBy: { surface: 'mcp', sessionId: 's1' }, requestedSurface: 'mcp', actionId: 'session.message.send',
      actionArgs: { sessionId: 's1', message: 'hello' }, summary: 'Send message' });
    const transitions: ApprovalRequest[] = [];
    const executor = createExecutor({ approvalsGet: async () => row,
      approvalsUpdate: async ({ request }) => { transitions.push(request); return { ok: true }; } });
    expect(await executor.execute('approval.request.decide', { artifactId: 'legacy', decision }, {
      surface: 'rpc', authority: 'present_user', runtimeAccountId: 'alice', requesterApprovalDecision: { sessionId: 's1',
        actor: { kind: 'accountUser', accountId: 'bob', relationship: 'sharedApprover' }, isCurrent: async () => true },
    })).toMatchObject({ ok: false, errorCode: 'approval_requester_unavailable' });
    expect(transitions).toEqual([]);
  });

  it.each(['approve', 'reject', 'cancel'] as const)('refuses subjectless requester-only %s on Alice ordinary Run approval', async decision => {
    const actionId = 'execution.run.permission.respond';
    const input = { runId: 'alice-run', requestId: 'alice-permission', approved: true };
    const source = sharedRequesterContext(actionId, input);
    const ownerSource = { ...source, actionRequestAttributionV1: { ...source.actionRequestAttributionV1!,
      requestRef: 'alice-input', requester: { serverId: 'server-1', accountId: 'alice' } } };
    let row: ApprovalRequestV2 | null = null;
    const effects: ActionExecutorContext[] = [];
    const executor = createExecutor({
      approvalsCreate: async ({ request }) => { row = ApprovalRequestV2Schema.parse(request); return { artifactId: 'alice-own-run' }; },
      approvalsGet: async () => row,
      approvalsUpdate: async ({ request }) => {
        if (!row) throw new Error('Missing approval');
        const transition = decideApprovalRequestTransition(row, request);
        if (!transition.ok) return transition;
        row = ApprovalRequestV2Schema.parse(request);
        return { ok: true };
      },
      executionRunPermissionRespond: async (_input, context) => { effects.push(context); return { ok: true }; },
    });
    expect(await executor.execute(actionId, input, ownerSource))
      .toMatchObject({ ok: true, result: { kind: 'approval_request_created', artifactId: 'alice-own-run' } });
    expect(row).not.toHaveProperty('requesterConfirmation');
    expect(await executor.execute('approval.request.decide', { artifactId: 'alice-own-run', decision }, {
      surface: 'rpc', authority: 'present_user', runtimeAccountId: 'alice', requesterApprovalDecision: { sessionId: 's1',
        actor: { kind: 'accountUser', accountId: 'bob', relationship: 'sharedApprover' }, isCurrent: async () => true },
    })).toMatchObject({ ok: false, errorCode: 'approval_requester_unavailable' });
    expect(row).toMatchObject({ status: 'open' });
    expect(effects).toEqual([]);
    // Alice's own Account-person proof remains sufficient for the same row.
    expect(await executor.execute('approval.request.decide', { artifactId: 'alice-own-run', decision }, {
      surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, runtimeAccountId: 'alice',
      serverId: 'server-1', serverIdentityId: 'stable-home',
    })).toMatchObject({ ok: true, result: { status: decision === 'approve' ? 'executed' : decision === 'reject' ? 'rejected' : 'canceled' } });
    expect(effects).toHaveLength(decision === 'approve' ? 1 : 0);
  });

  it.each(['owner', 'requester', 'recovery', 'shared-owner', 'shared-recovery'] as const)('refuses subjectless retained unknown/shared V2 (%s)', async route => {
    const recovery = route.endsWith('recovery');
    const actionId = route === 'requester' ? 'execution.run.permission.respond' : 'session.message.send';
    const input = route === 'requester' ? { runId: 'alice-run', requestId: 'alice-permission', approved: true }
      : { sessionId: 's1', message: 'hello' };
    const source = sharedRequesterContext(actionId, input);
    const context = { ...source, actionRequestAttributionV1: { ...source.actionRequestAttributionV1!,
      requester: route.startsWith('shared-') ? source.actionRequestAttributionV1!.requester : null } };
    const origin = buildApprovalExecutionOriginV1({ actionId, input, context, targetSessionId: 's1' });
    if (!origin?.externalActionExecutionAuthorization || !origin.target || !origin.externalActionInputSignature) {
      throw new Error('Missing signed historical origin');
    }
    expect(verifyExternalActionApprovalInputV1({ authorizationToken: origin.externalActionExecutionAuthorization.token,
      actionId, target: origin.target, input, signature: origin.externalActionInputSignature,
      publicKey: tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(39)).publicKey })).toBe(true);
    let row = ApprovalRequestV2Schema.parse({ ...createApprovalRequest(recovery ? 'approved' : 'open'),
      actionId, requestedSurface: 'agent', actionArgs: input, executionOriginV1: origin });
    const effects: ActionExecutorContext[] = [];
    const executor = createExecutor({ approvalsGet: async () => row, approvalsUpdate: async ({ request }) => {
      const transition = decideApprovalRequestTransition(row, request);
      if (!transition.ok) return transition;
      row = ApprovalRequestV2Schema.parse(request);
      return { ok: true };
    }, sessionSendMessage: async ({ context }) => { effects.push(context); return { status: 'accepted', localId: 'retained-unknown' }; },
    executionRunPermissionRespond: async (_input, context) => { effects.push(context); return { ok: true }; } });
    const decisionContext: ActionExecutorContext = { surface: route === 'requester' ? 'rpc' : 'ui', authority: 'present_user',
      actionCaller: { kind: 'host' }, serverId: 'server-1', serverIdentityId: 'stable-home', runtimeAccountId: 'alice',
      ...(route === 'requester' ? { requesterApprovalDecision: { sessionId: 's1',
        actor: { kind: 'accountUser', accountId: 'bob', relationship: 'sharedApprover' }, isCurrent: async () => true } } : {}) };
    const result = recovery
      ? await executor.replayApprovedApprovalRequest({ artifactId: 'retained-unknown', callerAuthority: 'present_user',
        currentAccount: { accountId: 'alice', serverId: 'server-1', serverIdentityId: 'stable-home' } })
      : await executor.execute('approval.request.decide', { artifactId: 'retained-unknown', decision: 'approve' }, decisionContext);
    expect(result).toMatchObject({ ok: false, errorCode: 'approval_requester_unavailable' });
    expect(effects).toEqual([]);
    expect(row.status).toBe(recovery ? 'approved' : 'open');
    // Refusing new execution must not erase a settled historical receipt.
    row = ApprovalRequestV2Schema.parse({ ...row, ...createApprovalRequest('executed'),
      actionId, requestedSurface: 'agent', actionArgs: input, executionOriginV1: origin });
    expect(await executor.replayApprovedApprovalRequest({ artifactId: 'retained-unknown', callerAuthority: 'present_user',
      currentAccount: { accountId: 'alice', serverId: 'server-1', serverIdentityId: 'stable-home' } }))
      .toMatchObject({ ok: true, result: { status: 'executed', execution: { ok: true } } });
    expect(effects).toEqual([]);
  });

  it.each(['policy', 'explicit'] as const)('refuses unknown requester %s consent without falling back to the Bot owner', async route => {
    const requests: ApprovalRequest[] = [];
    const effects: ActionExecutorContext[] = [];
    const executor = createExecutor({
      approvalsCreate: async ({ request }) => { requests[0] = ApprovalRequestV2Schema.parse(request); return { artifactId: 'unknown-requester' }; },
      approvalsGet: async () => requests[0] ?? null,
      approvalsUpdate: async ({ request }) => { requests[0] = ApprovalRequestV2Schema.parse(request); return { ok: true }; },
      sessionSendMessage: async ({ context }) => { effects.push(context); return { status: 'accepted', localId: 'unknown-input' }; },
    });
    const input = { sessionId: 's1', message: 'hello' };
    const source = sharedRequesterContext('session.message.send', input);
    const context = { ...source, actionRequestAttributionV1: { ...source.actionRequestAttributionV1!, requester: null } };
    const created = route === 'policy'
      ? await executor.execute('session.message.send', input, context)
      : await executor.execute('approval.request.create', { actionId: 'session.message.send', actionArgs: input,
        summary: 'Send message', createdBy: { surface: 'agent' } }, context);
    expect(created, JSON.stringify(created)).toMatchObject({ ok: false, errorCode: 'approval_requester_unavailable' });
    expect(requests).toEqual([]);
    expect(effects).toEqual([]);
    expect(await executor.execute('session.message.send', input, { ...context,
      actionsSettings: ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: { 'session.message.send': ['agent'] } }) }))
      .toMatchObject({ ok: true });
    expect(requests).toEqual([]);
    expect(effects).toHaveLength(1);
  });

  it('accepts the delegated Voice decision for an existing public-link request without a second tap', async () => {
    const actionId = 'artifact.public_link.create';
    let row = createApprovalRequest('open', { actionId,
      actionArgs: getActionSpec(actionId).inputSchema.parse({ artifactId: '11111111-1111-4111-8111-111111111111' }) });
    const transitions: ApprovalRequest[] = [];
    const executor = createExecutor({ approvalsGet: async () => row,
      approvalsUpdate: async ({ request }) => { row = request; transitions.push(request); return { ok: true }; } });
    await executor.execute('approval.request.decide', { artifactId: 'public-link-voice', decision: 'approve' }, {
      surface: 'voice', authority: 'present_user', runtimeAccountId: 'alice', actionCaller: { kind: 'host' },
    });
    expect(transitions[0]).toMatchObject({ status: 'approved', decision: {
      kind: 'approve', authority: 'present_user', decidingAccountId: 'alice',
    } });
  });

  it.each([
    { surface: 'voice', authority: 'account_automation', actionCaller: { kind: 'host' } },
    { surface: 'voice', authority: 'present_user', actionCaller: { kind: 'session', sessionId: 's1', starterDepth: 0, turnDepth: 0 } },
    { surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' } },
  ] satisfies ActionExecutorContext[])('retains the public-link confirmation floor without delegated Voice custody (%j)', async context => {
    const actionId = 'artifact.public_link.create';
    const row = createApprovalRequest('open', { actionId,
      actionArgs: getActionSpec(actionId).inputSchema.parse({ artifactId: '11111111-1111-4111-8111-111111111111' }) });
    const transitions: ApprovalRequest[] = [];
    const executor = createExecutor({ approvalsGet: async () => row,
      approvalsUpdate: async ({ request }) => { transitions.push(request); return { ok: true }; } });
    expect(await executor.execute('approval.request.decide', { artifactId: 'public-link-voice', decision: 'approve' }, context))
      .toMatchObject({ ok: false, errorCode: 'present_user_required' });
    expect(transitions).toEqual([]);
  });

  it('keeps requester public-link confirmation blocked before any approval transition', async () => {
    const actionId = 'artifact.public_link.create';
    const actionArgs = getActionSpec(actionId).inputSchema.parse({ artifactId: '11111111-1111-4111-8111-111111111111' });
    const requesterConfirmation = { requestRef: 'bob-input', requesterAccountId: 'bob',
      personaSessionRef: { serverId: 'server-1', sessionId: 's1' }, executionAccountId: 'alice',
      inputDigest: computeActionInputApprovalDigestV1(actionId, actionArgs) };
    const executionOriginV1 = buildApprovalExecutionOriginV1({ actionId, input: actionArgs,
      context: sharedRequesterContext(actionId, actionArgs), targetSessionId: 's1', requesterConfirmation });
    if (!executionOriginV1) throw new Error('Expected signed public-link origin');
    const request = ApprovalRequestV2Schema.parse({ ...createApprovalRequest(), actionId, actionArgs,
      requestedSurface: 'agent', executionOriginV1, requesterConfirmation });
    const transitions: ApprovalRequest[] = [];
    const executor = createExecutor({ approvalsGet: async () => request,
      approvalsUpdate: async ({ request }) => { transitions.push(request); return { ok: true }; } });
    expect(await executor.execute('approval.request.decide', { artifactId: 'public-link-approval', decision: 'approve' }, {
      surface: 'rpc', authority: 'present_user', runtimeAccountId: 'alice', requesterApprovalDecision: { sessionId: 's1',
        actor: { kind: 'accountUser', accountId: 'bob', relationship: 'sharedApprover' }, isCurrent: async () => true },
    })).toMatchObject({ ok: false, errorCode: 'present_user_required' });
    expect(transitions).toEqual([]);
    expect(request.status).toBe('open');
  });

  it.each([false, true])('keeps detached Run person authority separate from requester consent (shared requester: %s)', async shared => {
    const actionId = 'execution.run.permission.respond';
    const actionArgs = { runId: 'alice-run', requestId: 'alice-permission', approved: true };
    const source = sharedRequesterContext(actionId, actionArgs);
    const requests: ApprovalRequestV2[] = [];
    const effects: ActionExecutorContext[] = [];
    const executor = createExecutor({
      // Artifact persistence and the detached Run process transport are boundaries.
      approvalsCreate: async ({ request }) => { requests[0] = ApprovalRequestV2Schema.parse(request); return { artifactId: 'run-approval' }; },
      approvalsGet: async () => requests[0] ?? null,
      approvalsUpdate: async ({ request: next }) => {
        const transition = decideApprovalRequestTransition(requests[0], next);
        if (!transition.ok) return transition;
        requests[0] = ApprovalRequestV2Schema.parse(next);
        return { ok: true };
      },
      executionRunPermissionRespond: async (_input, context) => { effects.push(context); return { ok: true }; },
    });
    expect(await executor.execute(actionId, actionArgs,
      shared ? source : { ...source, actionRequestAttributionV1: undefined }))
      .toMatchObject({ ok: true, result: { kind: 'approval_request_created', artifactId: 'run-approval' } });
    expect(requests[0]).toMatchObject({ status: 'open', actionId, actionArgs,
      ...(shared ? { requesterConfirmation: { requesterAccountId: 'bob', executionAccountId: 'alice' } } : {}) });
    expect(effects).toEqual([]);
    const result = await executor.execute('approval.request.decide', { artifactId: 'run-approval', decision: 'approve' }, {
      surface: shared ? 'rpc' : 'ui', authority: 'present_user', runtimeAccountId: 'alice',
      serverId: 'server-1', serverIdentityId: 'stable-home', actionCaller: { kind: 'host' },
      ...(shared ? { requesterApprovalDecision: { sessionId: 's1',
        // Bob's proof grants invocation of this Bot only, not Alice's detached Run.
        actor: { kind: 'accountUser' as const, accountId: 'bob', relationship: 'sharedApprover' as const },
        isCurrent: async () => true } } : {}),
    });
    if (shared) {
      expect(effects).toEqual([]);
      expect(requests[0]).toMatchObject({ status: 'failed', execution: { ok: false, errorCode: 'present_user_required' } });
    } else {
      expect(result).toMatchObject({ ok: true, result: { status: 'executed', execution: { ok: true } } });
      expect(effects).toHaveLength(1);
      expect(effects[0]).toMatchObject({ authority: 'present_user', runtimeAccountId: 'alice' });
    }
  });

  it('defaults the admitted shared request outward effect to requester confirmation and respects its Action waiver', async () => {
    let stored: ApprovalRequest | null = null;
    const effects: ActionExecutorContext[] = [];
    const executor = createExecutor({
      approvalsCreate: async ({ request }) => { stored = request; return { artifactId: 'bob-confirmation' }; },
      sessionSendMessage: async ({ context }) => { effects.push(context); return { status: 'accepted', localId: 'waived' }; },
    });
    const input = { sessionId: 's1', message: 'hello' };
    const sourceContext = sharedRequesterContext('session.message.send', input);
    const context = { ...sourceContext, serverId: 'executor-local-home-profile', actionRequestAttributionV1: {
      ...sourceContext.actionRequestAttributionV1!, persona: { serverId: 'server-1', sessionId: 'manager-on-another-machine' },
    } };
    const { externalActionExecutionAuthorization: _authorization, signExternalActionApprovalInput: _sign,
      actionCaller: _caller, sessionInputSource: _source, callerPermissionMode: _mode, causalPermissionAuthority: _ceiling, ...unsigned } = context;
    expect(await executor.execute('session.message.send', input, { ...unsigned, surface: 'mcp' }))
      .toMatchObject({ ok: false, errorCode: 'approval_requester_unavailable' });
    expect(stored).toBeNull();
    expect(effects).toEqual([]);
    const created = await executor.execute('session.message.send', input, context);
    expect(created, JSON.stringify(created))
      .toMatchObject({ ok: true, result: { kind: 'approval_request_created', artifactId: 'bob-confirmation' } });
    expect(stored).toMatchObject({ requesterConfirmation: { requestRef: 'bob-input', requesterAccountId: 'bob',
      executionAccountId: 'alice', personaSessionRef: { serverId: 'executor-local-home-profile', sessionId: 's1' } },
      executionOriginV1: { actionRequestAttributionV1: { persona: { sessionId: 'manager-on-another-machine' } } } });
    expect(effects).toEqual([]);
    stored = null;
    expect(await executor.execute('session.message.send', input, { ...context,
      actionsSettings: ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: { 'session.message.send': ['agent'] } }) }))
      .toMatchObject({ ok: true });
    expect(stored).toBeNull();
    expect(effects).toHaveLength(1);
    expect(effects[0]).toMatchObject({ runtimeAccountId: 'alice' });
    expect(effects[0].presentUserApproval).toBeUndefined();
  });

  it('lets a fresh shared current-context command reach the resolved Action approval owner', async () => {
    const input = { commandId: 'current-ui:frame-b:continue' };
    const innerApproval = {
      kind: 'approval_request_created',
      artifactId: 'account-home-continuation-approval',
      actionId: 'account.home_continuation.invoke',
    };
    const uiCurrentContextAction = vi.fn(async () => ({ ok: true as const, result: innerApproval }));
    const approvalsCreate = vi.fn(async () => ({ artifactId: 'must-not-create-outer-approval' }));
    const executor = createExecutor({
      uiCurrentContextAction,
      approvalsCreate,
    });

    await expect(executor.execute('ui.current_context.command.invoke', input, sharedRequesterCurrentUiContext(input)))
      .resolves.toEqual({ ok: true, result: innerApproval });
    expect(uiCurrentContextAction).toHaveBeenCalledWith(expect.objectContaining({
      actionId: 'ui.current_context.command.invoke', input,
    }));
    expect(approvalsCreate).not.toHaveBeenCalled();
  });

  it('returns the typed stale refusal from the current-context owner before any outer approval', async () => {
    const input = { commandId: 'current-ui:frame-a:continue' };
    const stale = { ok: false as const, errorCode: 'unsupported_action', error: 'stale_surface' };
    const uiCurrentContextAction = vi.fn(async () => stale);
    const approvalsCreate = vi.fn(async () => ({ artifactId: 'must-not-create-outer-approval' }));
    const executor = createExecutor({
      uiCurrentContextAction,
      approvalsCreate,
    });

    await expect(executor.execute('ui.current_context.command.invoke', input, sharedRequesterCurrentUiContext(input)))
      .resolves.toEqual(stale);
    expect(uiCurrentContextAction).toHaveBeenCalledWith(expect.objectContaining({
      actionId: 'ui.current_context.command.invoke', input,
    }));
    expect(approvalsCreate).not.toHaveBeenCalled();
  });

  it('binds a shared Bot decision to Bob while replay retains Alice and rejoins the same effect', async () => {
    const original = createApprovalRequest();
    if (original.v !== 2) throw new Error('Expected current approval');
    const requesterConfirmation = { requestRef: 'bob-input', requesterAccountId: 'bob',
        personaSessionRef: { serverId: 'server-1', sessionId: 's1' }, executionAccountId: 'alice',
        inputDigest: computeActionInputApprovalDigestV1(original.actionId, original.actionArgs) };
    const executionOriginV1 = buildApprovalExecutionOriginV1({ actionId: original.actionId, input: original.actionArgs,
      context: sharedRequesterContext(original.actionId, original.actionArgs), targetSessionId: 's1', requesterConfirmation });
    if (!executionOriginV1) throw new Error('Expected signed shared origin');
    let request: ApprovalRequest = ApprovalRequestV2Schema.parse({ ...original, requestedSurface: 'agent', executionOriginV1, requesterConfirmation });
    const effects: Array<{ message: string; accountId: string | undefined }> = [];
    const credentialUses = [{ v: 1 as const, kind: 'connected_account' as const, label: 'Personal GitHub',
      owner: { kind: 'account' as const, accountId: 'alice' }, service: { pluginId: 'example.service', localId: 'github' },
      why: { kind: 'purpose_binding' as const, purpose: { consumer: { pluginId: 'example.worker', localId: 'publish' }, purpose: 'repository-write' }, target: 'account' as const },
      currentness: { kind: 'current_at_materialization' as const } },
      { v: 1 as const, kind: 'team_resource' as const, label: 'Acme GitHub',
        owner: { kind: 'team' as const, teamId: 'acme' }, service: { pluginId: 'example.service', localId: 'github' },
        why: { kind: 'purpose_binding' as const, purpose: { consumer: { pluginId: 'example.worker', localId: 'publish' }, purpose: 'repository-write' }, target: 'account' as const },
        currentness: { kind: 'current_at_materialization' as const, resourceRevision: 7 } }];
    let entitled = true;
    const executor = createExecutor({ approvalsGet: async () => request,
      approvalsUpdate: async ({ request: next }) => {
        const transition = decideApprovalRequestTransition(request, next);
        if (!transition.ok) return transition;
        request = ApprovalRequestV2Schema.parse(next);
        return { ok: true };
      },
      sessionSendMessage: async ({ message, context }) => {
        // Session transport is this Protocol executor's external effect port;
        // CLI owner tests prove these events come from actual credential admission.
        for (const use of credentialUses) context?.recordOperationCredentialUse?.(use);
        effects.push({ message, accountId: context?.runtimeAccountId });
        return { status: 'accepted', localId: 'one-effect' };
      },
    });
    const input = { artifactId: 'shared-bot-approval', decision: 'approve' };
    const decisionContext = (accountId: string): ActionExecutorContext => ({ surface: 'rpc', authority: 'present_user',
      runtimeAccountId: 'alice', requesterApprovalDecision: { sessionId: 's1',
        actor: { kind: 'accountUser', accountId, relationship: 'sharedApprover' }, isCurrent: async () => entitled } });
    expect(await executor.execute('approval.request.decide', input, decisionContext('carol')))
      .toMatchObject({ ok: false, errorCode: 'present_user_required' });
    expect(request.status).toBe('open');
    expect(effects).toEqual([]);
    expect(await executor.execute('approval.request.decide', input, { surface: 'agent', authority: 'account_automation',
      defaultSessionId: 'other-session', actionsSettings: ActionsSettingsV1Schema.parse({ v: 1,
        approvalWaivedSurfaces: { 'approval.request.decide': ['agent'] } }) }))
      .toMatchObject({ ok: false, errorCode: 'present_user_required' });
    entitled = false;
    expect(await executor.execute('approval.request.decide', input, decisionContext('bob')))
      .toMatchObject({ ok: false, errorCode: 'approval_stale' });
    expect(request.status).toBe('open');
    entitled = true;
    const admittedRequest = request;
    request = { ...request, actionArgs: { sessionId: 's1', message: 'changed after preview' } };
    expect(await executor.execute('approval.request.decide', input, decisionContext('bob')))
      .toMatchObject({ ok: false, errorCode: 'approval_stale' });
    expect(effects).toEqual([]);
    request = admittedRequest;
    const decided = await executor.execute('approval.request.decide', input, decisionContext('bob'));
    expect(decided).toMatchObject({ ok: true, result: { status: 'executed' } });
    expect(request).toMatchObject({ decision: { authority: 'present_user', decidingAccountId: 'bob' } });
    expect(request.execution).toMatchObject({ operationCredentialUses: credentialUses });
    expect(decided).toMatchObject({ result: { execution: { operationCredentialUses: credentialUses } } });
    expect(request.executionOriginV1.actionRequestAttributionV1).toEqual(executionOriginV1.actionRequestAttributionV1);
    expect(effects).toEqual([{ message: 'hello', accountId: 'alice' }]);
    expect(await executor.execute('approval.request.decide', input, decisionContext('bob'))).toEqual(decided);
    expect(effects).toHaveLength(1);
    expect(await executor.replayApprovedApprovalRequest({ artifactId: 'shared-bot-approval', callerAuthority: 'present_user' }))
      .toMatchObject({ ok: false, errorCode: 'present_user_required' });
  });

  it('settles a requester-approved request when its signed Session origin is no longer current', async () => {
    const original = createApprovalRequest();
    if (original.v !== 2) throw new Error('Expected current approval');
    const requesterConfirmation = { requestRef: 'bob-input', requesterAccountId: 'bob',
      personaSessionRef: { serverId: 'server-1', sessionId: 's1' }, executionAccountId: 'alice',
      inputDigest: computeActionInputApprovalDigestV1(original.actionId, original.actionArgs) };
    const executionOriginV1 = buildApprovalExecutionOriginV1({ actionId: original.actionId, input: original.actionArgs,
      context: sharedRequesterContext(original.actionId, original.actionArgs), targetSessionId: 's1', requesterConfirmation });
    if (!executionOriginV1) throw new Error('Expected signed shared origin');
    let request = ApprovalRequestV2Schema.parse({ ...original, requestedSurface: 'agent', executionOriginV1, requesterConfirmation });
    const sessionSendMessage = vi.fn(async () => ({ status: 'accepted' as const, localId: 'must-not-send' }));
    const executor = createExecutor({
      isApprovalExecutionOriginCurrent: async ({ reportStale }) => {
        reportStale?.('credential_changed');
        return false;
      },
      approvalsGet: async () => request,
      approvalsUpdate: async ({ request: next }) => {
        const transition = decideApprovalRequestTransition(request, next);
        if (!transition.ok) return transition;
        request = ApprovalRequestV2Schema.parse(next);
        return { ok: true };
      },
      sessionSendMessage,
    });
    const context: ActionExecutorContext = { surface: 'rpc', authority: 'present_user', runtimeAccountId: 'alice',
      requesterApprovalDecision: { sessionId: 's1', actor: { kind: 'accountUser', accountId: 'bob', relationship: 'sharedApprover' },
        isCurrent: async () => true } };

    const decided = await executor.execute('approval.request.decide',
      { artifactId: 'shared-bot-stale-approval', decision: 'approve' }, context);

    expect(decided).toMatchObject({ ok: true, result: { status: 'failed', execution: {
      effectAttempted: false, errorCode: 'approval_stale', details: { reason: 'credential_changed' },
    } } });
    expect(request).toMatchObject({ status: 'failed', decision: {
      kind: 'approve', authority: 'present_user', decidingAccountId: 'bob',
    }, execution: { effectAttempted: false, errorCode: 'approval_stale', details: { reason: 'credential_changed' } } });
    expect(sessionSendMessage).not.toHaveBeenCalled();
    expect(await executor.execute('approval.request.decide',
      { artifactId: 'shared-bot-stale-approval', decision: 'approve' }, context)).toEqual(decided);
    expect(sessionSendMessage).not.toHaveBeenCalled();
  });

  it.each([true, false])('returns a strict decision receipt for an ACP catalog approval (write succeeds: %s)', async succeeds => {
    const backend = { id: 'approval-agent', name: 'approval-agent', title: 'Approval agent',
      launch: { kind: 'command', command: 'approval-agent', args: ['--acp'] } };
    let stored: ApprovalRequest | null = null;
    let settings: unknown = { v: 2, backends: [] };
    const executor = createExecutor({
      // Artifact IO and Account catalog persistence are the system boundaries.
      approvalsCreate: async ({ request }) => { stored = ApprovalRequestV2Schema.parse(request); return { artifactId: 'catalog-approval' }; },
      approvalsGet: async () => stored,
      approvalsUpdate: async ({ request }) => {
        if (!stored) throw new Error('missing_approval');
        const transition = decideApprovalRequestTransition(stored, request);
        if (!transition.ok) return transition;
        stored = ApprovalRequestV2Schema.parse(request);
        return { ok: true };
      },
      updateAccountAcpCatalogSettings: async ({ mutate }) => {
        if (!succeeds) return { ok: false, errorCode: 'catalog_write_failed', error: 'catalog_write_failed' };
        settings = mutate(settings);
        return { ok: true, revision: 1 };
      },
    });
    const created = await executor.execute('agents.acp.backends.upsert', { backend }, { surface: 'cli', authority: 'present_user',
      actionCaller: { kind: 'host' } });
    expect(created, JSON.stringify(created)).toMatchObject({ ok: true,
      result: { kind: 'approval_request_created', artifactId: 'catalog-approval' } });
    const decided = await executor.execute('approval.request.decide', { artifactId: 'catalog-approval', decision: 'approve' });
    expect(decided, JSON.stringify(decided)).toMatchObject({ ok: true, result: { status: succeeds ? 'executed' : 'failed',
      execution: succeeds ? { ok: true, result: { backend: { id: backend.id }, revision: 1 } }
        : { ok: false, errorCode: 'catalog_write_failed' } } });
    if (!decided.ok) throw new Error(decided.errorCode);
    expect(getActionSpec('approval.request.decide').outputSchema!.safeParse(decided.result).success).toBe(true);
    expect(ApprovalRequestV2Schema.parse(stored).status).toBe(succeeds ? 'executed' : 'failed');
    expect(settings).toMatchObject({ backends: succeeds ? [expect.objectContaining({ id: backend.id })] : [] });
    // Re-observation must retain the settled result and never reapply the write.
    expect(await executor.execute('approval.request.decide', { artifactId: 'catalog-approval', decision: 'approve' }))
      .toEqual(decided);
  });

  it.each(['teams.invitations.create', 'teams.invitations.reissue'] as const)(
    'runs signed %s with the deciding app authority, never the proposal carrier', async actionId => {
      const caller = { kind: 'session' as const, sessionId: 'source', starterDepth: 0, turnDepth: 0 };
      const target = { kind: 'machine' as const, machineId: 'source-machine' };
      const input = getActionSpec(actionId).inputSchema.parse(actionId.endsWith('create')
        ? { v: 1, teamId: 'team', role: 'member', historyAccess: 'from_membership', recipientEmail: null, requestKey: 'create-request' }
        : { v: 1, teamId: 'team', invitationId: 'old-invitation', recipientEmail: null, requestKey: 'reissue-request' });
      const signing = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(29));
      const authorization: ExternalActionExecutionAuthorizationV1 = { v: 1, token: 'signed-proposal-fixture', binding: {
        serverIdentityId: 'stable-home', accountId: 'account', authentication: { kind: 'account', tokenEpoch: 0 },
        machineId: target.machineId, custodianAccountId: 'account', installationId: 'installation',
        actionId, requestId: 'proposal-request', target,
        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1({ v: 1, requestId: 'proposal-request', target, input }),
        sessionActionOrigin: { v: 1, caller, sourceTurnId: 'turn', callerPermissionMode: null, requestId: 'proposal-request' },
        sessionActionSource: { machineId: target.machineId, installationId: 'installation' },
      } };
      let stored: ApprovalRequest | null = null;
      const contexts: ActionExecutorContext[] = [];
      const observations: unknown[] = [];
      const invitation = { id: 'invitation', teamId: 'team', state: 'active', role: 'member',
        historyAccess: 'from_membership', recipientEmailMask: null, expiresAt: 2, createdAt: 1,
        createdByAccountId: 'account', acceptedByAccountId: null, lastEmailDelivery: null };
      const joinUrl = 'https://home.invalid/join/live-result-sentinel';
      const output = actionId.endsWith('create') ? { invitation, joinUrl }
        : { previous: { ...invitation, id: 'old-invitation', state: 'revoked' }, replacement: invitation, joinUrl };
      // The Artifact store, authenticated Home verifier and HTTP effect are process boundaries.
      const deps = {
        approvalsCreate: async ({ request }) => { stored = ApprovalRequestV2Schema.parse(request); return { artifactId: 'signed-invitation' }; },
        approvalsGet: async () => stored,
        approvalsUpdate: async ({ request }) => {
          if (!stored) throw new Error('missing_approval');
          const transition = decideApprovalRequestTransition(stored, request);
          if (!transition.ok) return transition;
          stored = ApprovalRequestV2Schema.parse(request);
          return { ok: true as const };
        },
        isApprovalExecutionOriginCurrent: async ({ origin, request }) => Boolean(origin.target && origin.externalActionInputSignature
          && verifyExternalActionApprovalInputV1({ authorizationToken: authorization.token, actionId: request.actionId,
            target: origin.target, input: request.actionArgs, publicKey: signing.publicKey, signature: origin.externalActionInputSignature })),
        homeDomainAction: async ({ input: effectInput, context }) => {
          contexts.push(context);
          if (context.externalActionExecutionAuthorization || context.externalActionCredential || context.authority !== 'present_user'
            || context.surface !== 'ui' || context.actionCaller?.kind !== 'host' || !isDeepStrictEqual(effectInput, input)) {
            return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
          }
          return output;
        },
        observeActionExecution: async observation => { observations.push(observation); },
      } satisfies Pick<ActionExecutorDeps, 'approvalsCreate' | 'approvalsGet' | 'approvalsUpdate'
        | 'isApprovalExecutionOriginCurrent' | 'homeDomainAction' | 'observeActionExecution'>;
      // Unused transport arms are absent from this boundary fixture.
      const executor = createActionExecutor(deps as unknown as ActionExecutorDeps);
      const pending = await executor.execute(actionId, input, { surface: 'agent', authority: 'account_automation',
        serverId: 'creator-profile', serverIdentityId: 'stable-home', runtimeAccountId: 'account',
        actionRequestId: 'proposal-request', actionCaller: caller, defaultSessionId: 'source', callerPermissionMode: null,
        sessionInputSource: { sourceSessionId: 'source', sourceTurnId: 'turn', via: 'action' },
        externalActionExecutionAuthorization: authorization, externalActionTarget: target,
        signExternalActionApprovalInput: args => signExternalActionApprovalInputV1({ authorizationToken: args.authorization.token,
          actionId: args.actionId, target: args.target, input: args.input, privateKey: signing.secretKey }),
      });
      expect(pending).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
      const decide = () => executor.execute('approval.request.decide', { artifactId: 'signed-invitation', decision: 'approve' }, {
        surface: 'ui', authority: 'present_user', serverId: 'approver-profile', serverIdentityId: 'stable-home',
        runtimeAccountId: 'account', actionCaller: { kind: 'host' }, actionRequestId: 'human-decision',
      });
      const result = await decide();
      expect(result.ok && typeof result.result === 'object' && result.result !== null
        && 'status' in result.result && result.result.status === 'executed').toBe(true);
      expect(result.ok && JSON.stringify(result.result).includes(joinUrl)).toBe(true);
      expect(contexts).toHaveLength(1);
      expect(contexts[0]).toMatchObject({ authority: 'present_user', surface: 'ui', serverId: 'approver-profile',
        actionCaller: { kind: 'host' }, actionRequestId: 'proposal-request' });
      expect(contexts[0]).not.toHaveProperty('externalActionTarget');
      expect(contexts[0]).not.toHaveProperty('sessionInputSource');
      const repeated = await decide();
      expect(contexts).toHaveLength(1);
      for (const safe of [pending, repeated, stored, observations]) expect(JSON.stringify(safe).includes(joinUrl)).toBe(false);
    },
  );
  it('defaults reviewed managed rebuild to Ask first and invokes the managed owner only after explicit approval waiver', async () => {
    const input = { homeId: 'home', managedMachineId: 'managed', kind: 'rebuild', expectedRevision: 4, reviewedEffectDigest: 'reviewed-effects' };
    expect(getActionSpec('machines.managed.rebuild')).toMatchObject({ safety: 'danger', executionPlacement: 'machine' });
    for (const surface of ['ui', 'cli', 'agent', 'mcp', 'voice'] as const) {
      expect(isApprovalRequiredByActionsSettings('machines.managed.rebuild', defaultActionsSettings, { surface }, undefined, undefined, input)).toBe(true);
    }
    const received: unknown[] = [];
    // The protocol executor's declared host transport is the external boundary;
    // its catalog, strict input and approval resolution remain real.
    const executor = createExecutor({ managedMachineAction: async request => {
      received.push(request.input);
      return { kind: 'accepted', managedId: 'managed', intentRevision: 5, operation: { operationId: 'rebuild' } };
    } });
    expect(await executor.execute('machines.managed.rebuild', input, {
      surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
      actionsSettings: ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: { 'machines.managed.rebuild': ['ui'] } }),
    })).toMatchObject({ ok: true, result: { managedId: 'managed', intentRevision: 5 } });
    expect(received).toEqual([input]);
  });
  it.each(['agent', 'mcp'] as const)('requests approval before a %s Session permission answer and executes with a user waiver', async (surface) => {
    let request: ApprovalRequest | null = null;
    const delivered: string[] = [];
    let settings = defaultActionsSettings;
    // Approval persistence and Session RPC delivery are the system boundaries.
    const executor = createExecutor({
      isActionApprovalRequired: (actionId, context) => isApprovalRequiredByActionsSettings(actionId, settings, context),
      approvalsCreate: async ({ request: value }) => { request = value; return { artifactId: 'permission-answer-approval' }; },
      sessionPermissionRespond: async ({ requestId }) => { delivered.push(requestId ?? ''); return { ok: true }; },
    });
    const input = { sessionId: 's1', requestId: 'permission-1', turnId: 'turn-1', decision: 'allow' };
    const context = { surface, authority: 'account_automation' as const, actionCaller: { kind: 'host' as const } };
    expect(await executor.execute('session.permission.respond', input, context)).toMatchObject({
      ok: true, result: { kind: 'approval_request_created', artifactId: 'permission-answer-approval' },
    });
    expect(request).toMatchObject({ status: 'open', actionId: 'session.permission.respond', actionArgs: input });
    expect(delivered).toEqual([]);
    settings = ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: { 'session.permission.respond': [surface] } });
    expect(await executor.execute('session.permission.respond', input, context)).toEqual({ ok: true, result: { ok: true } });
    expect(delivered).toEqual(['permission-1']);
  });
  it('copies an Account widget definition into the exact shared approval payload before publication', async () => {
    const boundary = createWorkBoardArtifactBoundary();
    const definitions = createWidgetDefinitionArtifactPortV1({ ...boundary.transport,
      read: async (id, options) => { const row = await boundary.transport.read(id, options); return row ? { ...row, ownerAccountId: 'account' } : null; },
      list: async options => { const page = await boundary.transport.list(options); return { ...page,
        items: page.items.map(row => ({ ...row, ownerAccountId: 'account' })) }; },
    }, { accountId: 'account' });
    const definition = await definitions.create({ v: 1, id: 'private-definition', name: 'Checks',
      sizeDeclaration: { sizes: ['medium'], defaultSize: 'medium' },
      inputs: { fields: [] }, inputSchema: { type: 'object', additionalProperties: false },
      body: { kind: 'declarative', document: { version: 1, root: { kind: 'metric', label: 'Checks',
        value: { path: ['count'], type: 'number' }, data: { kind: 'resource', resource: { pluginId: 'acme.metrics', localId: 'counts' },
          input: {}, inputSchema: { type: 'object', additionalProperties: false },
          outputSchema: { type: 'object', properties: { count: { type: 'number' } }, required: ['count'], additionalProperties: false } } } } },
      provenance: { source: { kind: 'authored' }, authorAccountId: 'account' } });
    const shared = structuredClone(definition);
    if (shared.body.kind !== 'declarative' || shared.body.document.root.kind !== 'metric'
      || shared.body.document.root.data.kind !== 'resource') throw new Error('Expected metric declaration');
    delete shared.body.document.root.data.input;
    let request: ApprovalRequest | null = null;
    // Artifact and approval persistence are the boundaries; their domain owners remain real.
    const executor = createExecutor({ widgetDefinitionArtifacts: definitions,
      widgetAccountScope: () => ({ serverId: 'home', accountId: 'account' }),
      approvalsCreate: async ({ request: value }) => { request = value; return { artifactId: 'share-definition' }; },
    });
    expect(await executor.execute('widgets.item.add', {
      surface: { serverId: 'home', accountId: 'account', owner: { kind: 'sessionBoard', sessionId: 'shared' } },
      instance: { v: 1, id: 'copy', definition: { kind: 'artifact', artifactId: definition.id }, bindings: {} },
      placement: {},
    }, { surface: 'agent', authority: 'account_automation', actionCaller: { kind: 'host' },
      serverId: 'home', defaultSessionId: 'shared' }))
      // This boundary captures the pending blocking request; no live user waiter is installed.
      .toEqual({ ok: false, errorCode: 'approvals_not_supported', error: 'approvals_not_supported' });
    expect(request).toMatchObject({ actionArgs: { instance: { definition: { kind: 'inline', definition: shared } } } });
    expect(definition.body).not.toEqual(shared.body);
    await definitions.update(definition.id, { name: 'Later', body: { kind: 'declarative',
      document: { version: 1, root: { kind: 'text', text: 'Changed' } } } });
    expect(request).toMatchObject({ actionArgs: { instance: { definition: { kind: 'inline', definition: shared } } } });
  });
  it('rejects removed viewer override input before a shared widget approval is persisted', async () => {
    let persisted = false;
    const executor = createExecutor({ widgetAccountScope: () => ({ serverId: 'home', accountId: 'account' }),
      approvalsCreate: async () => { persisted = true; return { artifactId: 'private-choice' }; },
    });
    expect(await executor.execute('widgets.item.add', {
      surface: { serverId: 'home', accountId: 'account', owner: { kind: 'sessionBoard', sessionId: 'shared' } },
      instance: { v: 1, id: 'copy', definition: { kind: 'builtin', id: 'example' }, bindings: {} },
      viewerValues: { connection: { service: { pluginId: 'acme.metrics', localId: 'cloud' }, accountId: 'private' } }, placement: {},
    }, { surface: 'agent', authority: 'account_automation', actionCaller: { kind: 'host' },
      serverId: 'home', defaultSessionId: 'shared' })).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    expect(persisted).toBe(false);
  });
  it('persists the human computer access choice with the edited target for the blocking waiter', async () => {
    const target = { kind: 'window', displayId: ':73', pid: 42, windowId: 123 } as const;
    let request = createApprovalRequest('open', {
      actionId: 'computer.target.select',
      actionArgs: { machineId: 'machine', requestedTarget: 'Editor', access: 'use' },
      approval: { flow: 'blocking', result: 'required' },
    });
    const executor = createExecutor({
      approvalsGet: async () => request,
      approvalsUpdate: async ({ request: value }) => {
        const transition = decideApprovalRequestTransition(request, value);
        if (!transition.ok) return transition;
        request = value;
        return { ok: true };
      },
      // Native enumeration is a Machine transport boundary; the admission and
      // Artifact transition below it remain real.
      runtimeActionExecute: async () => ({ targets: [{ target }], grants: { capture: 'granted', input: 'granted' } }),
      // The live Session waiter is outside this executor; storage/admission stay real.
      approvalsResolveBlockingDecision: async () => ({ resolved: true }),
    });
    expect(await executor.execute('approval.request.decide', {
      artifactId: 'computer-approval', decision: 'approve', narrowedInput: {
        machineId: 'machine', requestedTarget: 'Editor', target, access: 'see',
      },
    })).toMatchObject({ ok: true, result: { status: 'approved' } });
    expect(request).toMatchObject({ status: 'approved', actionArgs: {
      machineId: 'machine', requestedTarget: 'Editor', access: 'use',
    }, executionOriginV1: { authority: 'account_automation', surface: 'mcp' }, decision: {
      authority: 'present_user', narrowedInput: { machineId: 'machine', requestedTarget: 'Editor', target, access: 'see' },
    } });
  });

  it('accepts a computer access choice only while approving an open computer selection', async () => {
    for (const [actionId, status, decision] of [
      ['computer.target.select', 'open', 'reject'],
      ['session.title.set', 'open', 'approve'],
      ['computer.target.select', 'approved', 'approve'],
    ] as const) {
      let request = createApprovalRequest(status, { actionId,
        actionArgs: actionId === 'computer.target.select'
          ? { machineId: 'machine', requestedTarget: 'Editor' }
          : { sessionId: 's1', title: 'Title' } });
      const initialRequest = request;
      // Approval storage is the persistence boundary; decision admission stays real.
      const executor = createExecutor({
        approvalsGet: async () => request,
        approvalsUpdate: async ({ request: value }) => { request = value; return { ok: true }; },
      });
      expect(await executor.execute('approval.request.decide', {
        artifactId: 'computer-approval', decision, narrowedInput: {
          machineId: 'machine', requestedTarget: 'Editor', access: 'see',
        },
      })).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
      expect(request).toEqual(initialRequest);
    }
  });

  it.each((['ui', 'terminal', 'session', 'external'] as const).flatMap(kind => [
    { kind, addsItem: false }, { kind, addsItem: true },
  ]))('executes the signed $kind process subset without replacing signed input (adds item: $addsItem)', async ({ kind, addsItem }) => {
    const keys = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(23));
    const actionId = 'machines.processes.stop' as const;
    const target = { kind: 'machine' as const, machineId: 'machine' };
    const caller = { kind: 'session' as const, sessionId: 'source', starterDepth: 0, turnDepth: 0 };
    const process = { ref: 'one', expect: { level: 'proven' as const, owner: { kind: 'session' as const, sessionId: 'source' } } };
    const actionArgs = { machineId: 'machine', targets: [process, { ...process, ref: 'two' }] };
    const narrowedInput = { ...actionArgs, targets: [{ ...process, ...(addsItem ? { ref: 'added' } : {}) }] };
    const surface = kind === 'ui' || kind === 'terminal' ? 'ui' : kind === 'session' ? 'agent' : 'api';
    const binding = { serverIdentityId: 'home', accountId: 'account', machineId: 'machine',
      custodianAccountId: 'account', installationId: 'installation', actionId, requestId: 'signed-subset',
      requestEnvelopeDigest: 'a'.repeat(43), target,
      ...(kind === 'external' ? { principalId: 'account', credentialId: '11111111-1111-4111-8111-111111111111', grant: API_TOKEN_FULL_GRANT_V1 }
        : { authentication: { kind: kind === 'terminal' ? 'terminal' : 'account', tokenEpoch: 7 }, ...(kind === 'session' ? {
          sessionActionOrigin: { v: 1, caller, sourceTurnId: 'turn', callerPermissionMode: 'yolo', requestId: 'signed-subset' },
          sessionActionSource: { machineId: 'machine', installationId: 'installation' },
        } : {}) }),
    };
    const authorization = { v: 1, token: 'home-signed-original', binding };
    let request = ApprovalRequestV2Schema.parse({ v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
      createdBy: { surface: 'system' }, requestedSurface: surface, actionId, actionArgs, summary: 'Stop selected work',
      approval: { flow: 'deferred', result: 'required' }, executionOriginV1: { v: 1, surface,
        authority: kind === 'ui' ? 'present_user' : 'account_automation', caller: kind === 'session' ? caller : { kind: 'host' },
        serverId: 'profile', serverIdentityId: 'home', accountId: 'account', machineId: 'machine', actionId, requestId: 'signed-subset', target,
        ...(kind === 'external' ? { principalId: 'account', credentialId: binding.credentialId } : {}),
        ...(kind === 'session' ? { callerPermissionMode: 'yolo', sessionInputSource: { sourceSessionId: 'source', sourceTurnId: 'turn', via: 'action' } } : {}),
        externalActionExecutionAuthorization: authorization,
        externalActionInputSignature: signExternalActionApprovalInputV1({ authorizationToken: authorization.token, actionId,
          input: actionArgs, target, privateKey: keys.secretKey }),
      } });
    const effects: unknown[] = [];
    const verifiedInputs: unknown[] = [];
    // Persistence and Machine transport are the boundaries; the real signature,
    // decision transition, catalog admission and executor replay remain composed.
    const executor = createExecutor({ approvalsGet: async () => request,
      approvalsUpdate: async ({ request: next }) => {
        const transition = decideApprovalRequestTransition(request, next);
        if (!transition.ok) return transition;
        request = ApprovalRequestV2Schema.parse(next);
        return { ok: true };
      },
      isApprovalExecutionOriginCurrent: async ({ origin, request: signedRequest }) => {
        verifiedInputs.push(signedRequest.actionArgs);
        return verifyExternalActionApprovalInputV1({ authorizationToken: origin.externalActionExecutionAuthorization?.token ?? '',
          actionId: signedRequest.actionId, target, input: signedRequest.actionArgs,
          publicKey: keys.publicKey, signature: origin.externalActionInputSignature ?? '' });
      },
      machineProcessesAction: async ({ input }) => { effects.push(input);
        return { status: 'ended', outcomes: [{ ref: 'one', outcome: 'ended', freedBytes: 4096 }] }; },
    });
    if (kind === 'terminal') {
      expect(await executor.execute('approval.request.decide', { artifactId: 'signed-subset', decision: 'approve' }, {
        surface: 'ui', authority: 'account_automation',
      })).toMatchObject({ ok: false, errorCode: 'present_user_required' });
      expect(request.status).toBe('open');
      expect(effects).toEqual([]);
    }
    const result = await executor.execute('approval.request.decide', { artifactId: 'signed-subset', decision: 'approve', narrowedInput });
    expect(request.actionArgs).toEqual(actionArgs);
    if (addsItem) {
      expect(result).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
      expect(request.status).toBe('open');
      expect(effects).toEqual([]);
    } else {
      expect(result).toMatchObject({ ok: true, result: { status: 'executed' } });
      expect(effects).toEqual([narrowedInput]);
      expect(request.decision).toMatchObject({ narrowedInput });
      expect(verifiedInputs.length).toBeGreaterThan(0);
      expect(verifiedInputs.every(input => isDeepStrictEqual(input, actionArgs))).toBe(true);
    }
  });

  it('admits an ORC-19 agent attention write through approval before changing the standing', async () => {
    let request: ApprovalRequest | null = null;
    let standing = true;
    const settings = ActionsSettingsV1Schema.parse({ v: 1, actions: {
      'session.attention.set': { approvalRequiredSurfaces: ['agent'] },
    } });
    // Approval persistence and the attention HTTP port are the system boundaries.
    const executor = createExecutor({
      isActionApprovalRequired: (actionId, context) => isApprovalRequiredByActionsSettings(actionId, settings, context),
      approvalsCreate: async ({ request: value }) => { request = value; return { artifactId: 'attention-approval' }; },
      approvalsGet: async () => request,
      approvalsUpdate: async ({ request: value }) => { request = value; return { ok: true }; },
      sessionAttentionSet: async ({ sessionId, request: value }) => {
        if (typeof value.standing === 'boolean') standing = value.standing;
        return { standing: { sessionId, standing, updatedAt: 10 } };
      },
    });

    expect(await executor.execute('session.attention.set', { sessionId: 's1', standing: false }, {
      surface: 'agent', authority: 'account_automation', actionCaller: { kind: 'host' },
    })).toMatchObject({ ok: true, result: { kind: 'approval_request_created', artifactId: 'attention-approval' } });
    expect(request).toMatchObject({ status: 'open', actionId: 'session.attention.set',
      actionArgs: { sessionId: 's1', standing: false } });
    expect(standing).toBe(true);

    expect(await executor.execute('approval.request.decide', {
      artifactId: 'attention-approval', decision: 'approve',
    })).toMatchObject({ ok: true, result: { status: 'executed' } });
    expect(request).toMatchObject({ status: 'executed' });
    expect(standing).toBe(false);
  });

  it('keeps surface control approval decisions human even for a credential with an approve grant', async () => {
    for (const actionId of ['browser.control.takeControl', 'browser.control.handBack', 'computer.targets.list',
      'computer.target.select', 'computer.control.interrupt', 'computer.control.handBack',
      'computer.permissions.openSettings', 'browser.sandbox.install'] as const) {
      let request = createApprovalRequest('open', { actionId, actionArgs: { machineId: 'machine', requestedTarget: 'Editor' } });
      const executor = createExecutor({
        approvalsGet: async () => request,
        approvalsUpdate: async ({ request: value }) => { request = value; return { ok: true }; },
        isApprovalExecutionOriginCurrent: async () => true,
      });
      for (const decision of ['approve', 'reject'] as const) {
        expect(await executor.execute('approval.request.decide', { artifactId: 'surface-approval', decision }, {
          surface: 'api', authority: 'account_automation', externalActionCredential: {
            accountId: 'account', principalId: 'token', credentialId: 'token', grant: { ...API_TOKEN_FULL_GRANT_V1, approve: true },
          },
        }), `${actionId}:${decision}`).toMatchObject({ ok: false, errorCode: 'present_user_required' });
        expect(request.status).toBe('open');
      }
      request = { ...request, status: 'approved', decision: { kind: 'approve', decidedAtMs: 2 } };
      expect(await executor.replayApprovedApprovalRequest({
        artifactId: 'surface-approval', callerAuthority: 'account_automation',
      }), actionId).toMatchObject({ ok: false, errorCode: 'present_user_required' });
      expect(request.status).toBe('approved');
    }
  });

  it.each(['agent', 'mcp'] as const)('refuses native Realtime approval decisions before any %s approval effect', async (surface) => {
    const approvalsGet = vi.fn(async () => createApprovalRequest());
    const approvalsUpdate = vi.fn(async () => ({ ok: true }));
    const targetActionApprovalReplay = vi.fn(async () => ({ ok: true as const, result: { status: 'executed' } }));
    const executor = createExecutor({ approvalsGet, approvalsUpdate, targetActionApprovalReplay });
    const actionsSettings = ActionsSettingsV1Schema.parse({ v: 1,
      approvalWaivedSurfaces: { 'approval.request.decide': [surface] } });
    const context = { surface, authority: 'account_automation', defaultSessionId: 'deciding-session',
      nativeRealtimeInput: true, bypassApprovals: true, actionsSettings,
      actionCaller: { kind: 'host' } } as const;
    for (const status of ['open', 'approved'] as const) {
      approvalsGet.mockResolvedValue(createApprovalRequest(status));
      for (const decision of ['approve', 'reject', 'cancel'] as const) {
        expect(await executor.execute('approval.request.decide', { artifactId: 'native-approval', decision }, context))
          .toMatchObject({ ok: false, errorCode: 'present_user_required' });
      }
    }
    expect(approvalsGet).not.toHaveBeenCalled();
    expect(approvalsUpdate).not.toHaveBeenCalled();
    expect(targetActionApprovalReplay).not.toHaveBeenCalled();
    expect(await executor.execute('approval.request.decide', { artifactId: 'native-approval', decision: 'approve' },
      { ...context, nativeRealtimeInput: undefined }))
      .toMatchObject({ ok: true, result: { status: 'executed' } });
    expect(targetActionApprovalReplay).toHaveBeenCalledOnce();
  });

  it.each(['agent', 'mcp'] as const)('refuses native Realtime permission decisions while preserving ordinary %s Actions', async (surface) => {
    const sessionPermissionRespond = vi.fn(async () => ({ ok: true }));
    const executionRunPermissionRespond = vi.fn(async () => ({ ok: true as const }));
    const sessionPermissionRemoteAction = vi.fn(async () => ({ ok: true as const }));
    const executor = createExecutor({ sessionPermissionRespond, executionRunPermissionRespond, sessionPermissionRemoteAction,
      sessionList: async () => ({ sessions: [], nextCursor: null }) });
    const actionsSettings = ActionsSettingsV1Schema.parse({ v: 1,
      approvalWaivedSurfaces: { 'session.permission.respond': [surface], 'execution.run.permission.respond': [surface] } });
    const context = { surface, authority: 'account_automation', defaultSessionId: 's1',
      nativeRealtimeInput: true, bypassApprovals: true, actionsSettings,
      actionCaller: { kind: 'host' } } as const;
    for (const decision of ['allow', 'deny'] as const) {
      expect(await executor.execute('session.permission.respond', { sessionId: 's1', requestId: 'permission-1', decision }, context))
        .toMatchObject({ ok: false, errorCode: 'present_user_required' });
      expect(await executor.execute('session.permission.remote.respond', {
        sessionId: 's1', turnId: 'turn-1', requestId: 'permission-1', decision, scope: 'request',
        sourceRef: 'binding-1', sourceRevisionOrEpoch: 'rev-1', idempotencyKey: 'native-decision',
        actor: { namespace: 'discord', principalId: 'user-1' },
      }, context))
        .toMatchObject({ ok: false, errorCode: 'present_user_required' });
      expect(await executor.execute('execution.run.permission.respond', {
        runId: 'run-1', requestId: 'permission-1', approved: decision === 'allow',
      }, { ...context, authority: 'present_user' }))
        .toMatchObject({ ok: false, errorCode: 'present_user_required' });
    }
    expect(sessionPermissionRespond).not.toHaveBeenCalled();
    expect(executionRunPermissionRespond).not.toHaveBeenCalled();
    expect(sessionPermissionRemoteAction).not.toHaveBeenCalled();
    expect(await executor.execute('session.list', {}, context)).toMatchObject({ ok: true });
    expect(await executor.execute('session.permission.respond', { sessionId: 's1', requestId: 'permission-1', decision: 'allow' },
      { ...context, nativeRealtimeInput: undefined })).toMatchObject({ ok: true });
    expect(sessionPermissionRespond).toHaveBeenCalledOnce();
  });

  it('delegates ordinary approval decisions to a host agent only after the user waives that Action', async () => {
    for (const surface of ['agent', 'mcp'] as const) {
      let request = createApprovalRequest();
      const messages: string[] = [];
      const executor = createExecutor({
        approvalsGet: async () => request,
        approvalsUpdate: async ({ request: value }) => { request = value; return { ok: true }; },
        sessionSendMessage: async ({ message }) => {
          messages.push(message);
          return { status: 'accepted', localId: 'delegated-message' };
        },
      });
      const input = { artifactId: 'delegated-approval', decision: 'approve' };
      const context = { surface, authority: 'account_automation', defaultSessionId: 'deciding-session',
        actionCaller: { kind: 'host' },
        actionsSettings: ActionsSettingsV1Schema.parse({ v: 1, actions: {} }) } as const;
      expect(await executor.execute('approval.request.decide', input, context))
        .toMatchObject({ ok: false, errorCode: 'present_user_required' });
      expect(request.status).toBe('open');
      expect(messages).toEqual([]);
      expect(await executor.execute('approval.request.decide', input, { ...context, bypassApprovals: true }))
        .toMatchObject({ ok: false, errorCode: 'present_user_required' });
      const actionsSettings = ActionsSettingsV1Schema.parse({ v: 1, actions: {},
        approvalWaivedSurfaces: { 'approval.request.decide': [surface] } });
      expect(await executor.execute('approval.request.decide', input, { ...context, actionsSettings,
        defaultSessionId: 's1',
      })).toMatchObject({ ok: false, errorCode: 'present_user_required' });
      expect(request.status).toBe('open');
      expect(messages).toEqual([]);
      const forwardedExecutor = createExecutor({
        approvalsGet: async () => request,
        approvalsUpdate: async ({ request: value }) => { request = value; return { ok: true }; },
        // Exact-daemon replay transport is an external process boundary.
        targetActionApprovalReplay: async () => {
          request = createApprovalRequest('executed');
          return { ok: true, result: { status: 'executed' } };
        },
      });
      expect(await forwardedExecutor.execute('approval.request.decide', input, { ...context, actionsSettings,
        defaultSessionId: 's1',
      })).toMatchObject({ ok: false, errorCode: 'present_user_required' });
      expect(request.status).toBe('open');
      const delegated = await executor.execute('approval.request.decide', input, { ...context, actionsSettings });
      expect(delegated, JSON.stringify(delegated)).toMatchObject({ ok: true, result: { status: 'executed' } });
      expect(request.status).toBe('executed');
      expect(messages).toEqual(['hello']);
      request = createApprovalRequest('open', { actionId: 'account.apiTokens.create', actionArgs: {} });
      expect(await executor.execute('approval.request.decide', input, { ...context, actionsSettings }))
        .toMatchObject({ ok: false, errorCode: 'present_user_required' });
      expect(request.status).toBe('open');
      expect(await executor.execute('approval.request.decide', input, { ...context, actionsSettings,
        externalActionCredential: { accountId: 'account', principalId: 'token', credentialId: 'token', grant: API_TOKEN_FULL_GRANT_V1 },
      })).toMatchObject({ ok: false, errorCode: 'present_user_required' });
    }
  });

  it('allows an approval-granted credential to decide an ordinary approved Action', async () => {
    let request = createApprovalRequest();
    const messages: string[] = [];
    const executor = createExecutor({
      approvalsGet: async () => request,
      approvalsUpdate: async ({ request: value }) => { request = value; return { ok: true }; },
      sessionSendMessage: async ({ message }) => {
        messages.push(message);
        return { status: 'accepted', localId: 'ordinary-message' };
      },
    });
    expect(await executor.execute('approval.request.decide', { artifactId: 'ordinary-approval', decision: 'approve' }, {
      surface: 'api', authority: 'account_automation', externalActionCredential: {
        accountId: 'account', principalId: 'token', credentialId: 'token', grant: { ...API_TOKEN_FULL_GRANT_V1, approve: true },
      },
    })).toMatchObject({ ok: true, result: { status: 'executed' } });
    expect(request.status).toBe('executed');
    expect(messages).toEqual(['hello']);
  });
  it('retains resume intent through durable Ask-first approval instead of settling as navigation', async () => {
    let request: ApprovalRequest | null = null;
    const effects: unknown[] = [];
    const executor = createExecutor({
      sessionOpen: async input => { effects.push(input); return { ok: true, status: 'opened' }; },
      isActionApprovalRequired: () => true,
      approvalsCreate: async ({ request: value }) => { request = value; return { artifactId: 'resume-request' }; },
      approvalsGet: async () => request,
      approvalsUpdate: async ({ request: value }) => { request = value; return { ok: true }; },
    });
    expect(await executor.execute('session.open', { sessionId: 's1', intent: 'resume' }, { surface: 'ui', authority: 'present_user' }))
      .toMatchObject({ ok: true, result: { kind: 'approval_request_created', artifactId: 'resume-request' } });
    expect(request).toMatchObject({ status: 'open', actionArgs: { sessionId: 's1', intent: 'resume' } });
    expect(effects).toEqual([]);
    expect(await executor.execute('approval.request.decide', { artifactId: 'resume-request', decision: 'approve' }))
      .toMatchObject({ ok: true, result: { status: 'executed' } });
    expect(effects[0]).toMatchObject({ sessionId: 's1', intent: 'resume' });
  });
  it('defaults automated fresh-folder consent to approval while a waiver never grants human authority', async () => {
    let request: ApprovalRequest | null = null;
    const sessionOpen = vi.fn(async () => ({ ok: true, status: 'opened' }));
    const executor = createExecutor({
      sessionOpen,
      approvalsCreate: async ({ request: value }) => { request = value; return { artifactId: 'folder-consent' }; },
      approvalsGet: async () => request,
      approvalsUpdate: async ({ request: value }) => { request = value; return { ok: true }; },
    });
    for (const surface of ['agent', 'mcp'] as const) {
      const context = { surface, authority: 'account_automation' as const, actionCaller: { kind: 'host' as const },
        actionsSettings: ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: { 'session.open': [surface] } }) };
      expect(await executor.execute('session.open', { sessionId: 's1' }, context)).toMatchObject({ ok: true });
      sessionOpen.mockClear();
      const input = { sessionId: 's1', approvedNewDirectoryCreation: true };
      expect(await executor.execute('session.open', input, { ...context, bypassApprovals: true }))
        .toMatchObject({ ok: false, errorCode: 'present_user_required' });
      expect(await executor.execute('session.open', input, context))
        .toMatchObject({ ok: false, errorCode: 'present_user_required' });
      expect(sessionOpen).not.toHaveBeenCalled();
      expect(await executor.execute('session.open', input, { ...context, actionsSettings: defaultActionsSettings }))
        .toMatchObject({ ok: true, result: { kind: 'approval_request_created', artifactId: 'folder-consent' } });
      expect(sessionOpen).not.toHaveBeenCalled();
    }
    const tokenContext = { surface: 'api' as const, authority: 'account_automation' as const,
      externalActionCredential: { accountId: 'account', principalId: 'token', credentialId: 'token',
        grant: { ...API_TOKEN_FULL_GRANT_V1, approve: true } } };
    expect(await executor.execute('approval.request.decide', { artifactId: 'folder-consent', decision: 'approve' }, tokenContext))
      .toMatchObject({ ok: false, errorCode: 'present_user_required' });
    expect(request).toMatchObject({ status: 'open' });
    expect(await executor.execute('approval.request.decide', { artifactId: 'folder-consent', decision: 'approve' }))
      .toMatchObject({ ok: true, result: { status: 'executed' } });
    expect(sessionOpen).toHaveBeenCalledOnce();
    expect(sessionOpen).toHaveBeenCalledWith(expect.objectContaining({ approvedNewDirectoryCreation: true }),
      expect.objectContaining({ surface: 'ui', authority: 'present_user' }));
  });
  it.each(['account_changed', 'home_changed', 'requester_account_unavailable'] as const)(
    'persists the content-free stale fact and returns it in approval error data (%s)', async reason => {
    let request = createApprovalRequest('approved', {
      actionId: 'session.open', actionArgs: { sessionId: 's1', approvedNewDirectoryCreation: true },
    });
    const sessionOpen = vi.fn(async () => ({ ok: true, status: 'opened' }));
    const executor = createExecutor({ sessionOpen,
      isApprovalExecutionOriginCurrent: async ({ reportStale }) => { reportStale?.(reason); return false; },
      approvalsGet: async () => request,
      approvalsUpdate: async ({ request: value }) => { request = ApprovalRequestV2Schema.parse(value); return { ok: true }; },
    });
    const result = await executor.replayApprovedApprovalRequest({ artifactId: 'stale-fact', callerAuthority: 'present_user' });
    expect(request).toMatchObject({ status: 'failed', execution: { errorCode: 'approval_stale', details: { reason } } });
    expect(result).toMatchObject({ ok: true, result: { status: 'failed', execution: {
      errorCode: 'approval_stale', details: { reason },
    } } });
    expect(sessionOpen).not.toHaveBeenCalled();
  });
  it('consumes fresh-folder consent only from a current, already approved exact-daemon replay', async () => {
    let request = createApprovalRequest('open', {
      actionId: 'session.open', actionArgs: { sessionId: 's1', approvedNewDirectoryCreation: true },
    });
    let current = true;
    const sessionOpen = vi.fn(async () => ({ ok: true, status: 'opened' }));
    const executor = createExecutor({
      sessionOpen,
      isActionApprovalRequired: () => false,
      isApprovalExecutionOriginCurrent: async () => current,
      approvalsGet: async () => request,
      approvalsUpdate: async ({ request: value }) => { request = value; return { ok: true }; },
    });
    expect(await executor.replayApprovedApprovalRequest({ artifactId: 'folder-consent' }))
      .toMatchObject({ ok: false, errorCode: 'approval_not_approved' });
    expect(sessionOpen).not.toHaveBeenCalled();
    request = { ...request, status: 'approved', decision: { kind: 'approve', decidedAtMs: 2 } };
    for (const callerAuthority of [undefined, 'account_automation'] as const) {
      expect(await executor.replayApprovedApprovalRequest({ artifactId: 'folder-consent', callerAuthority }))
        .toMatchObject({ ok: false, errorCode: 'present_user_required' });
      expect(request.status).toBe('approved');
      expect(sessionOpen).not.toHaveBeenCalled();
    }
    current = false;
    expect(await executor.replayApprovedApprovalRequest({ artifactId: 'folder-consent', callerAuthority: 'present_user' }))
      .toMatchObject({ ok: true, result: { status: 'failed', execution: { errorCode: 'approval_stale' } } });
    expect(sessionOpen).not.toHaveBeenCalled();
    current = true;
    request = createApprovalRequest('approved', {
      actionId: 'session.open', actionArgs: { sessionId: 's1', approvedNewDirectoryCreation: true },
    });
    expect(await executor.replayApprovedApprovalRequest({ artifactId: 'folder-consent', callerAuthority: 'present_user' }))
      .toMatchObject({ ok: true, result: { status: 'executed' } });
    expect(sessionOpen).toHaveBeenCalledOnce();
  });
  it.each(['open', 'approved'] as const)('cancels an unclaimed %s terminal through the conditional Artifact owner without launching it', async status => {
    expect(getActionSpec('approval.request.decide').inputSchema.safeParse({ artifactId: 'pending-terminal',
      decision: 'cancel', requesterAccountId: 'forged' }).success).toBe(false);
    let stored = createApprovalRequest(status, { actionId: 'machines.terminal.open',
      actionArgs: { serverId: 'server-1', machineId: 'machine', terminalKey: 'member' } });
    let effects = 0;
    const executor = createExecutor({ approvalsGet: async () => stored,
      approvalsUpdate: async ({ request }) => {
        const transition = decideApprovalRequestTransition(stored, request);
        if (!transition.ok) return transition;
        stored = ApprovalRequestSchema.parse(request);
        return { ok: true };
      }, machineTerminalAction: async () => { effects++; return { ok: true, terminalId: 'pty', reused: false }; },
    });
    const settledStatus = status === 'approved' ? 'failed' : 'canceled';
    expect(await executor.execute('approval.request.decide', { artifactId: 'pending-terminal', decision: 'cancel' }))
      .toMatchObject({ ok: true, result: { status: settledStatus } });
    expect(stored.status).toBe(settledStatus);
    if (status === 'approved') {
      expect(stored).toMatchObject({ decision: { kind: 'approve', decidedAtMs: 2 },
        execution: { ok: false, effectAttempted: false, errorCode: 'approval_canceled' } });
    } else expect(stored.decision).toBeUndefined();
    expect(await executor.execute('approval.request.decide', { artifactId: 'pending-terminal', decision: 'cancel' }))
      .toMatchObject({ ok: true, result: { status: settledStatus } });
    expect(await executor.execute('approval.request.decide', { artifactId: 'pending-terminal', decision: 'approve' }))
      .toMatchObject(status === 'approved'
        ? { ok: true, result: { status: 'failed', execution: { errorCode: 'approval_canceled' } } }
        : { ok: false, errorCode: 'approval_not_open' });
    if (status === 'approved') {
      expect(await executor.replayApprovedApprovalRequest({ artifactId: 'pending-terminal' }))
        .toMatchObject({ ok: true, result: { status: 'failed', execution: { errorCode: 'approval_canceled' } } });
    }
    expect(effects).toBe(0);
  });

  it.each(['open', 'approved'] as const)('does not turn an already claimed or conflicting %s terminal cancellation into success', async status => {
    const opened = createApprovalRequest(status, { actionId: 'machines.terminal.open',
      actionArgs: { serverId: 'server-1', machineId: 'machine', terminalKey: 'member' } });
    if (opened.v !== 2) throw new Error('Expected current approval fixture');
    let stored: ApprovalRequest = opened;
    let changed = false;
    const executor = createExecutor({ approvalsGet: async () => stored,
      approvalsUpdate: async ({ request }) => {
        stored = { ...opened, status: 'executing', decision: { kind: 'approve', decidedAtMs: 2 } };
        const transition = decideApprovalRequestTransition(stored, request);
        if (!transition.ok) return { ok: false, errorCode: 'approval_conflict', error: 'approval_conflict' };
        changed = true;
        return { ok: true };
      },
    });
    expect(await executor.execute('approval.request.decide', { artifactId: 'pending-terminal', decision: 'cancel' }))
      .toMatchObject({ ok: false, errorCode: 'approval_conflict' });
    expect(stored.status).toBe('executing');
    expect(changed).toBe(false);
    expect(await executor.execute('approval.request.decide', { artifactId: 'pending-terminal', decision: 'cancel' }))
      .toMatchObject({ ok: false, errorCode: 'approval_not_open' });
  });

  it.each([
    ['account.apiTokens.create', { tokenId: securityTokenSummary.tokenId, label: securityTokenSummary.label }],
    ['account.security.terminalPresentUser.set', { policy: 'allowed' }],
  ] as const)('rejects forged present-user authority in approved private replay for %s', async (actionId, actionArgs) => {
    const forged = createApprovalRequest('approved', { actionId, actionArgs, requestedSurface: 'agent' });
    if (forged.v !== 2) throw new Error('approval_v2_fixture_required');
    let request: ApprovalRequest = { ...forged,
      executionOriginV1: { ...forged.executionOriginV1, authority: 'present_user' } };
    const effects: string[] = [];
    const executor = createExecutor({
      // Artifact data is writable by the Account. HTTP mutation and Artifact
      // persistence are boundaries; real replay must not treat its body as human proof.
      accountApiTokensCreateAction: async () => { effects.push(actionId); return { apiToken: securityTokenSummary, token: securityToken }; },
      accountSecurityTerminalPresentUserSetAction: async () => { effects.push(actionId); return { policy: 'allowed' }; },
      approvalsGet: async () => request,
      approvalsUpdate: async ({ request: value }) => { request = value; return { ok: true }; },
    });
    for (const callerAuthority of [undefined, 'account_automation'] as const) {
      expect(await executor.replayApprovedApprovalRequest({ artifactId: 'forged-security-approval', callerAuthority }))
        .toMatchObject({ ok: false, errorCode: 'present_user_required' });
      expect(request.status).toBe('approved');
      expect(effects).toEqual([]);
    }
  });
  it.each([
    ['account.apiTokens.update', { tokenId: 'dd03e74b-4aae-4a0a-81ee-1c23ddc4525d', label: 'Updated embed' }],
    ['account.apiTokens.revoke', { tokenId: 'dd03e74b-4aae-4a0a-81ee-1c23ddc4525d' }],
    ['account.apiTokens.revokeAll', {}],
    ['account.security.terminalPresentUser.set', { policy: 'allowed' }],
    ['account.sessions.signOutEverywhere', {}],
  ] as const)('requires a human decision for an agent request for %s, then executes once', async (actionId, input) => {
    let request: ApprovalRequest | null = null;
    const effects: string[] = [];
    const observations: unknown[] = [];
    let settings = ActionsSettingsV1Schema.parse({ v: 1 });
    const executor = createExecutor({
      // Account HTTP and Artifact persistence are the system boundaries.
      accountApiTokensCreateAction: async () => { effects.push(actionId); return { apiToken: securityTokenSummary, token: securityToken }; },
      accountApiTokensUpdateAction: async () => { effects.push(actionId); return { apiToken: securityTokenSummary }; },
      accountApiTokensRevokeAction: async () => { effects.push(actionId); return { revoked: true }; },
      accountApiTokensRevokeAllAction: async () => { effects.push(actionId); return { revokedCount: 1 }; },
      accountSecurityTerminalPresentUserSetAction: async () => { effects.push(actionId); return { policy: 'allowed' }; },
      accountSessionsSignOutEverywhereAction: async () => { effects.push(actionId); return { status: 'signed_out' }; },
      isActionApprovalRequired: (id, context) => isApprovalRequiredByActionsSettings(id, settings, context, undefined, undefined, input),
      approvalsCreate: async ({ request: value }) => { request = value; return { artifactId: 'security-request' }; },
      approvalsGet: async () => request,
      approvalsUpdate: async ({ request: value }) => { request = value; return { ok: true }; },
      observeActionExecution: async ({ result }) => { observations.push(result); },
    });
    for (const surface of ['agent', 'mcp', 'plugin'] as const) {
      const actionCaller = surface === 'plugin'
        ? { kind: 'plugin' as const, pluginId: 'acme.author', contributionLocalId: 'surface',
            sourceCustody: { kind: 'development' as const, registeredRootId: 'plugin-root' } }
        : { kind: 'host' as const };
      expect(await executor.execute(actionId, input, {
        surface, authority: 'account_automation', actionCaller, bypassApprovals: true,
      })).toMatchObject({ ok: false, errorCode: 'present_user_required' });
      settings = ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: { [actionId]: [surface] } });
      expect(await executor.execute(actionId, input, {
        surface, authority: 'account_automation', actionCaller,
      })).toMatchObject({ ok: false, errorCode: 'present_user_required' });
      expect(effects).toEqual([]);
      settings = ActionsSettingsV1Schema.parse({ v: 1 });
      expect(await executor.execute(actionId, input, {
        surface, authority: 'account_automation', actionCaller,
      })).toMatchObject({ ok: true, result: { kind: 'approval_request_created', artifactId: 'security-request' } });
    }
    expect(effects).toEqual([]);
    const tokenContext = { surface: 'api' as const, authority: 'account_automation' as const,
      externalActionCredential: { accountId: 'account', principalId: 'token', credentialId: 'token',
        grant: { ...API_TOKEN_FULL_GRANT_V1, approve: true } } };
    expect(await executor.execute(actionId, input, tokenContext)).toMatchObject({ ok: false, errorCode: 'present_user_required' });
    expect(await executor.execute('approval.request.decide', { artifactId: 'security-request', decision: 'approve' }, tokenContext))
      .toMatchObject({ ok: false, errorCode: 'present_user_required' });
    expect(request).toMatchObject({ status: 'open' });
    expect(effects).toEqual([]);
    const decided = await executor.execute('approval.request.decide', { artifactId: 'security-request', decision: 'approve' });
    expect(decided).toMatchObject({ ok: true, result: { status: 'executed' } });
    const duplicate = await executor.execute('approval.request.decide', { artifactId: 'security-request', decision: 'approve' });
    expect(JSON.stringify(duplicate)).not.toContain(securityToken);
    expect(effects).toEqual([actionId]);
    expect(JSON.stringify(request)).not.toContain(securityToken);
    expect(JSON.stringify(observations)).not.toContain(securityToken);
  });
  it('allows an Approve-scoped token to reject, but not approve, a present-user request', async () => {
    let request = createApprovalRequest('open', {
      actionId: 'account.security.terminalPresentUser.set', actionArgs: { policy: 'allowed' },
    });
    const executor = createExecutor({
      approvalsGet: async () => request,
      approvalsUpdate: async ({ request: next }) => { request = next; return { ok: true }; },
    });
    const ctx = { surface: 'api' as const, authority: 'account_automation' as const,
      externalActionCredential: { accountId: 'account', principalId: 'token', credentialId: 'token',
        grant: { ...API_TOKEN_FULL_GRANT_V1, approve: true } } };
    expect(await executor.execute('approval.request.decide', { artifactId: 'request', decision: 'approve' }, ctx))
      .toMatchObject({ ok: false, errorCode: 'present_user_required' });
    expect(request.status).toBe('open');
    expect(await executor.execute('approval.request.decide', { artifactId: 'request', decision: 'reject' }, ctx))
      .toMatchObject({ ok: true, result: { status: 'rejected' } });
  });

  it('projects unknown stored approval fields without deriving human authority from the Artifact', async () => {
    const canonical = createApprovalRequest('open', {
      actionId: 'account.sessions.signOutEverywhere', actionArgs: {},
    });
    if (canonical.v !== 2) throw new Error('Expected current approval fixture');
    const stored = {
      ...canonical, future: true,
      createdBy: { ...canonical.createdBy, future: true },
      executionOriginV1: { ...canonical.executionOriginV1, future: true,
        caller: { ...canonical.executionOriginV1.caller, future: true } },
    };
    let request: unknown = stored;
    let signedOut = false;
    const executor = createExecutor({
      approvalsGet: async () => request as ApprovalRequest,
      approvalsUpdate: async ({ request: next }) => { request = next; return { ok: true }; },
      accountSessionsSignOutEverywhereAction: async () => { signedOut = true; return { status: 'signed_out' }; },
    });
    const automation = { surface: 'mcp' as const, authority: 'account_automation' as const };
    expect(await executor.execute('approval.request.decide', { artifactId: 'request', decision: 'approve' }, automation))
      .toMatchObject({ ok: false, errorCode: 'present_user_required' });
    expect(signedOut).toBe(false);
    expect(await executor.execute('approval.request.decide', { artifactId: 'request', decision: 'approve' }))
      .toMatchObject({ ok: true, result: { status: 'executed' } });
    expect(signedOut).toBe(true);
    expect(JSON.stringify(request)).not.toContain('future');
  });

  it('keeps an automated secret-input request on its live waiter until authenticated human replay', async () => {
    const coordinator = createBlockingApprovalCoordinator();
    const passwordInput = { v: 1 as const, kind: 'plain' as const, expectedCredentialRevision: 1,
      currentPassword: 'current password secret', newPassword: 'replacement password secret' };
    let request: ApprovalRequest | null = null;
    let performed: unknown = null;
    let waiterReady: (() => void) | undefined;
    const ready = new Promise<void>(resolve => { waiterReady = resolve; });
    const executor = createExecutor({
      approvalsCreate: async ({ request: next }) => { request = next; return { artifactId: 'password-request' }; },
      approvalsGet: async () => request,
      approvalsUpdate: async ({ request: next }) => { request = next; coordinator.notifyApprovalUpdated({ artifactId: 'password-request', request: next }); return { ok: true }; },
      approvalsResolveBlockingDecision: async (args) => coordinator.resolveBlockingDecision(args),
      approvalsWaitForDecision: async (args) => {
        const pending = coordinator.waitForDecision(args);
        waiterReady?.();
        const result = await pending;
        return { ...result, request: ApprovalRequestSchema.parse(result.request) };
      },
      accountPasswordChangeAction: async ({ input, context }) => {
        performed = { input, authority: context.authority };
        return { v: 1, status: 'updated' };
      },
    });
    const pending = executor.execute('account.password.change', passwordInput, {
      surface: 'agent', authority: 'account_automation', actionCaller: { kind: 'host' },
      defaultSessionId: 's1', defaultSessionMachineId: 'machine',
    });
    const admission = await Promise.race([
      pending.then(result => ({ kind: 'completed' as const, result })),
      ready.then(() => ({ kind: 'waiting' as const })),
    ]);
    expect(admission).toEqual({ kind: 'waiting' });
    expect(performed).toBeNull();
    expect(JSON.stringify(request)).not.toContain(passwordInput.currentPassword);
    expect(JSON.stringify(request)).not.toContain(passwordInput.newPassword);
    if (admission.kind !== 'waiting' || !request) return;
    request = { ...ApprovalRequestSchema.parse(request), status: 'approved', decision: { kind: 'approve', decidedAtMs: Date.now() } };
    expect(await executor.replayApprovedApprovalRequest({ artifactId: 'password-request', callerAuthority: 'account_automation' }))
      .toMatchObject({ ok: false, errorCode: 'present_user_required' });
    expect(performed).toBeNull();
    expect(await executor.replayApprovedApprovalRequest({ artifactId: 'password-request', callerAuthority: 'present_user' }))
      .toMatchObject({ ok: true });
    expect(await pending).toMatchObject({ ok: true, result: { status: 'updated' } });
    expect(performed).toEqual({ input: passwordInput, authority: 'present_user' });
    expect(JSON.stringify(request)).not.toContain(passwordInput.currentPassword);
    expect(JSON.stringify(request)).not.toContain(passwordInput.newPassword);
    coordinator.dispose();
  });
  it.each(['agent', 'mcp', 'cli'] as const)('defaults %s trigger removal to approval and executes a waived write without promoting authority', async surface => {
    let request: ApprovalRequest | null = null;
    const workflow = '11111111-1111-4111-8111-111111111111';
    const recipe = serializeAutomationStoredWorkflowDefinitionRecipeV2({
      v: 2, templateVersion: 1, triggerEvidence: null,
      workflow: { t: 'plain', v: { workspace: { directory: '/repo' }, executionTarget: { kind: 'session' } } },
    });
    if (recipe.kind !== 'available') throw new Error('Invalid workflow recipe fixture');
    let row: AutomationDefinitionDetail = { id: 'automation', name: 'Triggers', description: null,
      enabled: true, targetType: null, existingSessionId: null, templateVersion: 1,
      lastRunAt: null, createdAt: 1, updatedAt: 1, workflowDefinitionId: workflow, scopeSessionId: null,
      executionRecipe: recipe.recipe,
      assignments: [{ machineId: 'machine', enabled: true, priority: 0, updatedAt: 1 }],
      triggers: [{ id: 'trigger', revision: 0, enabled: true, createdAt: 1, updatedAt: 1,
        kind: 'schedule', schedule: { kind: 'interval', scheduleExpr: null, everyMs: 60_000, timezone: null },
        nextRunAt: 2, triggerDefinitionEnvelope: null }] };
    const unused = async (): Promise<never> => { throw new Error('Unexpected boundary operation'); };
    // Persistent Automation/Artifact and approval transports are the fake system boundaries.
    const definitions = createWorkflowDefinitionActions({ artifactStore: {
      read: async () => null, list: async () => ({ items: [] }), create: unused, update: unused, delete: unused,
    }, encodeListCursor: (row) => row.artifactId, assertDefinitionWriteAllowed: unused });
    const triggers = createWorkflowTriggerActions({ automations: {
      list: async () => ({ automations: [row], nextCursor: null }), get: async () => row,
      listDetails: async () => ({ automations: [row], nextCursor: null }),
      create: unused, delete: unused,
      reconcile: async (_id, raw) => {
        const input = AutomationDefinitionReconcileRequestSchema.parse(raw);
        row = { ...row, triggers: row.triggers.filter((trigger) => input.triggers.some((item) => item.triggerId === trigger.id)) };
        return row;
      },
    },
      openContext: async (row) => row.executionRecipe?.v === 2 && row.executionRecipe.workflow.t === 'plain'
        ? row.executionRecipe.workflow.v : null,
      sealContext: unused, newId: () => 'unused',
      resolveWorkflow: async (ref) => {
        const source = await resolveWorkflowDefinitionRefV1(ref, { readArtifact: (definitionId) => definitions.get({ definitionId }) });
        if (!source) throw Object.assign(new Error('source_unavailable'), { code: 'source_unavailable' });
        return source.definition;
      },
    });
    const originalTriggers = row.triggers;
    let settings = ActionsSettingsV1Schema.parse({ v: 1 });
    const authorities: ActionExecutorContext['authority'][] = [];
    const executor = createExecutor({
      workflowAction: createWorkflowActionExecutor({
        // This is the server feature-bit boundary; family dispatch/trigger semantics stay real.
        isWorkflowFeatureEnabled: () => true, definitions, triggers, runs: { execute: unused },
      }),
      isActionApprovalRequired: (actionId, context, input) => {
        authorities.push(context?.authority);
        return isApprovalRequiredByActionsSettings(actionId, settings, context, undefined, undefined, input);
      },
      approvalsCreate: async (input) => { request = input.request; return { artifactId: 'approval' }; },
      approvalsGet: async () => request,
      approvalsUpdate: async (input) => { request = input.request; return { ok: true }; },
    } satisfies Pick<ActionExecutorDeps, 'workflowAction' | 'isActionApprovalRequired'
      | 'approvalsCreate' | 'approvalsGet' | 'approvalsUpdate'>);
    expect(await executor.execute('workflow.trigger.remove', { automationId: 'automation', triggerId: 'trigger' }, {
      surface, authority: 'account_automation', actionCaller: { kind: 'host' },
    })).toMatchObject({ ok: true, result: { kind: 'approval_request_created', artifactId: 'approval' } });
    expect(row.triggers).toHaveLength(1);
    expect(request).toMatchObject({ status: 'open', actionId: 'workflow.trigger.remove' });
    await executor.execute('approval.request.decide', { artifactId: 'approval', decision: 'approve' });
    expect(request).toMatchObject({ status: 'executed' });
    expect(row.triggers).toHaveLength(0);
    row = { ...row, triggers: originalTriggers };
    request = null;
    settings = ActionsSettingsV1Schema.parse({ v: 1,
      approvalWaivedSurfaces: { 'workflow.trigger.remove': [surface] } });
    authorities.length = 0;
    expect(await executor.execute('workflow.trigger.remove', { automationId: 'automation', triggerId: 'trigger' }, {
      surface, authority: 'account_automation', actionCaller: { kind: 'host' },
    })).toMatchObject({ ok: true });
    expect(row.triggers).toHaveLength(0);
    expect(request).toBeNull();
    expect(authorities).toEqual(['account_automation']);
    // The same real family/trigger path admits the person's reversible UI edit.
    row = { ...row, triggers: originalTriggers };
    settings = ActionsSettingsV1Schema.parse({ v: 1 });
    request = null;
    expect(await executor.execute('workflow.trigger.remove', { automationId: 'automation', triggerId: 'trigger' }, {
      surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
    })).toMatchObject({ ok: true });
    expect(row.triggers).toHaveLength(0);
    expect(request).toBeNull();
    row = { ...row, triggers: originalTriggers };
    settings = ActionsSettingsV1Schema.parse({ v: 1,
      actions: { 'workflow.trigger.remove': { approvalRequiredSurfaces: ['ui'] } } });
    expect(await executor.execute('workflow.trigger.remove', { automationId: 'automation', triggerId: 'trigger' }, {
      surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
    })).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
    expect(row.triggers).toHaveLength(1);
  });
  it('lets an approve token decide its own request without granting the requested Action', async () => {
    const request = createApprovalRequest();
    const approvalsUpdate = vi.fn(async () => ({ ok: true }));
    const executor = createExecutor({
      approvalsGet: async () => request,
      approvalsUpdate,
      sessionSendMessage: async () => ({ status: 'accepted' as const, localId: 'local-1' }),
    });
    const result = await executor.execute('approval.request.decide', { artifactId: 'a1', decision: 'approve' }, {
      surface: 'api', authority: 'account_automation',
      externalActionCredential: {
        accountId: 'account-1', principalId: 'token-1', credentialId: 'token-1',
        grant: { v: 1, actions: { families: [], ids: ['session.title.set'] }, targets: { sessions: ['s1'], machines: [] },
          approve: true, origins: [], models: null, permissionModes: null, create: null },
      },
    });
    expect(result).toMatchObject({ ok: true });
    expect(approvalsUpdate).toHaveBeenCalledWith(expect.objectContaining({ request: expect.objectContaining({ status: 'executed' }) }));
  });

  it('refuses approval target escape before artifact mutation', async () => {
    const request = createApprovalRequest();
    const approvalsUpdate = vi.fn(async () => ({ ok: true }));
    // The contributed-artifact transport reports that this is an ordinary host artifact.
    const targetActionApprovalReplay = async () => null;
    const executor = createExecutor({ approvalsGet: async () => request, approvalsUpdate, targetActionApprovalReplay });
    const result = await executor.execute('approval.request.decide', { artifactId: 'a1', decision: 'reject' }, {
      surface: 'api', authority: 'account_automation',
      externalActionCredential: {
        accountId: 'account-1', principalId: 'token-1', credentialId: 'token-1',
        grant: { v: 1, actions: null, targets: { sessions: ['other-session'], machines: [] },
          approve: true, origins: [], models: null, permissionModes: null, create: null },
      },
    });
    expect(result).toMatchObject({ ok: false, errorCode: 'credential_scope_denied' });
    expect(approvalsUpdate).not.toHaveBeenCalled();
  });

  it('does not let approve cover token management or a missing approve grant', async () => {
    const executor = createExecutor();
    const context = {
      surface: 'api' as const, authority: 'account_automation' as const,
      externalActionCredential: {
        accountId: 'account-1', principalId: 'token-1', credentialId: 'token-1',
        grant: { v: 1 as const, actions: null, targets: null, approve: false,
          origins: [], models: null, permissionModes: null, create: null },
      },
    };
    expect(await executor.execute('approval.request.decide', { artifactId: 'a1', decision: 'approve' }, context))
      .toMatchObject({ ok: false, errorCode: 'present_user_required' });
    context.externalActionCredential.grant.approve = true;
    expect(await executor.execute('account.apiTokens.create', {}, context))
      .toMatchObject({ ok: false, errorCode: 'present_user_required' });
    expect(await executor.execute('account.security.terminalPresentUser.set', { policy: 'allowed' }, context))
      .toMatchObject({ ok: false, errorCode: 'present_user_required' });
  });

  it('continues a Session blocking confirmation without creating an Account Artifact', async () => {
    let publishedPreview: unknown;
    // The injected host transport is the Session permission RPC/encrypted-state boundary.
    const transport = {
      sessionActionConfirmation: async (request: Parameters<NonNullable<ActionExecutorDeps['sessionActionConfirmation']>>[0]) => {
        publishedPreview = 'preview' in request ? request.preview : undefined;
        return { decision: 'approve' as const, isCurrent: () => true };
      },
      isActionApprovalRequired: () => true,
      sessionActivityGet: async () => ({
        ok: true,
        sessionId: 's1',
        presence: 'online',
        active: true,
        thinking: false,
        working: false,
        blocked: false,
        permissionRequired: false,
        actionRequired: false,
        updatedAt: null,
      }),
    };
    const executor = createExecutor(transport);
    const result = await executor.execute('session.activity.get', { sessionId: 's1', windowSeconds: 10 }, {
      surface: 'agent',
      authority: 'account_automation',
      defaultSessionId: 's1',
    });
    expect(result).toEqual({
      ok: true,
      result: {
        ok: true,
        sessionId: 's1',
        presence: 'online',
        active: true,
        thinking: false,
        working: false,
        blocked: false,
        permissionRequired: false,
        actionRequired: false,
        updatedAt: null,
      },
    });
    expect(publishedPreview).toEqual({ sessionId: 's1', windowSeconds: 10 });
  });

  it('routes plugin dev-loop actions through one executor dependency on the agent surface', async () => {
    const pluginsDevLoopAction = vi.fn(async ({ actionId }) => ({
      kind: actionId.replaceAll('.', '_'),
      ok: true,
    }));
    const executor = createExecutor({ pluginsDevLoopAction } as any);

    for (const [actionId, input] of [
      ['plugins.list', {}],
      ['plugins.uninstall', { pluginId: 'acme.dev-loop' }],
    ] as const) {
      const result = await executor.execute(
        actionId as any,
        input,
        {
          surface: 'agent' as any,
          bypassApprovals: true,
          ...(actionId === 'plugins.uninstall'
            ? { authority: 'present_user' as const }
            : {}),
        },
      );

      expect(result).toEqual({
        ok: true,
        result: {
          kind: actionId.replaceAll('.', '_'),
          ok: true,
        },
      });
      expect(pluginsDevLoopAction).toHaveBeenCalledWith({
        actionId,
        input,
        context: expect.objectContaining({ surface: 'agent' }),
      });
    }
  });

  it.each(['rpc', 'cli', 'agent', 'mcp'] as const)('lists approval requests through the bounded approval artifact store on %s', async surface => {
    const approvalsList = vi.fn(async () => ({
      items: [
        {
          artifactId: 'a1',
          status: 'open',
          actionId: 'session.message.send',
          summary: 'Send message',
          updatedAtMs: 2,
        },
      ],
      queryPlan: {
        kind: 'approval_artifact_header_scan',
        hydratedTranscripts: false,
      },
    }));

    const executor = createExecutor({ approvalsList } as any);
    const res = await executor.execute(
      'approval.request.list' as any,
      { status: 'open', limit: 5 },
      { surface, serverId: 'server-1' },
    );

    expect(res).toEqual({
      ok: true,
      result: {
        items: [
          {
            artifactId: 'a1',
            status: 'open',
            actionId: 'session.message.send',
            summary: 'Send message',
            updatedAtMs: 2,
          },
        ],
        queryPlan: {
          kind: 'approval_artifact_header_scan',
          hydratedTranscripts: false,
        },
      },
    });
    expect(approvalsList).toHaveBeenCalledWith({
      status: 'open',
      limit: 5,
      serverId: 'server-1',
    });
  });

  it('binds public approval list reads to the external Session target', async () => {
    const approvalsList = vi.fn(async () => ({
      items: [],
      nextCursor: null,
      queryPlan: { kind: 'approval_artifact_header_scan', hydratedTranscripts: false },
    }));
    const executor = createExecutor({ approvalsList } as any);
    await executor.execute('approval.request.list' as any, { status: 'open' }, {
      surface: 'ui', externalActionTarget: { kind: 'session', sessionId: 'mounted-session' },
    });
    expect(approvalsList).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'mounted-session' }));
  });

  it.each(['rpc', 'cli', 'agent', 'mcp'] as const)('gets approval requests through the keyed approval artifact dependency on %s', async surface => {
    const request = createApprovalRequest();
    const approvalsGet = vi.fn(async () => request);

    const executor = createExecutor({ approvalsGet });
    const res = await executor.execute(
      'approval.request.get' as any,
      { artifactId: 'a1' },
      { surface, serverId: 'server-1' },
    );

    expect(res).toEqual({
      ok: true,
      result: {
        artifactId: 'a1',
        request,
        queryPlan: {
          kind: 'approval_artifact_id_lookup',
          backingStore: 'ArtifactStore',
          boundedBy: 'approval artifact id',
          hydratedTranscripts: false,
        },
      },
    });
    expect(approvalsGet).toHaveBeenCalledWith({ artifactId: 'a1', serverId: 'server-1' });
  });

  it.each(['ui', 'cli'] as const)('reads a first-use registry install approval through the public %s Action', async surface => {
    const actionId = 'agents.acp.backends.installFromRegistry';
    const fromRegistry = { sourceId: 'builtin:acp-registry', itemId: 'codex-acp', version: '2.2.2' };
    const actionArgs = getActionSpec(actionId).inputSchema.parse({ fromRegistry });
    const request = ApprovalRequestV2Schema.parse(createApprovalRequest('open', { actionId, actionArgs }));
    // The private Artifact read is the persistence boundary; public projection,
    // Action dispatch and strict output validation retain their real wiring.
    const executor = createExecutor({ approvalsGet: async () => request });
    const response = await executor.execute('approval.request.get', { artifactId: 'first-use' }, { surface });
    expect(response).toMatchObject({ ok: true, result: { request: { v: 2, actionId, actionArgs } } });
    if (!response.ok) throw new Error(response.errorCode);
    expect(getActionSpec('approval.request.get').outputSchema.parse(response.result)).toMatchObject({
      request: { actionArgs: { fromRegistry } },
    });
  });

  it('does not disclose an approval outside the external Session target', async () => {
    const approvalsGet = vi.fn(async () => createApprovalRequest('open', {
      createdBy: { surface: 'mcp', sessionId: 'other-session' },
    }));
    const executor = createExecutor({ approvalsGet });
    const res = await executor.execute('approval.request.get' as any, { artifactId: 'a1' }, {
      surface: 'ui', externalActionTarget: { kind: 'session', sessionId: 'mounted-session' },
    });
    expect(res).toEqual({ ok: false, errorCode: 'approval_not_found', error: 'approval_not_found' });
  });

  it('reads released V1 approval history without publishing unknown retained authority fields', async () => {
    // V1's released reader preserves unknown stored fields; that does not make
    // those fields public display metadata or current replay authority.
    const request = ApprovalRequestV1Schema.parse({
      v: 1, status: 'open', createdAtMs: 1, updatedAtMs: 1, createdBy: { surface: 'cli' },
      actionId: 'session.message.send', actionArgs: { sessionId: 's1', message: 'hello' }, summary: 'Send message',
      retainedCredential: 'synthetic-legacy-private-authority',
      executionOriginV1: { externalActionExecutionAuthorization: { token: 'synthetic-legacy-private-authority' } },
    });
    const executor = createExecutor({ approvalsGet: async () => request });
    const response = await executor.execute('approval.request.get', { artifactId: 'legacy' }, { surface: 'cli' });
    expect(response).toMatchObject({ ok: true, result: { request: {
      v: 1, actionId: request.actionId, actionArgs: request.actionArgs, summary: request.summary,
    } } });
    expect(JSON.stringify(response)).not.toContain('synthetic-legacy-private-authority');
    expect(request).toHaveProperty('retainedCredential', 'synthetic-legacy-private-authority');
  });

  it('reads released V1 approval history through the current token observation policy', async () => {
    const request = ApprovalRequestV1Schema.parse({
      v: 1, status: 'executed', createdAtMs: 1, updatedAtMs: 3, createdBy: { surface: 'cli' },
      actionId: 'account.apiTokens.create', actionArgs: { tokenId: securityTokenSummary.tokenId, label: 'Requested embed' },
      summary: 'Create token', decision: { kind: 'approve', decidedAtMs: 2 },
      execution: { executedAtMs: 3, ok: true, result: { apiToken: securityTokenSummary, token: securityToken } },
    });
    const executor = createExecutor({ approvalsGet: async () => request });
    const response = await executor.execute('approval.request.get', { artifactId: 'legacy-token' }, { surface: 'mcp' });
    expect(response).toMatchObject({ ok: true, result: { request: {
      execution: { result: { apiToken: securityTokenSummary } },
    } } });
    expect(JSON.stringify(response).includes(securityToken)).toBe(false);
    if (!response.ok || typeof response.result !== 'object' || response.result === null) throw new Error('Expected approval read');
    const publicRequest = Reflect.get(response.result, 'request');
    expect(ApprovalRequestPublicSettlementSchema.parse(publicRequest)).toMatchObject({ actionId: request.actionId,
      status: 'executed', execution: { ok: true, result: { apiToken: securityTokenSummary } } });
    expect(ApprovalRequestPublicSettlementSchema.safeParse({ ...publicRequest, status: 'open' }).success).toBe(false);
    expect(ApprovalRequestPublicSettlementSchema.safeParse({ ...publicRequest, status: 'failed' }).success).toBe(false);
    expect(request.execution?.result).toHaveProperty('token', securityToken);
  });

  it('reads released V1 approval history through the current credential input observation policy', async () => {
    const input = { password: 'synthetic-legacy-password', reauthenticationProof: 'synthetic-legacy-proof' };
    const request = ApprovalRequestV1Schema.parse({
      v: 1, status: 'approved', createdAtMs: 1, updatedAtMs: 2, createdBy: { surface: 'cli' },
      actionId: 'account.password.change', actionArgs: input, summary: 'Change password',
      origin: { kind: 'transcript_tool_call', sessionId: 's1', toolName: 'action_execute', toolInput: { actionId: 'account.password.change', input } },
      preview: { actionArgs: input }, decision: { kind: 'approve', decidedAtMs: 2, narrowedInput: input },
    });
    const executor = createExecutor({ approvalsGet: async () => request });
    const response = await executor.execute('approval.request.get', { artifactId: 'legacy-password' }, { surface: 'cli' });
    expect(response).toMatchObject({ ok: true, result: { request: { actionId: request.actionId, actionArgs: {} } } });
    expect(JSON.stringify(response)).not.toContain('synthetic-legacy-password');
    expect(JSON.stringify(response)).not.toContain('synthetic-legacy-proof');
    expect(request.actionArgs).toEqual(input);
  });

  it.each(['cli', 'agent', 'mcp'] as const)('discovers both approval reads through real %s Action search', async surface => {
    const result = await createExecutor().execute('action.spec.search', { query: 'approval', limit: 100 }, { surface });
    expect(result).toMatchObject({ ok: true, result: { actionSpecs: expect.arrayContaining([
      expect.objectContaining({ id: 'approval.request.list' }), expect.objectContaining({ id: 'approval.request.get' }),
    ]) } });
  });

  it('does not route non-surfaced actions through approvals even when a policy requires approvals', async () => {
    const approvalsCreate = vi.fn(async () => ({ artifactId: 'a1' }));

    const executor = createExecutor({
      approvalsCreate,
      isActionApprovalRequired: (actionId, ctx) => actionId === 'ui.voice_global.reset' && ctx.surface === 'cli',
    } as any);

    const res = await executor.execute(
      'ui.voice_global.reset' as any,
      {},
      { surface: 'cli' },
    );

    expect(res).toEqual(expect.objectContaining({
      ok: false,
      errorCode: 'action_disabled',
      error: 'action_disabled',
      details: expect.objectContaining({
        actionId: 'ui.voice_global.reset',
        surface: 'cli',
        reason: 'unsupported_surface',
      }),
    }));
    expect(approvalsCreate).not.toHaveBeenCalled();
  });

  it('routes actions through approvals when required by the caller policy', async () => {
    const approvalsCreate = vi.fn(async () => ({ artifactId: 'a1' }));
    const sessionSendMessage = vi.fn(async () => ({ status: 'accepted' as const, localId: 'local-1' }));

    const executor = createExecutor({
      approvalsCreate,
      sessionSendMessage,
      isActionApprovalRequired: (actionId, ctx) => actionId === 'session.message.send' && ctx.surface === 'mcp',
    } as any);

    const res = await executor.execute(
      'session.message.send' as any,
      { sessionId: 's1', message: 'hello' },
      { surface: 'mcp' },
    );

    expect(res.ok).toBe(true);
    expect(sessionSendMessage).not.toHaveBeenCalled();
    expect(approvalsCreate).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({
        actionId: 'session.message.send',
        summary: expect.stringContaining('Send a message'),
        createdBy: expect.objectContaining({ surface: 'mcp', sessionId: 's1' }),
      }),
    }));
    expect((res as any).result?.kind).toBe('approval_request_created');
    expect((res as any).result?.artifactId).toBe('a1');
  });

  it('puts the Action-owned human summary in the canonical approval preview', async () => {
    const approvalsCreate = vi.fn(async () => ({ artifactId: 'a1' }));
    const executor = createExecutor({
      approvalsCreate,
      isActionApprovalRequired: (actionId, ctx) => actionId === 'session.message.send' && ctx.surface === 'mcp',
    } as any);

    await executor.execute(
      'session.message.send' as any,
      { sessionId: 's1', message: 'hello' },
      { surface: 'mcp' },
    );

    const produced = approvalsCreate.mock.calls[0]?.[0]?.request;
    const consumed = ApprovalRequestV2Schema.parse(produced);
    expect(consumed.summary).toBe('Send a message to the agent in a session.');
    expect(consumed.preview).toEqual(expect.objectContaining({
      summary: 'Send a message to the agent in a session.',
    }));
    expect(ApprovalRequestV2Schema.safeParse({
      ...produced,
      unknownField: true,
    }).success).toBe(false);
  });

  it('uses host-provided approval preview metadata for plugin installs', async () => {
    const approvalsCreate = vi.fn(async () => ({ artifactId: 'a1' }));
    const buildApprovalPreview = vi.fn(async ({ actionId, input }) => ({
      pluginInstall: {
        actionId,
        path: (input as any).path,
        plugin: {
          id: 'acme.dev-loop',
          version: '1.0.0',
          title: 'Acme Dev Loop',
        },
        provenance: {
          sourceKind: 'path',
        },
        permissions: {
          required: ['network'],
          optional: ['filesystem.read'],
        },
      },
    }));
    const executor = createExecutor({
      approvalsCreate,
      buildApprovalPreview,
      isActionApprovalRequired: (actionId, ctx) => actionId === 'plugins.install' && ctx.surface === 'agent',
    } as any);

    const res = await executor.execute(
      'plugins.install' as any,
      { path: '/tmp/acme-dev-loop', dev: true },
      { surface: 'agent' as any, authority: 'present_user' },
    );

    expect(res.ok).toBe(true);
    expect(buildApprovalPreview).toHaveBeenCalledWith({
      actionId: 'plugins.install',
      input: { path: '/tmp/acme-dev-loop', dev: true },
      context: expect.objectContaining({ surface: 'agent' }),
      defaultPreview: {
        actionId: 'plugins.install',
        actionArgs: { path: '/tmp/acme-dev-loop', dev: true },
        summary: expect.any(String),
      },
    });
    expect(approvalsCreate).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({
        actionId: 'plugins.install',
        preview: expect.objectContaining({
          summary: expect.any(String),
          pluginInstall: expect.objectContaining({
            plugin: {
              id: 'acme.dev-loop',
              version: '1.0.0',
              title: 'Acme Dev Loop',
            },
            provenance: expect.objectContaining({ sourceKind: 'path' }),
            permissions: {
              required: ['network'],
              optional: ['filesystem.read'],
            },
          }),
        }),
      }),
    }));
  });

  it('does not persist an explicit approval request after preview cancellation', async () => {
    const controller = new AbortController();
    const approvalsCreate = vi.fn(async () => ({ artifactId: 'must-not-exist' }));
    const executor = createExecutor({
      approvalsCreate,
      buildApprovalPreview: async ({ defaultPreview }) => {
        controller.abort();
        return defaultPreview;
      },
    });

    await expect(executor.execute('approval.request.create' as any, {
      actionId: 'session.message.send',
      actionArgs: { sessionId: 's1', message: 'hello' },
      summary: 'Send message',
      createdBy: { surface: 'system' },
    }, {
      surface: 'mcp',
      signal: controller.signal,
    })).resolves.toEqual({
      ok: false,
      errorCode: 'cancelled',
      error: 'cancelled',
    });
    expect(approvalsCreate).not.toHaveBeenCalled();
  });

  it('returns a failed domain preparation without creating an unrepresentable approval', async () => {
    const approvalsCreate = vi.fn(async () => ({ artifactId: 'must-not-exist' }));
    const failure = { ok: false as const, errorCode: 'install_unavailable', error: 'Exact source is unavailable' };
    const executor = createExecutor({ approvalsCreate, buildApprovalPreview: async () => failure });
    await expect(executor.execute('approval.request.create', {
      actionId: 'plugins.install', actionArgs: { path: '@acme/external', kind: 'npm' },
      summary: 'Install plugin', createdBy: { surface: 'system' },
    }, { surface: 'mcp' })).resolves.toEqual(failure);
    expect(approvalsCreate).not.toHaveBeenCalled();
  });

  it('records transcript tool-call origin metadata on policy-created approvals', async () => {
    const approvalsCreate = vi.fn(async () => ({ artifactId: 'a1' }));
    const sessionSendMessage = vi.fn(async () => ({ status: 'accepted' as const, localId: 'local-1' }));

    const executor = createExecutor({
      approvalsCreate,
      sessionSendMessage,
      isActionApprovalRequired: (actionId, ctx) => actionId === 'session.message.send' && ctx.surface === 'agent',
    } as any);

    const res = await executor.execute(
      'session.message.send' as any,
      { sessionId: 's1', message: 'hello' },
      {
        surface: 'agent',
        defaultSessionId: 's1',
        callerPermissionMode: 'yolo',
        causalPermissionAuthority: {
          kind: 'admittedSessionInputV1',
          admittedPermissionCeiling: 'read-only',
        },
        sessionInputSource: {
          sourceSessionId: 's1',
          sourceTurnId: 'turn-1',
          via: 'action',
        },
        approvalOrigin: {
          kind: 'transcript_tool_call',
          sessionId: 's1',
          toolCallId: 'tool-1',
          toolName: 'session_message_send',
          toolInput: { sessionId: 's1', message: 'hello' },
        },
      } as any,
    );

    expect(res.ok).toBe(true);
    expect(sessionSendMessage).not.toHaveBeenCalled();
    expect(approvalsCreate).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({
        actionId: 'session.message.send',
        origin: {
          kind: 'transcript_tool_call',
          sessionId: 's1',
          toolCallId: 'tool-1',
          toolName: 'session_message_send',
          toolInput: { sessionId: 's1', message: 'hello' },
        },
      }),
    }));
  });

  it('rejects a policy-created cross-session Agent approval before persistence when its source witness is missing', async () => {
    const approvalsCreate = vi.fn(async () => ({ artifactId: 'must-not-exist' }));
    const sessionSendMessage = vi.fn(async () => ({ status: 'accepted' as const, localId: 'local-1' }));

    const executor = createExecutor({
      approvalsCreate,
      sessionSendMessage,
      isActionApprovalRequired: (actionId, ctx) => actionId === 'session.message.send' && ctx.surface === 'agent',
    } as any);

    const res = await executor.execute(
      'session.message.send' as any,
      { sessionId: 'target-session', message: 'hello target' },
      {
        surface: 'agent',
        defaultSessionId: 'requesting-session',
        callerPermissionMode: 'yolo',
        causalPermissionAuthority: {
          kind: 'admittedSessionInputV1',
          admittedPermissionCeiling: 'read-only',
        },
      } as any,
    );

    expect(res).toEqual({
      ok: false,
      errorCode: 'causal_permission_authority_invalid',
      error: 'causal_permission_authority_invalid',
    });
    expect(approvalsCreate).not.toHaveBeenCalled();
    expect(sessionSendMessage).not.toHaveBeenCalled();
  });

  it('lets the message owner authorize a policy-created cross-session Agent approval with a host-stamped source witness', async () => {
    const approvalsCreate = vi.fn(async () => ({ artifactId: 'a1' }));
    const sessionSendMessage = vi.fn(async () => ({ status: 'accepted' as const, localId: 'local-1' }));

    const executor = createExecutor({
      approvalsCreate,
      sessionSendMessage,
      isActionApprovalRequired: (actionId, ctx) => actionId === 'session.message.send' && ctx.surface === 'agent',
    } as any);

    const res = await executor.execute(
      'session.message.send' as any,
      { sessionId: 'target-session', message: 'hello target' },
      {
        surface: 'agent',
        defaultSessionId: 'requesting-session',
        callerPermissionMode: 'yolo',
        causalPermissionAuthority: {
          kind: 'admittedSessionInputV1',
          admittedPermissionCeiling: 'read-only',
        },
        sessionInputSource: {
          sourceSessionId: 'requesting-session',
          sourceTurnId: 'turn-cross-session',
          via: 'action',
        },
        approvalOrigin: {
          kind: 'transcript_tool_call',
          sessionId: 'requesting-session',
          toolCallId: 'tool-cross-session',
          toolName: 'session_message_send',
          toolInput: { sessionId: 'target-session', message: 'hello target' },
        },
      } as any,
    );

    expect(res).toMatchObject({
      ok: true,
      result: { kind: 'approval_request_created', artifactId: 'a1' },
    });
    expect(sessionSendMessage).not.toHaveBeenCalled();
    expect(approvalsCreate).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({
        actionId: 'session.message.send',
        actionArgs: { sessionId: 'target-session', message: 'hello target' },
        createdBy: expect.objectContaining({
          surface: 'agent',
          sessionId: 'requesting-session',
        }),
        origin: expect.objectContaining({
          kind: 'transcript_tool_call',
          sessionId: 'requesting-session',
          toolCallId: 'tool-cross-session',
          toolName: 'session_message_send',
        }),
        executionOriginV1: expect.objectContaining({
          causalPermissionAuthority: {
            kind: 'admittedSessionInputV1',
            admittedPermissionCeiling: 'read-only',
          },
          sessionInputSource: {
            sourceSessionId: 'requesting-session',
            sourceTurnId: 'turn-cross-session',
            via: 'action',
          },
        }),
      }),
    }));
  });

  it('records createdBy.surface=cli when approvals are created from the CLI surface', async () => {
    const approvalsCreate = vi.fn(async () => ({ artifactId: 'a1' }));
    const sessionSendMessage = vi.fn(async () => ({ status: 'accepted' as const, localId: 'local-1' }));

    const executor = createExecutor({
      approvalsCreate,
      sessionSendMessage,
      isActionApprovalRequired: (actionId, ctx) => actionId === 'session.message.send' && ctx.surface === 'cli',
    });

    const res = await executor.execute(
      'session.message.send' as any,
      { sessionId: 's1', message: 'hello' },
      { surface: 'cli' },
    );

    expect(res.ok).toBe(true);
    expect(sessionSendMessage).not.toHaveBeenCalled();
    expect(approvalsCreate).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({
        createdBy: expect.objectContaining({ surface: 'cli', sessionId: 's1' }),
      }),
    }));
  });

  it('marks approval requests created from the CLI surface as createdBy.surface=cli', async () => {
    const approvalsCreate = vi.fn(async () => ({ artifactId: 'a1' }));

    const executor = createExecutor({
      approvalsCreate,
      isActionApprovalRequired: (actionId, ctx) => actionId === 'session.message.send' && ctx.surface === 'cli',
    } as any);

    const res = await executor.execute(
      'session.message.send' as any,
      { sessionId: 's1', message: 'hello' },
      { surface: 'cli' },
    );

    expect(res.ok).toBe(true);
    expect(approvalsCreate).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({
        createdBy: expect.objectContaining({ surface: 'cli', sessionId: 's1' }),
      }),
    }));
  });

  it('routes eligible actions through approvals when required by the caller policy', async () => {
    const approvalsCreate = vi.fn(async () => ({ artifactId: 'a1' }));
    const executionRunStart = vi.fn(async () => ({ ok: true }));

    const executor = createExecutor({
      approvalsCreate,
      executionRunStart,
      isActionApprovalRequired: (actionId) => actionId === 'review.start',
    } as any);

    const res = await executor.execute(
      'review.start' as any,
      { sessionId: 's1', engineIds: ['x'], instructions: 'y' },
      { surface: 'cli' },
    );

    expect(res.ok).toBe(true);
    expect(executionRunStart).not.toHaveBeenCalled();
    expect((res as any).result?.kind).toBe('approval_request_created');
    expect((res as any).result?.artifactId).toBe('a1');
  });

  it.each([
    {
      name: 'approval storage is unavailable',
      overrides: {},
      context: { surface: 'cli' as const, actionCaller: { kind: 'host' as const } },
    },
    {
      name: 'plugin approval provenance is incomplete',
      overrides: { approvalsCreate: vi.fn(async () => ({ artifactId: 'a1' })) },
      context: {
        surface: 'plugin' as const,
        actionCaller: { kind: 'plugin' as const, pluginId: 'acme.plugin' },
      },
    },
  ])('classifies $name before execution.run.start dispatch as noRunCreated', async ({ overrides, context }) => {
    const executionRunStart = vi.fn(async () => ({
      runId: 'run-1',
      callId: 'call-1',
      sidechainId: 'sidechain-1',
    }));
    const executor = createExecutor({
      executionRunStart,
      isActionApprovalRequired: (actionId) => actionId === 'execution.run.start',
      ...overrides,
    });

    await expect(executor.execute('execution.run.start' as any, {
      sessionId: 's1',
      intent: 'delegate',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      instructions: 'Inspect the change.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
    }, context)).resolves.toEqual({
      ok: false,
      errorCode: context.surface === 'plugin'
        ? 'plugin_action_caller_required'
        : 'approvals_not_supported',
      error: context.surface === 'plugin'
        ? 'plugin_action_caller_required'
        : 'approvals_not_supported',
      details: { executionRunStart: { v: 1, runCreation: 'noRunCreated' } },
    });
    expect(executionRunStart).not.toHaveBeenCalled();
  });

  it.each(['cli', 'mcp'] as const)('routes %s approval custody without executing when no live waiter is available', async (surface) => {
    const approvalsCreate = vi.fn(async () => ({ artifactId: 'a1' }));
    const agentsBackendsList = vi.fn(async () => ({ items: [] }));

    const executor = createExecutor({
      approvalsCreate,
      agentsBackendsList,
      isActionApprovalRequired: (actionId) => actionId === 'agents.backends.list',
    } as any);

    const res = await executor.execute(
      'agents.backends.list' as any,
      {},
      { surface },
    );

    expect(res).toEqual(surface === 'cli'
      ? { ok: true, result: { kind: 'approval_request_created', artifactId: 'a1', actionId: 'agents.backends.list' } }
      : { ok: false, errorCode: 'approvals_not_supported', error: 'approvals_not_supported' });
    expect(agentsBackendsList).not.toHaveBeenCalled();
    expect(approvalsCreate).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({
        actionId: 'agents.backends.list',
        approval: { flow: surface === 'cli' ? 'deferred' : 'blocking', result: 'required' },
        createdBy: expect.objectContaining({ surface }),
      }),
    }));
  });

  it('defers API policy approvals even when the Action normally has a blocking result', async () => {
    const approvalsCreate = vi.fn(async () => ({ artifactId: 'api-approval-1' }));
    const approvalsUpdate = vi.fn(async () => ({ ok: true as const }));
    const approvalsWaitForDecision = vi.fn(async () => {
      throw new Error('external API approvals must not wait for a decision');
    });

    const executor = createExecutor({
      approvalsCreate,
      approvalsUpdate,
      approvalsWaitForDecision,
      isActionApprovalRequired: (actionId, ctx) => actionId === 'action.spec.search' && ctx.surface === 'api',
    });

    await expect(executor.execute(
      'action.spec.search',
      { query: 'approval', limit: 1 },
      {
        surface: 'api',
        authority: 'account_automation',
        actionCaller: { kind: 'host' },
        externalActionCredential: { accountId: 'account-1', principalId: 'account-1', credentialId: 'credential-1', grant: API_TOKEN_FULL_GRANT_V1 },
        externalActionTarget: { kind: 'machine', machineId: 'machine-1' },
        externalActionExecutionAuthorization: {
          v: 1,
          token: 'invocation-authorization',
          binding: {
            serverIdentityId: 'server-1',
            accountId: 'account-1',
            principalId: 'account-1',
            credentialId: 'credential-1',
            grant: API_TOKEN_FULL_GRANT_V1,
            machineId: 'machine-1',
            custodianAccountId: 'account-1',
            installationId: 'installation-1',
            actionId: 'action.spec.search',
            requestId: 'test-request:action.spec.search',
            requestEnvelopeDigest: 'a'.repeat(43),
            target: { kind: 'machine', machineId: 'machine-1' },
          },
        },
        signExternalActionApprovalInput: () => 'a'.repeat(86),
      },
    )).resolves.toEqual({
      ok: true,
      result: {
        kind: 'approval_request_created',
        artifactId: 'api-approval-1',
        actionId: 'action.spec.search',
      },
    });
    expect(approvalsWaitForDecision).not.toHaveBeenCalled();
    expect(approvalsCreate).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({
        actionId: 'action.spec.search',
        approval: { flow: 'deferred', result: 'required' },
      }),
    }));
  });

  it.each([false, true])('executes deferred CLI authentication on the daemon after its caller exits (nativeFailure=%s)', async nativeFailure => {
    let stored: ApprovalRequest | null = null;
    const persisted: ApprovalRequest[] = [];
    const effects: unknown[] = [];
    const boundary: Partial<ActionExecutorDeps> = {
      approvalsCreate: async ({ request }) => { stored = ApprovalRequestSchema.parse(request); return { artifactId: 'detached-connect' }; },
      approvalsGet: async () => stored,
      approvalsUpdate: async ({ request }) => {
        if (!stored) throw new Error('Missing approval');
        const next = ApprovalRequestSchema.parse(request);
        const transition = decideApprovalRequestTransition(stored, next);
        if (!transition.ok) return transition;
        stored = next; persisted.push(next); return { ok: true };
      },
      // The native service transport is the boundary. New daemon composition
      // below shares durable Artifact storage, never the original CLI closure.
      connectedServiceAction: async ({ input }) => {
        effects.push(input);
        if (nativeFailure) throw Object.assign(new Error('Service unavailable'), { code: 'connected_account_service_unavailable' });
        return { status: 'awaitingManual', attemptId: 'connected-attempt' };
      },
      approvalsWaitForDecision: async () => { throw new Error('Deferred CLI requests must not retain a waiter'); },
    };
    const caller = new AbortController();
    const input = { machineId: 'machine-1', service: { pluginId: 'example.accounts', localId: 'service' }, modeId: 'manual' };
    const context = { surface: 'cli' as const, authority: 'present_user' as const,
      actionCaller: { kind: 'host' as const }, runtimeAccountId: 'account-1', serverId: 'server-1',
      serverIdentityId: 'srv_home', actionRequestId: 'detached-connect', signal: caller.signal,
      actionsSettings: ActionsSettingsV1Schema.parse({ v: 1, actions: {
        'connectedServices.authentication.beginConnect': { approvalRequiredSurfaces: ['cli'] },
      } }) };
    expect(await createExecutor(boundary).execute('connectedServices.authentication.beginConnect', input, context))
      .toMatchObject({ ok: true, result: { kind: 'approval_request_created', artifactId: 'detached-connect' } });
    expect(effects).toEqual([]);
    caller.abort();
    const decision = await createExecutor(boundary).execute('approval.request.decide', {
      artifactId: 'detached-connect', decision: 'approve',
    }, { surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' },
      runtimeAccountId: 'account-1', serverId: 'server-1', serverIdentityId: 'srv_home' });
    expect(decision, JSON.stringify(decision)).toMatchObject({ ok: true, result: {
      status: nativeFailure ? 'failed' : 'executed', execution: { ok: !nativeFailure },
    } });
    expect(effects).toEqual([input]);
    expect(JSON.stringify(persisted)).not.toContain('RPC_TRANSPORT_UNAVAILABLE');
    expect(stored).toMatchObject({ status: nativeFailure ? 'failed' : 'executed', execution: { ok: !nativeFailure } });
    const collected = await createExecutor(boundary).execute('approval.request.get', {
      artifactId: 'detached-connect',
    }, { surface: 'cli', authority: 'present_user', runtimeAccountId: 'account-1', serverId: 'server-1' });
    expect(collected).toMatchObject({ ok: true, result: { request: {
      status: nativeFailure ? 'failed' : 'executed',
      execution: nativeFailure
        ? { ok: false, errorCode: 'action_failed' }
        : { ok: true, result: { status: 'awaitingManual', attemptId: 'connected-attempt' } },
    } } });
  });

  it('keeps a present-user invitation approval on its live mounted invocation', async () => {
    const approvalsCreate = vi.fn(async () => ({ artifactId: 'ui-home-approval-1' }));
    const approvalsUpdate = vi.fn(async () => ({ ok: true as const }));
    const approvalsWaitForDecision = vi.fn(async ({ request }: { request: ApprovalRequest }) => ({
      decision: 'reject' as const,
      request: {
        ...request,
        status: 'rejected' as const,
        decision: { kind: 'reject' as const, decidedAtMs: 2 },
      },
    }));
    const homeDomainAction = vi.fn(async () => {
      throw new Error('the mutation must remain gated until the approval owner replays it');
    });
    const executor = createExecutor({
      approvalsCreate,
      approvalsUpdate,
      approvalsWaitForDecision,
      homeDomainAction,
      isActionApprovalRequired: (actionId, context) => (
        actionId === 'teams.invitations.create'
        && context.surface === 'ui'
        && context.authority === 'present_user'
      ),
    } as any);

    await expect(executor.execute(
      'teams.invitations.create' as any,
      {
        v: 1,
        teamId: 'team-1',
        role: 'member',
        historyAccess: 'from_membership',
        recipientEmail: null,
        requestKey: 'invite-request-1',
      },
      {
        surface: 'ui',
        authority: 'present_user',
        actionCaller: { kind: 'host' },
        runtimeAccountId: 'account-1',
      },
    )).resolves.toMatchObject({ ok: false, errorCode: 'approval_rejected' });
    expect(approvalsWaitForDecision).toHaveBeenCalledTimes(1);
    expect(homeDomainAction).not.toHaveBeenCalled();
    expect(approvalsCreate).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({
        actionId: 'teams.invitations.create',
        requestedSurface: 'ui',
        executionOriginV1: expect.objectContaining({
          authority: 'present_user',
          surface: 'ui',
          accountId: 'account-1',
        }),
        approval: { flow: 'blocking', result: 'required' },
      }),
    }));
  });

  it('returns an approved invitation bearer to the live invocation but never writes it to the Artifact', async () => {
    const invitation = {
      id: 'invitation-live-1',
      teamId: 'team-1',
      state: 'active' as const,
      role: 'member' as const,
      historyAccess: 'from_membership' as const,
      recipientEmailMask: null,
      expiresAt: 2,
      createdAt: 1,
      createdByAccountId: 'account-1',
      acceptedByAccountId: null,
      lastEmailDelivery: null,
    };
    const rawResult = {
      invitation,
      joinUrl: 'https://home.example/join/live-only-bearer',
    };
    const persisted: ApprovalRequest[] = [];
    const approvalsUpdate = vi.fn(async ({ request }: { request: ApprovalRequest }) => {
      persisted.push(request);
      return { ok: true as const };
    });
    const executor = createExecutor({
      approvalsCreate: vi.fn(async () => ({ artifactId: 'ui-live-invitation-approval' })),
      approvalsUpdate,
      approvalsWaitForDecision: vi.fn(async ({ request }: { request: ApprovalRequest }) => ({
        decision: 'approve' as const,
        request: {
          ...request,
          status: 'approved' as const,
          decision: { kind: 'approve' as const, decidedAtMs: 2 },
        },
      })),
      homeDomainAction: vi.fn(async () => rawResult),
      isActionApprovalRequired: (actionId, context) => (
        actionId === 'teams.invitations.create'
        && context.surface === 'ui'
        && context.authority === 'present_user'
      ),
    } as any);

    await expect(executor.execute('teams.invitations.create' as any, {
      v: 1,
      teamId: 'team-1',
      role: 'member',
      historyAccess: 'from_membership',
      recipientEmail: null,
      requestKey: 'invite-live-request-1',
    }, {
      surface: 'ui',
      authority: 'present_user',
      actionCaller: { kind: 'host' },
      runtimeAccountId: 'account-1',
    })).resolves.toEqual({ ok: true, result: rawResult });

    const terminal = persisted.at(-1);
    expect(terminal?.execution).toEqual({
      executedAtMs: expect.any(Number),
      effectAttempted: true,
      ok: true,
      result: { invitation, joinUrl: null },
    });
    expect(JSON.stringify(persisted)).not.toContain('live-only-bearer');
  });

  it('waits for a blocking approval and returns the underlying action result when approved', async () => {
    const cancellation = new AbortController();
    const approvalsCreate = vi.fn(async () => ({ artifactId: 'a1' }));
    const approvalsUpdate = vi.fn(async () => ({ ok: true as const }));
    const sessionList = vi.fn(async () => ({
      sessions: [{ id: 's1', active: false, presence: 'offline', updatedAt: 1, title: 'One' }],
      nextCursor: null,
    }));
    const approvalsWaitForDecision = vi.fn(async ({ request }: { request: ApprovalRequest }) => {
      expect(sessionList).not.toHaveBeenCalled();
      return {
        decision: 'approve' as const,
        request: {
          ...request,
          status: 'approved' as const,
          decision: { kind: 'approve' as const, decidedAtMs: 2 },
        },
      };
    });

    const executor = createExecutor({
      approvalsCreate,
      approvalsUpdate,
      approvalsWaitForDecision,
      sessionList,
      isActionApprovalRequired: (actionId) => actionId === 'session.list',
    } as any);

    const res = await executor.execute(
      'session.list' as any,
      { limit: 10 },
      { surface: 'mcp', signal: cancellation.signal },
    );

    expect(res).toEqual({
      ok: true,
      result: {
        sessions: [{ id: 's1', active: false, presence: 'offline', updatedAt: 1, title: 'One' }],
        nextCursor: null,
      },
    });
    expect(approvalsWaitForDecision).toHaveBeenCalledWith(expect.objectContaining({
      artifactId: 'a1',
      request: expect.objectContaining({
        actionId: 'session.list',
        approval: { flow: 'blocking', result: 'required' },
      }),
      serverId: 'server-1',
      signal: cancellation.signal,
    }));
    expect(sessionList).toHaveBeenCalledWith(expect.objectContaining({
      limit: 10,
      serverId: 'server-1',
      signal: cancellation.signal,
      context: expect.objectContaining({
        authority: 'account_automation',
        surface: 'mcp',
        bypassApprovals: true,
      }),
    }));
    expect(approvalsUpdate).toHaveBeenCalledWith(expect.objectContaining({
      artifactId: 'a1',
      request: expect.objectContaining({
        status: 'executed',
        execution: expect.objectContaining({
          ok: true,
          result: {
            sessions: [{ id: 's1', active: false, presence: 'offline', updatedAt: 1, title: 'One' }],
            nextCursor: null,
          },
        }),
      }),
    }));
  });

  it('cancels a blocking approval without invoking the target Action', async () => {
    const cancellation = new AbortController();
    const coordinator = createBlockingApprovalCoordinator();
    const sessionList = vi.fn(async () => ({ sessions: [], nextCursor: null }));
    const approvalsUpdate = vi.fn(async () => ({ ok: true as const }));
    const executor = createExecutor({
      approvalsCreate: async () => ({ artifactId: 'a1' }),
      approvalsUpdate,
      approvalsWaitForDecision: async args => {
        const decision = await coordinator.waitForDecision(args);
        return { ...decision, request: ApprovalRequestSchema.parse(decision.request) };
      },
      sessionList,
    });

    const pending = executor.execute('session.list', { limit: 10 }, {
      surface: 'mcp', signal: cancellation.signal,
      actionsSettings: ActionsSettingsV1Schema.parse({ v: 1, actions: { 'session.list': { approvalRequiredSurfaces: ['mcp'] } } }),
    });
    await vi.waitFor(() => expect(coordinator.getLiveWaiterCount('a1')).toBe(1));
    cancellation.abort();
    expect(await pending).toMatchObject({ ok: false, errorCode: 'cancelled' });
    expect(sessionList).not.toHaveBeenCalled();
    expect(coordinator.getLiveWaiterCount('a1')).toBe(0);
    // Ending the observer does not withdraw the durable human decision.
    expect(approvalsUpdate).not.toHaveBeenCalled();
  });

  it('returns an already executed blocking approval result without re-executing the target action', async () => {
    const approvalsCreate = vi.fn(async () => ({ artifactId: 'a1' }));
    const approvalsUpdate = vi.fn(async () => ({ ok: true as const }));
    const recordedResult = {
      sessions: [{ id: 's1', active: false, presence: 'offline', updatedAt: 1, title: 'Recorded' }],
      nextCursor: null,
    };
    const sessionList = vi.fn(async () => ({
      sessions: [{ id: 's2', active: false, presence: 'offline', updatedAt: 1, title: 'Duplicate' }],
      nextCursor: null,
    }));
    const approvalsWaitForDecision = vi.fn(async ({ request }: { request: ApprovalRequest }) => ({
      decision: 'approve' as const,
      request: {
        ...request,
        status: 'executed' as const,
        decision: { kind: 'approve' as const, decidedAtMs: 2 },
        execution: { executedAtMs: 3, ok: true as const, result: recordedResult },
      },
    }));

    const executor = createExecutor({
      approvalsCreate,
      approvalsUpdate,
      approvalsWaitForDecision,
      sessionList,
      isActionApprovalRequired: (actionId) => actionId === 'session.list',
    } as any);

    const res = await executor.execute(
      'session.list' as any,
      { limit: 10 },
      { surface: 'mcp' },
    );

    expect(res).toEqual({ ok: true, result: recordedResult });
    expect(sessionList).not.toHaveBeenCalled();
    expect(approvalsUpdate).not.toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({ status: 'executed' }),
    }));
  });

  it.each(['approve', 'reject'] as const)('delivers a delayed %s to the original blocking call through the real coordinator', async decision => {
    const coordinator = createBlockingApprovalCoordinator();
    let storedRequest: ApprovalRequest | null = null;
    const approvalsCreate = vi.fn(async ({ request }: { request: ApprovalRequest }) => {
      storedRequest = ApprovalRequestSchema.parse(request);
      return { artifactId: 'a1' };
    });
    const approvalsGet = vi.fn(async () => storedRequest);
    const approvalsUpdate = vi.fn(async ({ request }: { request: ApprovalRequest }) => {
      if (!storedRequest) throw new Error('Missing approval');
      const next = ApprovalRequestSchema.parse(request);
      const transition = decideApprovalRequestTransition(storedRequest, next);
      if (!transition.ok) return transition;
      storedRequest = next;
      coordinator.notifyApprovalUpdated({ artifactId: 'a1', request: next });
      return { ok: true as const };
    });
    const sessionList = vi.fn(async () => ({
      sessions: [{ id: 's1', active: false, presence: 'offline', updatedAt: 1, title: 'One' }],
      nextCursor: null,
    }));

    const executor = createExecutor({
      approvalsCreate,
      approvalsGet,
      approvalsUpdate,
      approvalsResolveBlockingDecision: args => coordinator.resolveBlockingDecision(args),
      approvalsWaitForDecision: async args => {
        const answer = await coordinator.waitForDecision({ ...args, readRequest: approvalsGet,
          subscribeChanges: listener => coordinator.subscribeApprovalChanges(listener) });
        return { ...answer, request: ApprovalRequestSchema.parse(answer.request) };
      },
      sessionList,
    });

    let responseReceived = false;
    const blockingCall = executor.execute('session.list', {}, { surface: 'agent', authority: 'account_automation',
      actionsSettings: ActionsSettingsV1Schema.parse({ v: 1, actions: { 'session.list': { approvalRequiredSurfaces: ['agent'] } } }),
    })
      .then(result => { responseReceived = true; return result; });

    await vi.waitFor(() => expect(coordinator.getLiveWaiterCount('a1')).toBe(1));
    vi.useFakeTimers();
    try {
      // The human can answer after 30 seconds without another waiter or poll.
      await vi.advanceTimersByTimeAsync(30_000);
      expect(responseReceived).toBe(false);
      expect(sessionList).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
    const decideResult = await executor.execute('approval.request.decide', {
      artifactId: 'a1',
      decision,
    }, {
      surface: 'mcp',
      authority: 'present_user',
    });
    const blockingResult = await blockingCall;

    expect(decideResult.ok).toBe(true);
    expect(blockingResult).toEqual(decision === 'approve' ? {
      ok: true,
      result: {
        sessions: [{ id: 's1', active: false, presence: 'offline', updatedAt: 1, title: 'One' }],
        nextCursor: null,
      },
    } : { ok: false, errorCode: 'approval_rejected', error: 'approval_rejected' });
    await executor.execute('approval.request.decide', { artifactId: 'a1', decision }, {
      surface: 'mcp', authority: 'present_user',
    });
    expect(sessionList).toHaveBeenCalledTimes(decision === 'approve' ? 1 : 0);
    expect(coordinator.getLiveWaiterCount('a1')).toBe(0);
  });

  it('routes session.title.set through approvals when required by the caller policy', async () => {
    const approvalsCreate = vi.fn(async () => ({ artifactId: 'a1' }));
    const sessionStateFieldSet = vi.fn(async () => ({ ok: true }));

    const executor = createExecutor({
      approvalsCreate,
      sessionStateFieldSet,
      isActionApprovalRequired: (actionId) => actionId === 'session.title.set',
    } as any);

    const res = await executor.execute(
      'session.title.set' as any,
      { sessionId: 's1', title: 'Renamed' },
      { surface: 'mcp' },
    );

    expect(res.ok).toBe(true);
    expect((res as any).result?.kind).toBe('approval_request_created');
    expect((res as any).result?.artifactId).toBe('a1');
    expect(sessionStateFieldSet).not.toHaveBeenCalled();
    expect(approvalsCreate).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({
        actionId: 'session.title.set',
        createdBy: expect.objectContaining({ surface: 'mcp', sessionId: 's1' }),
      }),
    }));
  });

  it('allows approval.request.create for a non-internal, non-approval Action', async () => {
    const approvalsCreate = vi.fn(async () => ({ artifactId: 'a1' }));

    const executor = createExecutor({ approvalsCreate });

    const res = await executor.execute('approval.request.create' as any, {
      actionId: 'agents.backends.list',
      actionArgs: {},
      summary: 'List backends',
      createdBy: { surface: 'system' },
    });

    expect(res.ok).toBe(true);
    expect(approvalsCreate).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({
        actionId: 'agents.backends.list',
        summary: 'List agent backends.',
      }),
    }));
  });

  it.each(['cli', 'agent'] as const)('executes an approved %s session delete at the deciding app after its originating Session is stopped', async (surface) => {
    let storedRequest: ApprovalRequest | null = null;
    const homeDomainAction = vi.fn(async () => ({ success: true as const }));
    const executor = createExecutor({
      isActionApprovalRequired: (actionId, context) =>
        isApprovalRequiredByActionsSettings(actionId, defaultActionsSettings, context),
      approvalsCreate: async ({ request }) => {
        storedRequest = ApprovalRequestV2Schema.parse(request);
        return { artifactId: 'stopped-session-delete' };
      },
      approvalsGet: async () => storedRequest,
      approvalsUpdate: async ({ request }) => {
        if (!storedRequest) throw new Error('missing approval fixture');
        const parsed = ApprovalRequestV2Schema.parse(request);
        const transition = decideApprovalRequestTransition(storedRequest, parsed);
        if (!transition.ok) return transition;
        storedRequest = parsed;
        return { ok: true as const };
      },
      homeDomainAction,
    });

    await expect(executor.execute('session.delete', { sessionId: 'stopped-session' }, {
      surface, authority: 'account_automation', actionCaller: { kind: 'host' },
    })).resolves.toMatchObject({ ok: true, result: {
      kind: 'approval_request_created', artifactId: 'stopped-session-delete',
    } });
    expect(storedRequest).toMatchObject({ actionId: 'session.delete', actionArgs: { sessionId: 'stopped-session' },
      executionOriginV1: { surface, caller: { kind: 'host' } } });
    expect(storedRequest && requiresExactDaemonApprovalReplay(storedRequest)).toBe(false);
    expect(homeDomainAction).not.toHaveBeenCalled();

    await expect(executor.execute('approval.request.decide', {
      artifactId: 'stopped-session-delete', decision: 'approve',
    })).resolves.toMatchObject({ ok: true, result: { status: 'executed', execution: { ok: true } } });
    expect(homeDomainAction).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      actionId: 'session.delete', input: { sessionId: 'stopped-session' },
      context: expect.objectContaining({ surface: 'ui', authority: 'present_user' }),
    }));
  });

  it.each([
    {
      actionId: 'teams.invitations.accept.prepareApproval',
      actionArgs: { v: 1, token: 's'.repeat(43) },
    },
    {
      actionId: 'sessions.subagents.upsert',
      actionArgs: {
        id: 'subagent-1',
        parentSessionId: 's1',
        origin: 'agent',
        kind: 'native',
        status: 'running',
      },
    },
  ] as const)('rejects a public approval request targeting internal Action $actionId', async ({ actionId, actionArgs }) => {
    const persistedRequests: ApprovalRequest[] = [];
    const approvalsCreate = vi.fn(async ({ request }: { request: ApprovalRequest }) => {
      persistedRequests.push(request);
      return { artifactId: 'must-not-exist' };
    });
    const homeDomainAction = vi.fn(async () => ({ outcome: 'ok' as const }));
    const executor = createExecutor({ approvalsCreate, homeDomainAction } as any);

    await expect(executor.execute('approval.request.create', {
      actionId,
      actionArgs,
      summary: 'Approve internal host work',
      createdBy: { surface: 'system' },
    }, {
      surface: 'mcp',
      authority: 'account_automation',
      actionCaller: { kind: 'host' },
    })).resolves.toEqual({
      ok: false,
      errorCode: 'invalid_parameters',
      error: 'invalid_parameters',
    });

    expect(homeDomainAction).not.toHaveBeenCalled();
    expect(approvalsCreate).not.toHaveBeenCalled();
    expect(persistedRequests).toEqual([]);
    expect(JSON.stringify(persistedRequests)).not.toContain('s'.repeat(43));
  });

  it.each(['decision', 'replay'] as const)(
    'refuses a forged V2 approval targeting an internal Action during $mode',
    async (mode) => {
      const forged = createApprovalRequest('approved', {
        actionId: 'teams.invitations.accept.prepareApproval',
        actionArgs: { v: 1, token: 'f'.repeat(43) },
        summary: 'Forged internal approval',
      });
      const approvalsGet = vi.fn(async () => forged);
      const approvalsUpdate = vi.fn(async () => ({ ok: true as const }));
      const homeDomainAction = vi.fn(async () => ({ outcome: 'ok' as const }));
      const executor = createExecutor({ approvalsGet, approvalsUpdate, homeDomainAction } as any);

      const result = mode === 'decision'
        ? await executor.execute('approval.request.decide', {
            artifactId: 'forged-internal-approval',
            decision: 'approve',
          })
        : await executor.replayApprovedApprovalRequest({ artifactId: 'forged-internal-approval' });

      expect(result).toEqual({
        ok: false,
        errorCode: 'invalid_parameters',
        error: 'invalid_parameters',
      });
      expect(approvalsUpdate).not.toHaveBeenCalled();
      expect(homeDomainAction).not.toHaveBeenCalled();
    },
  );

  it('rejects deciding approval artifacts that target approval queue actions', async () => {
    for (const actionId of ['approval.request.list', 'approval.request.get'] as const) {
      const approvalsGet = vi.fn(async () => createApprovalRequest('open', {
        actionId,
        actionArgs: actionId === 'approval.request.get' ? { artifactId: 'a2' } : {},
        summary: 'Nested approval action',
      }));
      const approvalsUpdate = vi.fn(async () => ({ ok: true as const }));
      const approvalsList = vi.fn(async () => ({ items: [], queryPlan: { kind: 'approval_artifact_header_scan', hydratedTranscripts: false } }));

      const executor = createExecutor({
        approvalsGet,
        approvalsUpdate,
        approvalsList,
      } as any);

      const res = await executor.execute('approval.request.decide' as any, {
        artifactId: 'a1',
        decision: 'approve',
      });

      expect(res).toEqual({ ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' });
      expect(approvalsUpdate).not.toHaveBeenCalled();
      expect(approvalsList).not.toHaveBeenCalled();
    }
  });

  it('creates an approval request via deps.approvalsCreate', async () => {
    const approvalsCreate = vi.fn(async () => ({ artifactId: 'a1' }));

    const executor = createExecutor({ approvalsCreate });

    const res = await executor.execute('approval.request.create' as any, {
      actionId: 'session.message.send',
      actionArgs: { sessionId: 's1', message: 'hello' },
      summary: 'Send message',
      createdBy: { surface: 'system' },
    });

    expect(res.ok).toBe(true);
    expect(approvalsCreate).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({
        status: 'open',
        actionId: 'session.message.send',
        summary: 'Send a message to the agent in a session.',
      }),
    }));
  });

  it('inherits transcript tool-call origin metadata from context for approval.request.create', async () => {
    const approvalsCreate = vi.fn(async () => ({ artifactId: 'a1' }));

    const executor = createExecutor({ approvalsCreate });

    const res = await executor.execute('approval.request.create' as any, {
      actionId: 'session.message.send',
      actionArgs: { sessionId: 's1', message: 'hello' },
      summary: 'Send message',
      createdBy: { surface: 'system' },
    }, {
      surface: 'agent',
      defaultSessionId: 's1',
      approvalOrigin: {
        kind: 'transcript_tool_call',
        sessionId: 's1',
        messageId: 'msg-context',
        toolCallId: 'tool-context',
        toolName: 'approval_request_create',
        toolInput: { actionId: 'session.message.send' },
      },
    } as any);

    expect(res.ok).toBe(true);
    expect(approvalsCreate).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({
        origin: {
          kind: 'transcript_tool_call',
          sessionId: 's1',
          messageId: 'msg-context',
          toolCallId: 'tool-context',
          toolName: 'approval_request_create',
          toolInput: { actionId: 'session.message.send' },
        },
      }),
    }));
  });

  it('rejects approval.request.create when target action args fail target schema validation', async () => {
    const approvalsCreate = vi.fn(async () => ({ artifactId: 'a1' }));

    const executor = createExecutor({ approvalsCreate });

    const res = await executor.execute('approval.request.create' as any, {
      actionId: 'session.message.send',
      actionArgs: { sessionId: 's1', message: '' },
      summary: 'Send message',
      createdBy: { surface: 'system' },
    });

    expect(res).toEqual({ ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' });
    expect(approvalsCreate).not.toHaveBeenCalled();
  });

  it('rejects creating approval requests with a blank (trimmed) summary', async () => {
    const approvalsCreate = vi.fn(async () => ({ artifactId: 'a1' }));

    const executor = createExecutor({ approvalsCreate });

    const res = await executor.execute('approval.request.create' as any, {
      actionId: 'session.message.send',
      actionArgs: { sessionId: 's1', message: 'hello' },
      summary: '   ',
      createdBy: { surface: 'system' },
    });

    expect(res).toEqual({ ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' });
    expect(approvalsCreate).not.toHaveBeenCalled();
  });

  it('forces approval.request.create createdBy.surface to match the execution surface', async () => {
    const approvalsCreate = vi.fn(async () => ({ artifactId: 'a1' }));

    const executor = createExecutor({ approvalsCreate });

    const res = await executor.execute('approval.request.create' as any, {
      actionId: 'session.message.send',
      actionArgs: { sessionId: 's1', message: 'hello' },
      summary: 'Send message',
      createdBy: { surface: 'cli' },
    }, {
      surface: 'mcp',
    });

    expect(res.ok).toBe(true);
    expect(approvalsCreate).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({
        createdBy: expect.objectContaining({
          surface: 'mcp',
        }),
      }),
    }));
  });

  it('host-stamps plugin provenance for approval-queue requests without publishing the raw action', async () => {
    const approvalsCreate = vi.fn(async () => ({ artifactId: 'a1' }));
    const executor = createExecutor({ approvalsCreate });

    const res = await executor.execute('approval.request.create' as any, {
      actionId: 'session.list',
      actionArgs: {},
      summary: 'List sessions',
      createdBy: { surface: 'cli', pluginId: 'forged.plugin' },
    }, {
      surface: 'plugin',
      actionCaller: {
        kind: 'plugin',
        pluginId: 'acme.plugin',
        contributionLocalId: 'approval-queue',
        occurrenceId: 'plugin-occurrence-1',
        sourceCustody: { kind: 'development', registeredRootId: 'plugin-root' },
      },
      defaultSessionId: 'requesting-session',
    });

    expect(res.ok).toBe(true);
    expect(approvalsCreate).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({
        createdBy: {
          surface: 'system',
          pluginId: 'acme.plugin',
          contributionLocalId: 'approval-queue',
          sessionId: 'requesting-session',
        },
        requestedSurface: 'plugin',
      }),
    }));
  });

  it('links approval.request.create cross-session approvals to the requesting session', async () => {
    const approvalsCreate = vi.fn(async () => ({ artifactId: 'a1' }));

    const executor = createExecutor({ approvalsCreate });

    const res = await executor.execute('approval.request.create' as any, {
      actionId: 'session.message.send',
      actionArgs: { sessionId: 'target-session', message: 'hello' },
      summary: 'Send message',
      createdBy: { surface: 'cli', sessionId: 'injected-session' },
    }, {
      surface: 'mcp',
      defaultSessionId: 'requesting-session',
      approvalOrigin: {
        kind: 'transcript_tool_call',
        sessionId: 'requesting-session',
        toolCallId: 'tool-create-cross-session',
        toolName: 'approval_request_create',
        toolInput: { actionId: 'session.message.send' },
      },
    });

    expect(res.ok).toBe(true);
    expect(approvalsCreate).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({
        actionArgs: expect.objectContaining({ sessionId: 'target-session' }),
        createdBy: expect.objectContaining({
          surface: 'mcp',
          sessionId: 'requesting-session',
        }),
        origin: expect.objectContaining({
          sessionId: 'requesting-session',
          toolCallId: 'tool-create-cross-session',
        }),
      }),
    }));
  });

  it('ignores approval.request.create createdBy.sessionId when actionArgs.sessionId is missing and uses ctx.defaultSessionId instead', async () => {
    const approvalsCreate = vi.fn(async () => ({ artifactId: 'a1' }));

    const executor = createExecutor({ approvalsCreate });

    const res = await executor.execute('approval.request.create' as any, {
      actionId: 'session.message.send',
      actionArgs: { message: 'hello' },
      summary: 'Send message',
      createdBy: { surface: 'cli', sessionId: 's-injected' },
    }, {
      surface: 'mcp',
      defaultSessionId: 's-default',
    });

    expect(res.ok).toBe(true);
    expect(approvalsCreate).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({
        createdBy: expect.objectContaining({
          surface: 'mcp',
          sessionId: 's-default',
        }),
      }),
    }));
  });

  it('persists the server hint on created approval requests when present in the execution context', async () => {
    const approvalsCreate = vi.fn(async () => ({ artifactId: 'a1' }));

    const executor = createExecutor({ approvalsCreate });

    const res = await executor.execute('approval.request.create' as any, {
      actionId: 'session.message.send',
      actionArgs: { sessionId: 's1', message: 'hello' },
      summary: 'Send message',
      createdBy: { surface: 'system', sessionId: 's1' },
    }, {
      surface: 'ui',
      serverId: 'server-a',
    });

    expect(res.ok).toBe(true);
    expect(approvalsCreate).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({
        executionOriginV1: expect.objectContaining({ serverId: 'server-a' }),
      }),
      serverId: 'server-a',
    }));
  });

  it('allows creating approval requests for safe actions (eligibility is policy-driven, not safety-driven)', async () => {
    const approvalsCreate = vi.fn(async () => ({ artifactId: 'a1' }));

    const executor = createExecutor({ approvalsCreate });

    const res = await executor.execute('approval.request.create' as any, {
      actionId: 'review.start',
      actionArgs: { sessionId: 's1', engineIds: ['x'], instructions: 'y' },
      summary: 'Run review',
      createdBy: { surface: 'system' },
    });

    expect(res.ok).toBe(true);
    expect(approvalsCreate).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({
        actionId: 'review.start',
        summary: 'Start one or more parallel review runs against the current worktree.',
      }),
    }));
  });

  it('restores the requesting transcript correlation when an approved Stop executes', async () => {
    const origin = { kind: 'transcript_tool_call' as const, sessionId: 'requesting-session', toolCallId: 'requesting-tool',
      toolInput: { sessionId: 'target-session', privateInput: 'never-log-this' } };
    let stored = ApprovalRequestV2Schema.parse(createApprovalRequest('open', {
      actionId: 'session.stop', actionArgs: { sessionId: 'target-session' },
      createdBy: { surface: 'mcp', sessionId: 'requesting-session' }, origin,
    }));
    let stoppedContext: ActionExecutorContext | undefined;
    const executor = createExecutor({
      approvalsGet: async () => stored,
      approvalsUpdate: async ({ request }) => { stored = ApprovalRequestV2Schema.parse(request); return { ok: true }; },
      // Native Session control is the effect boundary; approval and replay remain real.
      sessionStop: async ({ context }) => { stoppedContext = context; return { ok: true, stopped: true }; },
    });
    const result = await executor.execute('approval.request.decide', { artifactId: 'a1', decision: 'approve' }, {
      surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
      approvalOrigin: { kind: 'transcript_tool_call', sessionId: 'approving-session', toolCallId: 'approving-tool' },
    });
    expect(result).toMatchObject({ ok: true, result: { status: 'executed' } });
    expect(stoppedContext?.approvalOrigin).toEqual(origin);
    expect(stoppedContext?.approvedActionReplay?.origin?.surface).toBe('mcp');
  });

  it('executes the underlying action when an approval is approved', async () => {
    const approvalsGet = vi.fn(async () => createApprovalRequest());
    const approvalsUpdate = vi.fn(async () => ({ ok: true as const }));
    const sessionSendMessage = vi.fn(async () => ({ status: 'accepted' as const, localId: 'local-1' }));

    const executor = createExecutor({ approvalsGet, approvalsUpdate, sessionSendMessage });

    const res = await executor.execute('approval.request.decide' as any, {
      artifactId: 'a1',
      decision: 'approve',
    });

    expect(res.ok).toBe(true);
    expect(sessionSendMessage).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 's1',
      message: 'hello',
      requestedAction: { v: 1, kind: 'steer_if_active' },
    }));
    // Decide commits open→approved, claims approved→executing, then settles the
    // terminal row. The claim is what makes the effect exactly-once.
    expect(approvalsUpdate).toHaveBeenCalledTimes(3);
    expect(approvalsUpdate).toHaveBeenNthCalledWith(1, expect.objectContaining({
      artifactId: 'a1',
      request: expect.objectContaining({
        status: 'approved',
        decision: expect.objectContaining({ kind: 'approve' }),
      }),
    }));
    expect(approvalsUpdate).toHaveBeenNthCalledWith(2, expect.objectContaining({
      artifactId: 'a1',
      request: expect.objectContaining({
        status: 'executing',
        decision: expect.objectContaining({ kind: 'approve' }),
      }),
    }));
    expect(approvalsUpdate).toHaveBeenNthCalledWith(3, expect.objectContaining({
      artifactId: 'a1',
      request: expect.objectContaining({
        status: 'executed',
        execution: expect.objectContaining({ effectAttempted: true, ok: true }),
      }),
    }));
  });

  it('admits only one executor for a persisted approved V2 request', async () => {
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(2);
    let storedRequest = createApprovalRequest('approved');
    let releaseEffect!: () => void;
    let markEffectStarted!: () => void;
    const effectStarted = new Promise<void>((resolve) => { markEffectStarted = resolve; });
    const effectBlocked = new Promise<void>((resolve) => { releaseEffect = resolve; });
    let releaseInitialReads!: () => void;
    const initialReadsCompleted = new Promise<void>((resolve) => { releaseInitialReads = resolve; });
    let initialReads = 0;
    const approvalsGet = vi.fn(async () => {
      const snapshot = structuredClone(storedRequest);
      if (snapshot.status === 'approved' && initialReads < 2) {
        initialReads += 1;
        if (initialReads === 2) releaseInitialReads();
        await initialReadsCompleted;
      }
      return snapshot;
    });
    let markSecondClaimAttempted!: () => void;
    const secondClaimAttempted = new Promise<void>((resolve) => { markSecondClaimAttempted = resolve; });
    let claimAttempts = 0;
    const approvalsUpdate = vi.fn(async ({ request }: { request: ApprovalRequest }) => {
      if (request.status === 'executing') {
        claimAttempts += 1;
        if (claimAttempts === 2) markSecondClaimAttempted();
      }
      // Match the real Artifact adapter contract: terminal equality is
      // idempotent, while observing an equal executing row loses the claim.
      if (isDeepStrictEqual(storedRequest, request)) {
        return request.status === 'executing'
          ? { ok: false as const, errorCode: 'invalid_transition', error: 'approval_request_invalid_transition' }
          : { ok: true as const };
      }
      const isExecutionClaim = storedRequest.status === 'approved' && request.status === 'executing';
      const isTerminal = storedRequest.status === 'executing'
        && (request.status === 'executed' || request.status === 'failed');
      if (!isExecutionClaim && !isTerminal) {
        return { ok: false as const, errorCode: 'version_mismatch', error: 'artifact_version_mismatch' };
      }
      storedRequest = structuredClone(request);
      return { ok: true as const };
    });
    let effects = 0;
    const sessionSendMessage = vi.fn(async () => {
      effects += 1;
      markEffectStarted();
      await effectBlocked;
      return { status: 'accepted' as const, localId: 'local-1' };
    });
    const executor = createExecutor({ approvalsGet, approvalsUpdate, sessionSendMessage });

    const decide = executor.execute('approval.request.decide', {
      artifactId: 'a1', decision: 'approve',
    });
    const replay = executor.replayApprovedApprovalRequest({ artifactId: 'a1' });
    await effectStarted;
    await secondClaimAttempted;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(effects).toBe(1);

    const loser = await Promise.race([decide, replay]);
    expect(loser).toMatchObject({
      ok: false,
      errorCode: 'approval_execution_outcome_unknown',
    });
    expect(effects).toBe(1);
    expect(storedRequest.status).toBe('executing');

    const freshExecutor = createExecutor({ approvalsGet, approvalsUpdate, sessionSendMessage });
    await expect(freshExecutor.replayApprovedApprovalRequest({ artifactId: 'a1' })).resolves.toMatchObject({
      ok: false,
      errorCode: 'approval_execution_outcome_unknown',
    });
    expect(effects).toBe(1);

    releaseEffect();
    await Promise.all([decide, replay]);
    expect(effects).toBe(1);
    expect(storedRequest.status).toBe('executed');
    dateNow.mockRestore();
  });

  it.each(['throws', 'refuses'] as const)('preserves a known signed-out outcome when that effect retires its approval Account authority (%s)', async (settlement) => {
    let storedRequest: ApprovalRequest | null = null;
    let authorityRetired = false;
    const signOut = vi.fn(async () => {
      authorityRetired = true;
      return { status: 'signed_out' };
    });
    const settings = ActionsSettingsV1Schema.parse({ v: 1, actions: {
      'account.sessions.signOutEverywhere': { approvalRequiredSurfaces: ['ui'] },
    } });
    const executor = createExecutor({
      isApprovalExecutionOriginCurrent: async () => !authorityRetired,
      isActionApprovalRequired: (id, context) => isApprovalRequiredByActionsSettings(id, settings, context),
      approvalsCreate: async ({ request }) => {
        storedRequest = ApprovalRequestV2Schema.parse(request);
        return { artifactId: 'leaving' };
      },
      approvalsGet: async () => storedRequest,
      approvalsUpdate: async ({ request }) => {
        // The authenticated Artifact HTTP boundary rejects the just-revoked bearer.
        if (authorityRetired) {
          if (settlement === 'throws') throw new Error('unauthorized');
          return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
        }
        storedRequest = request;
        return { ok: true };
      },
      accountSessionsSignOutEverywhereAction: signOut,
    });
    const proposed = await executor.execute('account.sessions.signOutEverywhere', {});
    expect(proposed).toMatchObject({ ok: true, result: { kind: 'approval_request_created', artifactId: 'leaving' } });
    expect(authorityRetired).toBe(false);
    const outcome = await executor.execute('approval.request.decide', { artifactId: 'leaving', decision: 'approve' });
    expect(authorityRetired).toBe(true);
    expect(outcome).toMatchObject({ ok: true, result: { status: 'executed' } });
    expect(storedRequest).toMatchObject({ status: 'executing' });
    await expect(executor.execute('approval.request.decide', { artifactId: 'leaving', decision: 'approve' }))
      .resolves.toMatchObject({ ok: false, errorCode: 'approval_execution_outcome_unknown' });
    expect(signOut).toHaveBeenCalledOnce();
  });

  it('does not report signed out when the effect has no confirmed retirement and settlement fails', async () => {
    let storedRequest = createApprovalRequest('approved', { actionId: 'account.sessions.signOutEverywhere', actionArgs: {} });
    const executor = createExecutor({
      approvalsGet: async () => storedRequest,
      approvalsUpdate: async ({ request }) => {
        if (request.status === 'executing') {
          storedRequest = request;
          return { ok: true };
        }
        throw new Error('transport unavailable');
      },
      accountSessionsSignOutEverywhereAction: async () => ({ ok: false, errorCode: 'server_unreachable', error: 'server_unreachable' }),
    });
    await expect(executor.execute('approval.request.decide', { artifactId: 'leaving', decision: 'approve' }))
      .resolves.toMatchObject({ ok: false, errorCode: 'approval_execution_outcome_unknown' });
    expect(storedRequest.status).toBe('executing');
  });

  it('reports outcome unknown when the effect succeeds but terminal persistence fails', async () => {
    let storedRequest = createApprovalRequest('approved');
    const approvalsGet = vi.fn(async () => structuredClone(storedRequest));
    const approvalsUpdate = vi.fn(async ({ request }: { request: ApprovalRequest }) => {
      if (storedRequest.status === 'approved' && request.status === 'executing') {
        storedRequest = structuredClone(request);
        return { ok: true as const };
      }
      return { ok: false as const, errorCode: 'version_mismatch', error: 'artifact_version_mismatch' };
    });
    const sessionSendMessage = vi.fn(async () => ({ status: 'accepted' as const, localId: 'local-1' }));
    const executor = createExecutor({ approvalsGet, approvalsUpdate, sessionSendMessage });

    await expect(executor.replayApprovedApprovalRequest({ artifactId: 'a1' })).resolves.toEqual({
      ok: false,
      errorCode: 'approval_execution_outcome_unknown',
      error: 'approval_execution_outcome_unknown',
    });
    expect(sessionSendMessage).toHaveBeenCalledOnce();
    expect(storedRequest.status).toBe('executing');
  });

  it('reports outcome unknown when the terminal persistence write throws a transport error', async () => {
    let storedRequest = createApprovalRequest('approved');
    const approvalsGet = vi.fn(async () => structuredClone(storedRequest));
    const approvalsUpdate = vi.fn(async ({ request }: { request: ApprovalRequest }) => {
      if (storedRequest.status === 'approved' && request.status === 'executing') {
        storedRequest = structuredClone(request);
        return { ok: true as const };
      }
      throw Object.assign(new Error('reset'), { code: 'ECONNRESET' });
    });
    let effects = 0;
    const sessionSendMessage = vi.fn(async () => {
      effects += 1;
      return { status: 'accepted' as const, localId: 'local-1' };
    });
    const executor = createExecutor({ approvalsGet, approvalsUpdate, sessionSendMessage });

    await expect(executor.replayApprovedApprovalRequest({ artifactId: 'a1' })).resolves.toEqual({
      ok: false,
      errorCode: 'approval_execution_outcome_unknown',
      error: 'approval_execution_outcome_unknown',
    });
    expect(effects).toBe(1);
    expect(storedRequest.status).toBe('executing');

    // The claim stays persisted, so a replay of the same Artifact reports the
    // same post-effect uncertainty rather than running the effect again.
    const freshExecutor = createExecutor({ approvalsGet, approvalsUpdate, sessionSendMessage });
    await expect(freshExecutor.replayApprovedApprovalRequest({ artifactId: 'a1' })).resolves.toMatchObject({
      ok: false,
      errorCode: 'approval_execution_outcome_unknown',
    });
    expect(effects).toBe(1);
  });

  it('persists strict Board conflict details after deferred approval execution', async () => {
    const boardInput = {
      sessionId: 's1',
      expectedLayoutRevision: null,
      operation: { op: 'tab.create' as const, tabId: 'overview', title: 'Overview' },
    };
    let storedRequest = createApprovalRequest('approved', {
      actionId: 'session.board.layout.update',
      actionArgs: boardInput,
      requestedSurface: 'mcp',
      createdBy: { surface: 'mcp', sessionId: 's1' },
    });
    const approvalsGet = vi.fn(async () => structuredClone(storedRequest));
    const approvalsUpdate = vi.fn(async ({ request }: { request: ApprovalRequest }) => {
      storedRequest = structuredClone(request);
      return { ok: true as const };
    });
    const sessionBoardAction = vi.fn(async () => ({
      ok: false as const,
      errorCode: 'session_board_revision_conflict' as const,
      error: 'session_board_revision_conflict' as const,
      details: { currentLayoutRevision: 'ssr1.AAAACHN5c3JlY18xAAAAAQ' },
    }));
    const executor = createExecutor({ approvalsGet, approvalsUpdate, sessionBoardAction });

    await expect(executor.replayApprovedApprovalRequest({ artifactId: 'a1' })).resolves.toMatchObject({
      ok: true,
      result: {
        status: 'failed',
        execution: {
          ok: false,
          errorCode: 'session_board_revision_conflict',
          details: { currentLayoutRevision: 'ssr1.AAAACHN5c3JlY18xAAAAAQ' },
        },
      },
    });
    expect(storedRequest).toMatchObject({
      status: 'failed',
      execution: {
        ok: false,
        errorCode: 'session_board_revision_conflict',
        details: { currentLayoutRevision: 'ssr1.AAAACHN5c3JlY18xAAAAAQ' },
      },
    });
  });

  it('preserves a request-bound Board outcome-unknown recovery packet after deferred approval', async () => {
    const boardInput = {
      sessionId: 's1',
      expectedLayoutRevision: null,
      operation: { op: 'tab.create' as const, tabId: 'overview', title: 'Overview' },
    };
    const mutationRequest = {
      operation: 'update_layout' as const,
      expectedLayoutRevision: null,
      layoutContent: {
        t: 'plain' as const,
        v: { v: 1 as const, tabs: [{ id: 'overview', title: 'Overview', items: [] }] },
      },
    };
    const recovery = {
      v: 1 as const,
      actionId: 'session.board.layout.update' as const,
      serverId: 'server-1',
      sessionId: 's1',
      requestBody: JSON.stringify(mutationRequest),
      mutationRequest,
      intent: boardInput,
    };
    let storedRequest = createApprovalRequest('approved', {
      actionId: 'session.board.layout.update',
      actionArgs: boardInput,
      requestedSurface: 'mcp',
      createdBy: { surface: 'mcp', sessionId: 's1' },
    });
    const approvalsGet = vi.fn(async () => structuredClone(storedRequest));
    const approvalsUpdate = vi.fn(async ({ request }: { request: ApprovalRequest }) => {
      storedRequest = structuredClone(request);
      return { ok: true as const };
    });
    const executor = createExecutor({
      approvalsGet,
      approvalsUpdate,
      sessionBoardAction: vi.fn(async () => ({
        ok: false as const,
        errorCode: 'outcome_unknown' as const,
        error: 'outcome_unknown' as const,
        details: { recovery },
      })),
    });

    await expect(executor.replayApprovedApprovalRequest({ artifactId: 'a1' })).resolves.toMatchObject({
      ok: true,
      result: {
        status: 'failed',
        execution: { ok: false, errorCode: 'outcome_unknown', details: { recovery } },
      },
    });
    expect(storedRequest).toMatchObject({
      status: 'failed',
      execution: { ok: false, errorCode: 'outcome_unknown', details: { recovery } },
    });
  });

  it('does not persist unvalidated failure details from another Action family', async () => {
    let storedRequest = createApprovalRequest('approved');
    const approvalsGet = vi.fn(async () => structuredClone(storedRequest));
    const approvalsUpdate = vi.fn(async ({ request }: { request: ApprovalRequest }) => {
      storedRequest = structuredClone(request);
      return { ok: true as const };
    });
    const sessionSendMessage = vi.fn(async () => ({
      ok: false as const,
      errorCode: 'action_failed',
      error: 'action_failed',
      details: { bearer: 'must-not-persist' },
    }));
    const executor = createExecutor({ approvalsGet, approvalsUpdate, sessionSendMessage });

    await executor.replayApprovedApprovalRequest({ artifactId: 'a1' });
    expect(storedRequest.execution).toEqual({
      executedAtMs: expect.any(Number),
      effectAttempted: true,
      ok: false,
      errorCode: 'action_failed',
      error: 'action_failed',
    });
  });

  it('refuses RPC automation before claiming a live CLI approval and preserves present-user delivery', async () => {
    const proposal = ApprovalRequestV2Schema.parse(createApprovalRequest('open', {
      actionId: 'session.title.set', actionArgs: { sessionId: 's1', title: 'Reviewed title' },
      createdBy: { surface: 'cli' }, requestedSurface: 'cli',
      approval: { flow: 'blocking', result: 'required' },
    }));
    const { machineId: _contextualMachine, ...origin } = proposal.executionOriginV1;
    let storedRequest = ApprovalRequestV2Schema.parse({ ...proposal,
      executionOriginV1: { ...origin, authority: 'present_user' } });
    const originalRequest = structuredClone(storedRequest);
    expect(readLiveCliApprovalOriginScope(storedRequest)).not.toBeNull();
    // Artifact storage and the exact live-origin RPC are the boundaries. All
    // caller authority, approval admission and transition logic remain real.
    const approvalsUpdate = vi.fn(async ({ request }: { request: ApprovalRequest }) => {
      const next = ApprovalRequestV2Schema.parse(request);
      const transition = decideApprovalRequestTransition(storedRequest, next);
      if (!transition.ok) return transition;
      storedRequest = next;
      return { ok: true as const };
    });
    const approvalRequestApprovedReplay = vi.fn(async () => ({ ok: true as const,
      result: { ok: true, status: 'executed' } }));
    const executor = createExecutor({ approvalsGet: async () => storedRequest,
      approvalsUpdate, approvalRequestApprovedReplay });
    const input = { artifactId: 'a1', decision: 'approve' };
    const context = { surface: 'rpc' as const, actionCaller: { kind: 'host' as const } };

    expect(await executor.execute('approval.request.decide', input, { ...context, authority: 'account_automation' }))
      .toMatchObject({ ok: false, errorCode: 'present_user_required' });
    expect(storedRequest).toEqual(originalRequest);
    expect(approvalsUpdate).not.toHaveBeenCalled();
    expect(approvalRequestApprovedReplay).not.toHaveBeenCalled();

    expect(await executor.execute('approval.request.decide', input, { ...context, authority: 'present_user' }))
      .toMatchObject({ ok: true, result: { status: 'executed' } });
    expect(storedRequest).toMatchObject({ status: 'approved', decision: { authority: 'present_user' } });
    expect(approvalsUpdate).toHaveBeenCalledOnce();
    expect(approvalRequestApprovedReplay).toHaveBeenCalledOnce();
  });

  it.each(['deferred', 'blocking'] as const)('persists the present-user decision before delegating exact-daemon replay with %s custody', async flow => {
    let storedRequest = ApprovalRequestV2Schema.parse({ ...createApprovalRequest('open'),
      approval: { flow, result: 'required' } });
    const coordinator = createBlockingApprovalCoordinator();
    const pending = flow === 'blocking' ? coordinator.waitForDecision({ artifactId: 'a1', request: storedRequest }) : null;
    void pending?.catch(() => {});
    const approvalsGet = vi.fn(async () => storedRequest);
    const approvalsUpdate = vi.fn(async ({ request }: { request: ApprovalRequest }) => {
      storedRequest = ApprovalRequestV2Schema.parse(request);
      return { ok: true as const };
    });
    const sessionSendMessage = vi.fn(async () => ({ status: 'accepted' as const, localId: 'local-1' }));
    const approvalRequestApprovedReplay = vi.fn(async ({ request }: { request: ApprovalRequest }) => {
      expect(request).toMatchObject({
        status: 'approved',
        decision: { kind: 'approve' },
      });
      expect(storedRequest).toEqual(request);
      return {
        ok: true as const,
        result: { ok: true as const, status: 'executed' as const },
      };
    });

    const executor = createExecutor({
      approvalsGet,
      approvalsUpdate,
      sessionSendMessage,
      approvalRequestApprovedReplay,
      approvalsResolveBlockingDecision: args => coordinator.resolveBlockingDecision(args),
    });

    try {
      await expect(executor.execute('approval.request.decide', {
        artifactId: 'a1',
        decision: 'approve',
      })).resolves.toEqual({
        ok: true,
        result: { ok: true, status: 'executed' },
      });

      expect(approvalsUpdate).toHaveBeenCalledTimes(1);
      expect(approvalRequestApprovedReplay).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        artifactId: 'a1',
        request: expect.objectContaining({
          status: 'approved',
          decision: expect.objectContaining({ kind: 'approve' }),
        }),
        context: expect.objectContaining({ surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } }),
        requestId: 'request-1',
      }));
      expect(sessionSendMessage).not.toHaveBeenCalled();
      if (flow === 'blocking') expect(coordinator.getLiveWaiterCount('a1')).toBe(1);
    } finally {
      coordinator.dispose();
      await pending?.catch(() => {});
    }
  });

  it('settles an unavailable exact-daemon route without releasing a live blocking waiter to execute', async () => {
    let storedRequest = ApprovalRequestV2Schema.parse({ ...createApprovalRequest('open'),
      approval: { flow: 'blocking', result: 'required' } });
    const coordinator = createBlockingApprovalCoordinator();
    const pending = coordinator.waitForDecision({ artifactId: 'a1', request: storedRequest,
      readRequest: async () => storedRequest,
      subscribeChanges: listener => coordinator.subscribeApprovalChanges(listener),
    });
    void pending.catch(() => {});
    // This is the exact-daemon RPC admission boundary, not a mock of replay.
    const approvalRequestApprovedReplay = async () => ({ ok: false as const,
      errorCode: 'approval_origin_unavailable', error: 'approval_origin_unavailable' });
    const executor = createExecutor({
      approvalsGet: async () => storedRequest,
      approvalsUpdate: async ({ request }) => {
        storedRequest = ApprovalRequestV2Schema.parse(request);
        coordinator.notifyApprovalUpdated({ artifactId: 'a1', request: storedRequest });
        return { ok: true as const };
      },
      approvalsResolveBlockingDecision: args => coordinator.resolveBlockingDecision(args),
      approvalRequestApprovedReplay,
    });
    try {
      expect(await executor.execute('approval.request.decide', { artifactId: 'a1', decision: 'approve' }))
        .toMatchObject({ ok: true, result: { status: 'failed', execution: { ok: false, errorCode: 'approval_origin_unavailable' } } });
      expect(storedRequest.status).toBe('failed');
      expect((await pending).request).toMatchObject({ status: 'failed', execution: { ok: false } });
    } finally {
      coordinator.dispose();
      await pending.catch(() => {});
    }
  });

  it.each(['open', 'approved'] as const)('settles an origin-less CLI Session approval from %s without replaying its effect', async status => {
    const proposal = ApprovalRequestV2Schema.parse(createApprovalRequest(status, {
        actionId: 'session.board.layout.update',
        requestedSurface: 'cli',
        createdBy: { surface: 'cli' },
        actionArgs: {
          sessionId: 's1', expectedLayoutRevision: null,
          operation: { op: 'tab.create', tabId: 'overview', title: 'Overview' },
        },
      }));
    let storedRequest = ApprovalRequestV2Schema.parse({ ...proposal,
      executionOriginV1: { ...proposal.executionOriginV1, machineId: undefined } });
    const sessionBoardAction = vi.fn(async () => ({
      v: 1 as const, serverId: 'server-1', sessionId: 's1', destination: null,
      result: { operation: 'update_layout' as const, outcome: 'created' as const,
        layoutRevision: 'ssr1.AAAACHN5c3JlY18xAAAAAQ' },
    }));
    // Exact-daemon replay is an RPC boundary; lack of origin cannot be repaired there.
    const approvalRequestApprovedReplay = vi.fn(async () => ({
      ok: false as const, errorCode: 'approval_origin_unavailable', error: 'approval_origin_unavailable',
    }));
    const executor = createExecutor({
      approvalsGet: async () => storedRequest,
      approvalsUpdate: async ({ request }) => {
        const parsed = ApprovalRequestV2Schema.parse(request);
        const transition = decideApprovalRequestTransition(storedRequest, parsed);
        if (!transition.ok) return transition;
        storedRequest = parsed;
        return { ok: true as const };
      },
      sessionBoardAction,
      approvalRequestApprovedReplay,
    });
    const expected = {
      ok: true,
      result: { status: 'failed', execution: {
        ok: false, errorCode: 'approval_origin_unavailable',
        error: expect.stringMatching(/cannot run.*origin.*unavailable/i),
      } },
    };
    await expect(status === 'approved'
      ? executor.replayApprovedApprovalRequest({ artifactId: 'a1' })
      : executor.execute('approval.request.decide', { artifactId: 'a1', decision: 'approve' }))
      .resolves.toMatchObject(expected);
    expect(storedRequest.status).toBe('failed');
    // A second decision observes the same terminal failure, never retries it.
    await expect(executor.execute('approval.request.decide', { artifactId: 'a1', decision: 'approve' }))
      .resolves.toMatchObject(expected);
    expect(sessionBoardAction).not.toHaveBeenCalled();
    expect(approvalRequestApprovedReplay).not.toHaveBeenCalled();
  });

  it('never delegates a rejected decision to an execution host', async () => {
    const approvalsGet = vi.fn(async () => createApprovalRequest('open'));
    const approvalsUpdate = vi.fn(async () => ({ ok: true as const }));
    const approvalRequestApprovedReplay = vi.fn(async () => ({
      ok: true as const,
      result: { ok: true as const, status: 'executed' as const },
    }));

    const executor = createExecutor({
      approvalsGet,
      approvalsUpdate,
      approvalRequestApprovedReplay,
    });

    await expect(executor.execute('approval.request.decide' as any, {
      artifactId: 'a1',
      decision: 'reject',
    })).resolves.toEqual({
      ok: true,
      result: { ok: true, status: 'rejected' },
    });
    expect(approvalRequestApprovedReplay).not.toHaveBeenCalled();
  });

  it.each(['api', 'ui'] as const)('keeps Session-caller egress redacted when replaying a stored %s origin', async surface => {
    const base = createApprovalRequest('approved', {
      actionId: 'session.title.set', actionArgs: { sessionId: 's1', title: 'Title' },
    });
    const target = { kind: 'session' as const, sessionId: 's1' };
    const authorization: ExternalActionExecutionAuthorizationV1 = { v: 1, token: 'home-admitted-api-replay', binding: {
      serverIdentityId: 'stable-home', accountId: 'alice', principalId: 'token', credentialId: 'credential',
      custodianAccountId: 'alice', installationId: 'installation',
      machineId: 'machine-1', actionId: base.actionId, requestId: 'stored-replay', target,
      requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1({
        v: 1, requestId: 'stored-replay', target, input: base.actionArgs,
      }),
      grant: API_TOKEN_FULL_GRANT_V1,
    } };
    let storedRequest = ApprovalRequestV2Schema.parse({ ...base, requestedSurface: surface, executionOriginV1: {
      v: 1, authority: 'account_automation', surface,
      caller: { kind: 'session', sessionId: 's1', starterDepth: 0, turnDepth: 0 },
      serverId: 'server-1', machineId: 'machine-1', sessionId: 's1', accountId: 'alice',
      ...(surface === 'api' ? {
        serverIdentityId: 'stable-home', principalId: 'token', credentialId: 'credential', target,
        externalActionExecutionAuthorization: authorization,
        externalActionInputSignature: signExternalActionApprovalInputV1({
          authorizationToken: authorization.token, actionId: base.actionId, target, input: base.actionArgs,
          privateKey: tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(39)).secretKey,
        }),
      } : {}),
      callerPermissionMode: 'yolo', actionId: base.actionId, requestId: 'stored-replay',
    } });
    const egressDecisions: boolean[] = [];
    const executor = createExecutor({
      approvalsGet: async () => storedRequest,
      approvalsUpdate: async ({ request }) => { storedRequest = ApprovalRequestV2Schema.parse(request); return { ok: true }; },
      sessionStateFieldSet: async ({ context }) => {
        egressDecisions.push(requiresAgentEgressRedaction(context));
        return { updated: true };
      },
    });
    const replay = await executor.replayApprovedApprovalRequest({ artifactId: 'session-replay' });
    expect(replay, JSON.stringify(replay))
      .toMatchObject({ ok: true, result: { status: 'executed' } });
    expect(egressDecisions).toEqual([true]);
  });

  it('replays only an already-approved Artifact through the immutable origin', async () => {
    let storedRequest = createApprovalRequest('open');
    const approvalsGet = vi.fn(async () => storedRequest);
    const approvalsUpdate = vi.fn(async ({ request }: { request: ApprovalRequest }) => {
      storedRequest = request;
      return { ok: true as const };
    });
    const sessionSendMessage = vi.fn(async () => ({ status: 'accepted' as const, localId: 'local-1' }));

    const executor = createExecutor({ approvalsGet, approvalsUpdate, sessionSendMessage });

    await expect(executor.replayApprovedApprovalRequest({ artifactId: 'a1' })).resolves.toEqual({
      ok: false,
      errorCode: 'approval_not_approved',
      error: 'approval_not_approved',
    });
    expect(approvalsUpdate).not.toHaveBeenCalled();
    expect(sessionSendMessage).not.toHaveBeenCalled();

    storedRequest = createApprovalRequest('approved');
    await expect(executor.replayApprovedApprovalRequest({ artifactId: 'a1' })).resolves.toEqual({
      ok: true,
      result: {
        ok: true,
        status: 'executed',
        execution: expect.objectContaining({ ok: true }),
      },
    });
    expect(sessionSendMessage).toHaveBeenCalledTimes(1);
    // Replay owns no decision authority, so it writes only the claim and the
    // terminal row — never a decision.
    expect(approvalsUpdate).toHaveBeenCalledTimes(2);
    expect(approvalsUpdate).toHaveBeenNthCalledWith(1, expect.objectContaining({
      artifactId: 'a1',
      serverId: 'server-1',
      request: expect.objectContaining({ status: 'executing' }),
    }));
    expect(approvalsUpdate).toHaveBeenNthCalledWith(2, expect.objectContaining({
      artifactId: 'a1',
      serverId: 'server-1',
      request: expect.objectContaining({ status: 'executed' }),
    }));
  });

  it('returns an approved blocking decision without executing when an external waiter owns execution', async () => {
    const approvalsGet = vi.fn(async () => createApprovalRequest('open', {
      actionId: 'session.list',
      actionArgs: {},
      approval: { flow: 'blocking', result: 'required' },
      summary: 'List sessions',
      requestedSurface: 'mcp',
    }));
    const approvalsUpdate = vi.fn(async () => ({ ok: true as const }));
    const approvalsResolveBlockingDecision = vi.fn(async () => ({ resolved: true }));
    const sessionList = vi.fn(async () => ({ sessions: [{ id: 's1', title: 'One' }] }));

    const executor = createExecutor({
      approvalsGet,
      approvalsUpdate,
      approvalsResolveBlockingDecision,
      sessionList,
    } as any);

    const res = await executor.execute('approval.request.decide' as any, {
      artifactId: 'a1',
      decision: 'approve',
    });

    expect(res).toEqual({
      ok: true,
      result: {
        ok: true,
        status: 'approved',
      },
    });
    expect(approvalsResolveBlockingDecision).toHaveBeenCalledWith(expect.objectContaining({
      artifactId: 'a1',
      decision: 'approve',
      request: expect.objectContaining({
        status: 'approved',
        actionId: 'session.list',
      }),
    }));
    expect(sessionList).not.toHaveBeenCalled();
  });

  it('executes an approved blocking decision when no live waiter owns execution', async () => {
    const approvalsGet = vi.fn(async () => createApprovalRequest('open', {
      actionId: 'session.list',
      actionArgs: {},
      // Even a stale/manually-created deferred request cannot turn the
      // Artifact into durable bearer custody.
      approval: { flow: 'deferred', result: 'required' },
      summary: 'List sessions',
      requestedSurface: 'mcp',
    }));
    const approvalsUpdate = vi.fn(async () => ({ ok: true as const }));
    const approvalsResolveBlockingDecision = vi.fn(async () => ({ resolved: false }));
    const sessionList = vi.fn(async () => ({
      sessions: [{ id: 's1', active: false, presence: 'offline', updatedAt: 1, title: 'One' }],
      nextCursor: null,
    }));

    const executor = createExecutor({
      approvalsGet,
      approvalsUpdate,
      approvalsResolveBlockingDecision,
      sessionList,
    } as any);

    const res = await executor.execute('approval.request.decide' as any, {
      artifactId: 'a1',
      decision: 'approve',
    });

    expect(res).toEqual({
      ok: true,
      result: {
        ok: true,
        status: 'executed',
        execution: expect.objectContaining({
          ok: true,
          result: {
            sessions: [{ id: 's1', active: false, presence: 'offline', updatedAt: 1, title: 'One' }],
            nextCursor: null,
          },
        }),
      },
    });
    expect(sessionList).toHaveBeenCalledTimes(1);
  });

  it('marks legacy V1 approvals stale before effects because their execution origin is unprovable', async () => {
    let legacyRequest: ApprovalRequestV1 = {
      v: 1,
      status: 'open',
      createdAtMs: 1,
      updatedAtMs: 1,
      createdBy: { surface: 'system', sessionId: 's1' },
      actionId: 'session.message.send',
      actionArgs: { sessionId: 's1', message: 'hello' },
      summary: 'Send message',
    };
    const approvalsGet = vi.fn(async () => legacyRequest);
    const approvalsUpdate = vi.fn(async ({ request }: { request: ApprovalRequestV1 }) => {
      legacyRequest = request;
      return { ok: true as const };
    });
    const sessionSendMessage = vi.fn(async () => ({ status: 'accepted' as const, localId: 'local-1' }));

    const executor = createExecutor({ approvalsGet, approvalsUpdate, sessionSendMessage });

    const res = await executor.execute('approval.request.decide' as any, {
      artifactId: 'a1',
      decision: 'approve',
    });

    expect(res).toEqual({
      ok: true,
      result: {
        ok: true,
        status: 'failed',
        execution: expect.objectContaining({ ok: false, errorCode: 'approval_stale' }),
      },
    });
    expect(sessionSendMessage).not.toHaveBeenCalled();
    expect(approvalsUpdate).toHaveBeenCalledTimes(2);
    expect(legacyRequest).toMatchObject({
      status: 'failed',
      execution: { ok: false, errorCode: 'approval_stale' },
    });
  });

  it('terminalizes an already-approved legacy V1 replay that cannot prove its execution origin', async () => {
    let legacyRequest: ApprovalRequestV1 = {
      v: 1,
      status: 'approved',
      createdAtMs: 1,
      updatedAtMs: 2,
      createdBy: { surface: 'system', sessionId: 's1' },
      decision: { kind: 'approve', decidedAtMs: 2 },
      actionId: 'session.message.send',
      actionArgs: { sessionId: 's1', message: 'hello' },
      summary: 'Send message',
    };
    const approvalsGet = vi.fn(async () => legacyRequest);
    const approvalsUpdate = vi.fn(async ({ request }: { request: ApprovalRequestV1 }) => {
      legacyRequest = request;
      return { ok: true as const };
    });
    const sessionSendMessage = vi.fn(async () => ({ status: 'accepted' as const, localId: 'local-1' }));
    const executor = createExecutor({ approvalsGet, approvalsUpdate, sessionSendMessage });

    await expect(executor.replayApprovedApprovalRequest({ artifactId: 'a1' })).resolves.toEqual({
      ok: true,
      result: {
        ok: true,
        status: 'failed',
        execution: expect.objectContaining({ ok: false, errorCode: 'approval_stale' }),
      },
    });
    expect(approvalsUpdate).toHaveBeenCalledOnce();
    expect(sessionSendMessage).not.toHaveBeenCalled();
    expect(legacyRequest).toMatchObject({
      status: 'failed',
      execution: { ok: false, errorCode: 'approval_stale' },
    });
  });

  it('does not re-route already-approved actions through approvals when executing them', async () => {
    const approvalsGet = vi.fn(async () => createApprovalRequest('open', { createdBy: { surface: 'mcp', sessionId: 's1' } }));
    const approvalsUpdate = vi.fn(async () => ({ ok: true as const }));
    const approvalsCreate = vi.fn(async () => ({ artifactId: 'nested' }));
    const sessionSendMessage = vi.fn(async () => ({ status: 'accepted' as const, localId: 'local-1' }));

    const executor = createExecutor({
      approvalsGet,
      approvalsUpdate,
      approvalsCreate,
      sessionSendMessage,
      isActionApprovalRequired: (actionId, ctx) => actionId === 'session.message.send' && ctx.surface === 'mcp',
    } as any);

    const res = await executor.execute('approval.request.decide' as any, {
      artifactId: 'a1',
      decision: 'approve',
    }, {
      surface: 'mcp',
      authority: 'present_user',
    });

    expect(res.ok).toBe(true);
    expect(approvalsCreate).not.toHaveBeenCalled();
    expect(sessionSendMessage).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 's1',
      message: 'hello',
      requestedAction: { v: 1, kind: 'steer_if_active' },
    }));
  });

  it('uses the stored approval serverId when the decision context omits one', async () => {
    const approvalsGet = vi.fn(async () => createApprovalRequest('open', { serverId: 'server-a' }));
    const approvalsUpdate = vi.fn(async () => ({ ok: true as const }));
    const sessionSendMessage = vi.fn(async () => ({ status: 'accepted' as const, localId: 'local-1' }));

    const executor = createExecutor({ approvalsGet, approvalsUpdate, sessionSendMessage });

    const res = await executor.execute('approval.request.decide' as any, {
      artifactId: 'a1',
      decision: 'approve',
    });

    expect(res.ok).toBe(true);
    expect(approvalsGet).toHaveBeenCalledWith({ artifactId: 'a1', serverId: null });
    expect(sessionSendMessage).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 's1',
      message: 'hello',
      serverId: 'server-a',
      requestedAction: { v: 1, kind: 'steer_if_active' },
    }));
    expect(approvalsUpdate).toHaveBeenNthCalledWith(1, expect.objectContaining({
      artifactId: 'a1',
      serverId: 'server-a',
      request: expect.objectContaining({
        executionOriginV1: expect.objectContaining({ serverId: 'server-a' }),
        status: 'approved',
      }),
    }));
    expect(approvalsUpdate).toHaveBeenNthCalledWith(2, expect.objectContaining({
      artifactId: 'a1',
      serverId: 'server-a',
      request: expect.objectContaining({
        executionOriginV1: expect.objectContaining({ serverId: 'server-a' }),
        status: 'executing',
      }),
    }));
    expect(approvalsUpdate).toHaveBeenNthCalledWith(3, expect.objectContaining({
      artifactId: 'a1',
      serverId: 'server-a',
      request: expect.objectContaining({
        executionOriginV1: expect.objectContaining({ serverId: 'server-a' }),
        status: 'executed',
      }),
    }));
  });

  it('executes approved prompt library actions even when the decision surface is ui', async () => {
    const approvalsGet = vi.fn(async () => createApprovalRequest('open', {
      actionId: 'prompt_doc.update',
      actionArgs: {
        artifactId: 'doc-1',
        title: 'Review prompt',
        markdown: '# Review',
      },
      summary: 'Update prompt',
    }));
    const approvalsUpdate = vi.fn(async () => ({ ok: true as const }));
    const promptDocUpdate = vi.fn(async () => ({ ok: true, artifactId: 'doc-1' }));

    const executor = createExecutor({ approvalsGet, approvalsUpdate, promptDocUpdate });

    const res = await executor.execute('approval.request.decide' as any, {
      artifactId: 'a1',
      decision: 'approve',
    }, {
      surface: 'ui',
      authority: 'present_user',
    });

    expect(res).toEqual({
      ok: true,
      result: {
        ok: true,
        status: 'executed',
        execution: expect.objectContaining({ ok: true }),
      },
    });
    expect(promptDocUpdate).toHaveBeenCalledWith({
      artifactId: 'doc-1',
      title: 'Review prompt',
      markdown: '# Review',
    });
  });

  it('does not bypass per-surface disablement when executing approved actions', async () => {
    const approvalsGet = vi.fn(async () => createApprovalRequest('open', {
      createdBy: { surface: 'system', sessionId: 's1' },
      requestedSurface: 'agent',
    }));
    const approvalsUpdate = vi.fn(async () => ({ ok: true as const }));
    const sessionSendMessage = vi.fn(async () => ({ status: 'accepted' as const, localId: 'local-1' }));

    const executor = createExecutor({
      approvalsGet,
      approvalsUpdate,
      sessionSendMessage,
      isActionEnabled: (_id, ctx) => ctx.surface !== 'agent',
    });

    const res = await executor.execute('approval.request.decide' as any, {
      artifactId: 'a1',
      decision: 'approve',
    }, {
      surface: 'ui',
      authority: 'present_user',
    });

    expect(res).toEqual({
      ok: true,
      result: {
        ok: true,
        status: 'failed',
        execution: expect.objectContaining({ ok: false, errorCode: 'action_disabled' }),
      },
    });
    expect(sessionSendMessage).not.toHaveBeenCalled();
  });

  it('does not bypass per-surface disablement when executing approvals created from the CLI surface', async () => {
    const approvalsGet = vi.fn(async () => createApprovalRequest('open', {
      createdBy: { surface: 'cli', sessionId: 's1' },
      requestedSurface: 'cli',
    }));
    const approvalsUpdate = vi.fn(async () => ({ ok: true as const }));
    const sessionSendMessage = vi.fn(async () => ({ status: 'accepted' as const, localId: 'local-1' }));

    const executor = createExecutor({
      approvalsGet,
      approvalsUpdate,
      sessionSendMessage,
      isActionEnabled: (_id, ctx) => ctx.surface !== 'cli',
    });

    const res = await executor.execute('approval.request.decide' as any, {
      artifactId: 'a1',
      decision: 'approve',
    }, {
      surface: 'ui',
      authority: 'present_user',
    });

    expect(res).toEqual({
      ok: true,
      result: {
        ok: true,
        status: 'failed',
        execution: expect.objectContaining({ ok: false, errorCode: 'action_disabled' }),
      },
    });
    expect(sessionSendMessage).not.toHaveBeenCalled();
  });

  it('resumes an already-approved approval by finalizing execution', async () => {
    const approvalsGet = vi.fn(async () => createApprovalRequest('approved'));
    const approvalsUpdate = vi.fn(async () => ({ ok: true as const }));
    const sessionSendMessage = vi.fn(async () => ({ status: 'accepted' as const, localId: 'local-1' }));

    const executor = createExecutor({ approvalsGet, approvalsUpdate, sessionSendMessage });

    const res = await executor.execute('approval.request.decide' as any, {
      artifactId: 'a1',
      decision: 'approve',
    });

    expect(res.ok).toBe(true);
    expect(sessionSendMessage).toHaveBeenCalledTimes(1);
    expect(sessionSendMessage).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 's1',
      message: 'hello',
      requestedAction: { v: 1, kind: 'steer_if_active' },
    }));
    // Resuming an already-approved row still claims it before the effect.
    expect(approvalsUpdate).toHaveBeenCalledTimes(2);
    expect(approvalsUpdate).toHaveBeenNthCalledWith(1, expect.objectContaining({
      artifactId: 'a1',
      request: expect.objectContaining({ status: 'executing' }),
    }));
    expect(approvalsUpdate).toHaveBeenNthCalledWith(2, expect.objectContaining({
      artifactId: 'a1',
      request: expect.objectContaining({
        status: 'executed',
        execution: expect.objectContaining({ ok: true }),
      }),
    }));
  });

  it.each(['initial-read', 'initial-replay-read', 'read', 'claim', 'claim-response', 'decision', 'settlement'] as const)('returns a recoverable typed outcome when the approval %s fails before execution', async failurePhase => {
    const initiallyApproved = failurePhase === 'initial-read' || failurePhase === 'initial-replay-read';
    let stored = createApprovalRequest(initiallyApproved ? 'approved' : 'open');
    let unavailable = true;
    let effects = 0;
    const executor = createExecutor({
      isApprovalExecutionOriginCurrent: async () => failurePhase !== 'settlement' || !unavailable,
      // Artifact IO is the real storage boundary; transitions and receipts use
      // the production owner and canonical schema beneath this boundary.
      approvalsGet: async () => {
        if (unavailable && (initiallyApproved
          || (failurePhase === 'read' || failurePhase === 'decision') && stored.status === 'approved')) {
          throw Object.assign(new Error('pool acquisition failed'), { code: 'P2024' });
        }
        return structuredClone(stored);
      },
      approvalsUpdate: async ({ request }) => {
        if (unavailable && failurePhase === 'claim-response' && request.status === 'executing') {
          return { ok: false, errorCode: 'update_failed', error: 'Failed to update artifact' };
        }
        if (unavailable && (failurePhase === 'claim' && request.status === 'executing'
          || failurePhase === 'settlement' && request.status === 'failed')) {
          throw Object.assign(new Error('pool acquisition failed'), { code: 'P2024' });
        }
        const transition = decideApprovalRequestTransition(stored, request);
        if (!transition.ok) return transition;
        stored = ApprovalRequestV2Schema.parse(request);
        if (unavailable && failurePhase === 'decision' && request.status === 'approved') {
          throw Object.assign(new Error('lost decision acknowledgement'), { code: 'P2024' });
        }
        return { ok: true };
      },
      sessionSendMessage: async () => {
        effects += 1;
        return { status: 'accepted', localId: 'recovered' };
      },
    });
    const decide = () => failurePhase === 'initial-replay-read'
      ? executor.replayApprovedApprovalRequest({ artifactId: 'a1' })
      : executor.execute('approval.request.decide', { artifactId: 'a1', decision: 'approve' });
    await expect(decide())
      .resolves.toMatchObject({ ok: false, errorCode: 'approval_context_unavailable', error: 'approval_context_unavailable' });
    expect(stored).toMatchObject({ status: 'approved', decision: { kind: 'approve' } });
    expect(stored.execution).toBeUndefined();
    expect(effects).toBe(0);

    unavailable = false;
    const recovered = await decide();
    expect(recovered).toMatchObject({ ok: true, result: { status: 'executed', execution: { ok: true } } });
    expect(getActionSpec('approval.request.decide').outputSchema!.safeParse(recovered.ok ? recovered.result : null).success).toBe(true);
    expect(ApprovalRequestV2Schema.parse(stored).status).toBe('executed');
    await expect(decide()).resolves.toEqual(recovered);
    expect(effects).toBe(1);
  });

  it.each(['throws', 'refuses'] as const)('keeps a lost execution claim acknowledgement outcome unknown instead of inviting a retry (%s)', async acknowledgement => {
    let stored = createApprovalRequest('approved');
    let effects = 0;
    const executor = createExecutor({
      approvalsGet: async () => structuredClone(stored),
      approvalsUpdate: async ({ request }) => {
        const transition = decideApprovalRequestTransition(stored, request);
        if (!transition.ok) return transition;
        stored = ApprovalRequestV2Schema.parse(request);
        if (request.status === 'executing') {
          if (acknowledgement === 'throws') throw Object.assign(new Error('lost acknowledgement'), { code: 'P2024' });
          return { ok: false, errorCode: 'update_failed', error: 'Failed to update artifact' };
        }
        return { ok: true };
      },
      sessionSendMessage: async () => { effects += 1; return { status: 'accepted', localId: 'unexpected' }; },
    });
    await expect(executor.execute('approval.request.decide', { artifactId: 'a1', decision: 'approve' }))
      .resolves.toMatchObject({ ok: false, errorCode: 'approval_execution_outcome_unknown' });
    expect(stored.status).toBe('executing');
    await expect(executor.execute('approval.request.decide', { artifactId: 'a1', decision: 'approve' }))
      .resolves.toMatchObject({ ok: false, errorCode: 'approval_execution_outcome_unknown' });
    expect(effects).toBe(0);
  });

  it.each(['origin', 'decision', 'unreadable'] as const)('does not invite approval recovery from a different or unreadable claim receipt (%s)', async receipt => {
    const stored = createApprovalRequest('approved');
    let claimRefused = false;
    let effects = 0;
    const executor = createExecutor({
      approvalsGet: async () => {
        if (!claimRefused) return structuredClone(stored);
        if (receipt === 'unreadable') throw new Error('read unavailable');
        if (stored.v !== 2) throw new Error('Expected current approval');
        return ApprovalRequestV2Schema.parse({ ...stored,
          ...(receipt === 'origin' ? { executionOriginV1: { ...stored.executionOriginV1, requestId: 'another-request' } }
            : { decision: { ...stored.decision, decidedAtMs: (stored.decision?.decidedAtMs ?? 0) + 1 } }),
        });
      },
      approvalsUpdate: async () => {
        claimRefused = true;
        return { ok: false, errorCode: 'update_failed', error: 'Failed to update artifact' };
      },
      sessionSendMessage: async () => { effects += 1; return { status: 'accepted', localId: 'unexpected' }; },
    });
    await expect(executor.execute('approval.request.decide', { artifactId: 'a1', decision: 'approve' }))
      .resolves.toMatchObject({ ok: false,
        errorCode: receipt === 'unreadable' ? 'approval_execution_outcome_unknown' : 'update_failed' });
    expect(effects).toBe(0);
    expect(stored.status).toBe('approved');
  });

  it('preserves an explicit execution claim permission refusal even while the approved receipt is unchanged', async () => {
    const stored = createApprovalRequest('approved');
    const executor = createExecutor({
      approvalsGet: async () => structuredClone(stored),
      approvalsUpdate: async () => ({ ok: false, errorCode: 'permission_denied', error: 'permission_denied' }),
    });
    await expect(executor.execute('approval.request.decide', { artifactId: 'a1', decision: 'approve' }))
      .resolves.toMatchObject({ ok: false, errorCode: 'permission_denied' });
  });

  it.each([
    {
      status: 'rejected',
      decision: 'reject',
      expected: { ok: true, result: { ok: true, status: 'rejected' } },
    },
    {
      status: 'executed',
      decision: 'approve',
      expected: {
        ok: true,
        result: { ok: true, status: 'executed', execution: expect.objectContaining({ ok: true }) },
      },
    },
    {
      status: 'failed',
      decision: 'approve',
      expected: {
        ok: true,
        result: { ok: true, status: 'failed', execution: expect.objectContaining({ ok: false, errorCode: 'action_failed' }) },
      },
    },
  ] as const)('returns the existing terminal result for duplicate $decision decisions on $status approvals', async ({ status, decision, expected }) => {
    const approvalsGet = vi.fn(async () => createApprovalRequest(status));
    const approvalsUpdate = vi.fn(async () => ({ ok: true as const }));
    const sessionSendMessage = vi.fn(async () => ({ status: 'accepted' as const, localId: 'local-1' }));

    const executor = createExecutor({ approvalsGet, approvalsUpdate, sessionSendMessage });

    const res = await executor.execute('approval.request.decide' as any, {
      artifactId: 'a1',
      decision,
    });

    expect(res).toEqual(expected);
    expect(approvalsUpdate).not.toHaveBeenCalled();
    expect(sessionSendMessage).not.toHaveBeenCalled();
  });

  it('refuses to mint an invitation when its blocking live caller is gone', async () => {
    const invitation = {
      id: 'invitation-1',
      teamId: 'team-1',
      state: 'active' as const,
      role: 'member' as const,
      historyAccess: 'from_membership' as const,
      recipientEmailMask: null,
      expiresAt: 2,
      createdAt: 1,
      createdByAccountId: 'account-1',
      acceptedByAccountId: null,
      lastEmailDelivery: null,
    };
    const rawResult = {
      invitation,
      joinUrl: 'https://home.example/join/one-time-bearer',
    };
    const request = createApprovalRequest('open', {
      actionId: 'teams.invitations.create',
      actionArgs: {
        v: 1,
        teamId: 'team-1',
        role: 'member',
        historyAccess: 'from_membership',
        recipientEmail: null,
        requestKey: 'request-1',
      },
      // `createdBy` is descriptive Artifact provenance; the immutable
      // execution origin below is the present-user UI authority.
      createdBy: { surface: 'system' },
      requestedSurface: 'ui',
      approval: { flow: 'blocking', result: 'required' },
    });
    if (request.v !== 2) throw new Error('expected V2 approval fixture');
    const {
      sessionId: _fixtureSessionId,
      target: _fixtureTarget,
      ...originWithoutFixtureSession
    } = request.executionOriginV1;
    let storedRequest: ApprovalRequestV2 = {
      ...request,
      executionOriginV1: {
        ...originWithoutFixtureSession,
        authority: 'present_user',
        surface: 'ui',
      },
    };
    const approvalsGet = vi.fn(async () => storedRequest);
    const approvalsUpdate = vi.fn(async ({ request: next }: { request: ApprovalRequest }) => {
      if (next.v !== 2) throw new Error('expected V2 approval update');
      storedRequest = next;
      return { ok: true as const };
    });
    const homeDomainAction = vi.fn(async () => rawResult);
    const executor = createExecutor({ approvalsGet, approvalsUpdate, homeDomainAction });

    await expect(executor.execute('approval.request.decide', {
      artifactId: 'a1',
      decision: 'approve',
    })).resolves.toEqual({
      ok: true,
      result: {
        ok: true,
        status: 'failed',
        execution: {
          executedAtMs: expect.any(Number),
          effectAttempted: false,
          ok: false,
          errorCode: 'approval_stale',
          error: 'approval_stale',
          details: { reason: 'live_invocation_unavailable' },
        },
      },
    });

    // The Artifact cannot restore a lost live result recipient. Refuse before
    // minting rather than strand a bearer behind its redacted history.
    expect(storedRequest.execution).toEqual({
      executedAtMs: expect.any(Number),
      effectAttempted: false,
      ok: false,
      errorCode: 'approval_stale',
      error: 'approval_stale',
      details: { reason: 'live_invocation_unavailable' },
    });
    await expect(executor.replayApprovedApprovalRequest({ artifactId: 'a1' })).resolves.toMatchObject({
      ok: true,
      result: {
        status: 'failed',
        execution: { ok: false, errorCode: 'approval_stale' },
      },
    });
    expect(homeDomainAction).not.toHaveBeenCalled();
    expect(approvalsUpdate).toHaveBeenCalledTimes(2);
  });

  it.each([
    { status: 'approved', decision: 'reject' },
    { status: 'rejected', decision: 'approve' },
    { status: 'executed', decision: 'reject' },
    { status: 'failed', decision: 'reject' },
    { status: 'canceled', decision: 'approve' },
    { status: 'canceled', decision: 'reject' },
  ] as const)('rejects deciding a $status approval without mutating or executing', async ({ status, decision }) => {
    const approvalsGet = vi.fn(async () => createApprovalRequest(status));
    const approvalsUpdate = vi.fn(async () => ({ ok: true as const }));
    const sessionSendMessage = vi.fn(async () => ({ status: 'accepted' as const, localId: 'local-1' }));

    const executor = createExecutor({ approvalsGet, approvalsUpdate, sessionSendMessage });

    const res = await executor.execute('approval.request.decide' as any, {
      artifactId: 'a1',
      decision,
    });

    expect(res).toEqual({ ok: false, errorCode: 'approval_not_open', error: 'approval_not_open' });
    expect(approvalsUpdate).not.toHaveBeenCalled();
    expect(sessionSendMessage).not.toHaveBeenCalled();
  });

  it('does not re-execute an approval on duplicate approve delivery', async () => {
    let storedRequest = createApprovalRequest('open');
    const approvalsGet = vi.fn(async () => storedRequest);
    const approvalsUpdate = vi.fn(async ({ request }: { request: ApprovalRequest }) => {
      storedRequest = request;
      return { ok: true as const };
    });
    const sessionSendMessage = vi.fn(async () => ({ status: 'accepted' as const, localId: 'local-1' }));

    const executor = createExecutor({ approvalsGet, approvalsUpdate, sessionSendMessage });

    const first = await executor.execute('approval.request.decide' as any, {
      artifactId: 'a1',
      decision: 'approve',
    });
    const second = await executor.execute('approval.request.decide' as any, {
      artifactId: 'a1',
      decision: 'approve',
    });

    expect(first.ok).toBe(true);
    expect(second).toEqual({
      ok: true,
      result: {
        ok: true,
        status: 'executed',
        execution: expect.objectContaining({ ok: true }),
      },
    });
    expect(sessionSendMessage).toHaveBeenCalledTimes(1);
    // approved, executing, executed. The duplicate delivery reads the terminal
    // row and writes nothing.
    expect(approvalsUpdate).toHaveBeenCalledTimes(3);
  });

  // FINALIZATION-PLAN §3.2 activation proof: after the per-family `RUNTIME_ACTION_DISABLED_SURFACES`
  // flip, a dangerous AGENT-initiated runtime action now passes the enablement gate and REACHES the
  // surface-keyed approval floor (`AGENT_INITIATED_APPROVAL_REQUIRED_ACTION_IDS`, wired through the
  // real `isApprovalRequiredByActionsSettings`) — it is no longer short-circuited by `action_disabled`
  // (finding #31). User-initiated forms execute the runtime directly with no prompt.
  describe('§3.2 agent-approval activation (runtime families flipped on agent)', () => {
    // `browser.context.capturePage` is approval-floored for `agent` AND in
    // RESULT_REQUIRED → a `blocking` approval flow, so the executor waits for a decision. We
    // resolve the decision deterministically per-test to prove the routing path.
    const wireApprovalFloor = (
      runtimeActionExecute: ReturnType<typeof vi.fn>,
      approvalsCreate: ReturnType<typeof vi.fn>,
      decision: 'approve' | 'reject' = 'reject',
    ) =>
      createExecutor({
        runtimeActionExecute,
        approvalsCreate,
        approvalsWaitForDecision: vi.fn(async ({ request }: any) => ({
          decision,
          request: {
            ...request,
            status: decision === 'approve' ? 'approved' : 'rejected',
            decision: { kind: decision === 'approve' ? 'approve' : 'reject', decidedAtMs: 2 },
          },
        })),
        approvalsUpdate: vi.fn(async () => ({ ok: true })),
        // Wire the REAL surface-keyed approval floor exactly as the production default executor
        // does, with no persisted overrides — the dangerous agent subset must still be gated.
        isActionApprovalRequired: (actionId, ctx) =>
          isApprovalRequiredByActionsSettings(actionId, defaultActionsSettings, ctx),
      } as any);
    const capturedPageResult = {
      v: 1,
      kind: 'browserPageReference',
      contextId: 'context_1',
      sourceViewId: 'v1',
      sourceAdapterKind: 'localPreview',
      fidelity: 'previewProxy',
      capturedAtMs: 1,
      navigationGeneration: 0,
      lifecycleState: 'available',
      redactionLevel: 'none',
    } as const;
    const attachedContextResult = {
      v: 1,
      attachmentId: 'attachment_1',
      contextId: 'context_1',
      sourceViewId: 'v1',
      capturedNavigationGeneration: 0,
      currentNavigationGeneration: 0,
      state: 'available',
    } as const;

    it('routes an agent-initiated dangerous capture to the approval gate (not action_disabled)', async () => {
      const runtimeActionExecute = vi.fn(async () => ({ captured: true }));
      const approvalsCreate = vi.fn(async () => ({ artifactId: 'cap-1' }));
      const executor = wireApprovalFloor(runtimeActionExecute, approvalsCreate, 'reject');

      const res = await executor.execute(
        'browser.context.capturePage' as any,
        { browserSessionId: 'bs1', viewId: 'v1' },
        { surface: 'agent', defaultSessionId: 's1' },
      );

      // Reaches the APPROVAL gate (NOT the disabled gate); rejected → runtime never runs. This is
      // the §3.2 activation proof: pre-flip this would have short-circuited to `action_disabled`.
      expect((res as any).errorCode).toBe('approval_rejected');
      expect(approvalsCreate).toHaveBeenCalledTimes(1);
      expect(runtimeActionExecute).not.toHaveBeenCalled();
    });

    it('runs the runtime executor for an agent capture once approval is granted', async () => {
      const runtimeActionExecute = vi.fn(async () => capturedPageResult);
      const approvalsCreate = vi.fn(async () => ({ artifactId: 'cap-3' }));
      const executor = wireApprovalFloor(runtimeActionExecute, approvalsCreate, 'approve');

      const res = await executor.execute(
        'browser.context.capturePage' as any,
        { browserSessionId: 'bs1', viewId: 'v1' },
        { surface: 'agent', defaultSessionId: 's1' },
      );

      expect(res).toEqual({ ok: true, result: capturedPageResult });
      expect(approvalsCreate).toHaveBeenCalledTimes(1);
      expect(runtimeActionExecute).toHaveBeenCalledTimes(1);
    });

    it('executes the same capture user-initiated (ui) with no approval prompt', async () => {
      const runtimeActionExecute = vi.fn(async () => capturedPageResult);
      const approvalsCreate = vi.fn(async () => ({ artifactId: 'cap-2' }));
      const executor = wireApprovalFloor(runtimeActionExecute, approvalsCreate, 'reject');

      const res = await executor.execute(
        'browser.context.capturePage' as any,
        { browserSessionId: 'bs1', viewId: 'v1' },
        { surface: 'ui', defaultSessionId: 's1' },
      );

      expect(res).toEqual({ ok: true, result: capturedPageResult });
      expect(runtimeActionExecute).toHaveBeenCalledTimes(1);
      expect(approvalsCreate).not.toHaveBeenCalled();
    });

    it('routes agent-initiated browser context attach to approvals by default', async () => {
      const runtimeActionExecute = vi.fn(async () => ({ attached: true }));
      const approvalsCreate = vi.fn(async () => ({ artifactId: 'attach-1' }));
      const executor = wireApprovalFloor(runtimeActionExecute, approvalsCreate, 'reject');

      const res = await executor.execute(
        'browser.context.attachToComposer' as any,
        { browserSessionId: 'bs1', viewId: 'v1' },
        { surface: 'agent', defaultSessionId: 's1' },
      );

      expect((res as any).errorCode).toBe('approval_rejected');
      expect(approvalsCreate).toHaveBeenCalledTimes(1);
      expect(runtimeActionExecute).not.toHaveBeenCalled();
    });

    it('keeps user-initiated browser context attach unprompted', async () => {
      const runtimeActionExecute = vi.fn(async () => attachedContextResult);
      const approvalsCreate = vi.fn(async () => ({ artifactId: 'attach-2' }));
      const executor = wireApprovalFloor(runtimeActionExecute, approvalsCreate, 'reject');

      const res = await executor.execute(
        'browser.context.attachToComposer' as any,
        { browserSessionId: 'bs1', viewId: 'v1' },
        { surface: 'ui', defaultSessionId: 's1' },
      );

      expect(res).toEqual({
        ok: true,
        result: {
          ...attachedContextResult,
          requiresReconfirmBeforeSend: false,
        },
      });
      expect(runtimeActionExecute).toHaveBeenCalledTimes(1);
      expect(approvalsCreate).not.toHaveBeenCalled();
    });

    it('still fail-closes an unsurfaced runtime action on agent (devices.simulator.input.orientation)', async () => {
      const runtimeActionExecute = vi.fn(async () => ({ ok: true }));
      const approvalsCreate = vi.fn(async () => ({ artifactId: 'd-1' }));
      const executor = wireApprovalFloor(runtimeActionExecute, approvalsCreate, 'reject');

      const res = await executor.execute(
        'devices.simulator.input.orientation' as any,
        { type: 'simulator.input.orientation', orientation: 'landscapeLeft' },
        { surface: 'agent', defaultSessionId: 's1' },
      );

      // Statically-unbacked (no producer) → UNSURFACED on every surface; the approval gate is never
      // reached. (The browser-diagnostics interaction verbs are now executor-backed and surfaced.)
      expect(res).toEqual(expect.objectContaining({
        ok: false,
        errorCode: 'action_disabled',
        error: 'action_disabled',
        details: expect.objectContaining({
          actionId: 'devices.simulator.input.orientation',
          surface: 'agent',
          reason: 'unsupported_surface',
        }),
      }));
      expect(approvalsCreate).not.toHaveBeenCalled();
      expect(runtimeActionExecute).not.toHaveBeenCalled();
    });
  });
});
