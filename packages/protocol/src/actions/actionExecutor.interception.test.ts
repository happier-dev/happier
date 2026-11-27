import { ActionsSettingsV1Schema } from './actionSettings.js';
import { describe, expect, it, vi } from 'vitest';

import { createActionExecutor, buildActionExecuteResultFromRecordedApprovalExecution, type ActionExecutorDeps, type ActionExecutorContext } from './actionExecutor.js';
import { getActionSpec } from './actionSpecs.js';
import * as authority from './decisionAuthority.js';
import * as credentials from '../auth/apiTokenGrant.js';
import * as callerContext from './executor/callerContext.js';
import { createActionAutomationPortV1 } from './executor/actionAutomationAdmission.js';
import { createEmptyActionAutomationPortV1 } from './executor/actionAutomationAdmission.testkit.js';
import { createActionAutomationInvocationV1, type ActionSettlementV1 } from './executor/actionSettlement.js';
import { automationSubjectKeyV1 } from '../automations/automationSubjectV1.js';
import { DEPLOYMENT_DEPLOY_ACTION_ID_V1 } from '../deployments/deploymentActionIdsV1.js';

function createExecutor(overrides: Partial<ActionExecutorDeps> = {}) {
  return createActionExecutor({
    actionAutomations: createEmptyActionAutomationPortV1(),
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
    sessionSendMessage: async () => ({}),
    sessionPermissionRespond: async () => ({}),
    sessionUserActionAnswer: async () => ({}),
    sessionModeSet: async () => ({}),
    sessionModesList: async () => ({ items: [] }),
    sessionTargetPrimarySet: async () => ({}),
    sessionTargetTrackedSet: async () => ({}),
    sessionList: async () => ({ sessions: [] }),
    sessionActivityGet: async () => ({}),
    sessionRecentMessagesGet: async () => ({}),
    daemonMemorySearch: async () => ({ v: 1, ok: true as const, hits: [] }),
    daemonMemoryGetWindow: async () => ({ v: 1, snippets: [], citations: [] }),
    daemonMemoryEnsureUpToDate: async () => ({}),
    resetGlobalVoiceAgent: async () => {},
    ...overrides,
  });
}

describe('createActionExecutor execution interception', () => {
  it.each([
    { surface: 'voice', authority: 'account_automation', pendingPhases: ['checking', 'override'] },
    { surface: 'ui', authority: 'present_user', pendingPhases: ['checking'] },
  ] as const)('notifies the retained $surface presenter when a before-check asks for a person', async ({ surface, authority, pendingPhases }) => {
    const actionId = 'connectedServices.authentication.beginConnect';
    let stored: Parameters<NonNullable<ActionExecutorDeps['approvalsCreate']>>[0]['request'] | null = null;
    const port = createActionAutomationPortV1({
      accountId: 'actor',
      seed: async () => ({ v: 1, rows: [{
        automationId: 'review', triggerId: 'before', triggerRevision: 1, workflowId: 'workflow', workflowRevision: 1,
        ownerAccountId: 'actor', actionIds: [actionId], phase: 'before', mode: 'wait', onFailure: 'ask',
      }] }),
      start: async () => ({ runs: [{ automationId: 'review', triggerId: 'before', runId: 'check' }], notices: [] }),
      settle: async () => {},
    });
    type PendingApproval = Parameters<NonNullable<ActionExecutorDeps['approvalsWaitForDecision']>>[0];
    const notifyPresenter = vi.fn<(pending: PendingApproval) => void>();
    const approvalsWaitForDecision = vi.fn(async (pending: PendingApproval) => {
      // The mounted waiter presents the original request before awaiting a decision.
      notifyPresenter(pending);
      return { decision: 'reject' as const, request: pending.request };
    });
    const connectedServiceAction = vi.fn();
    const executor = createActionExecutor({
      actionAutomations: { ...port, wait: async () => ({ state: 'failed', errorCode: 'command_failed' }) },
      approvalsCreate: async ({ request }) => { stored = request; return { artifactId: 'approval' }; },
      approvalsGet: async () => stored,
      approvalsUpdate: async ({ request }) => { stored = request; return { ok: true }; },
      approvalsNotifyBlockingPending: notifyPresenter,
      approvalsWaitForDecision,
      isApprovalExecutionOriginCurrent: async () => true,
      connectedServiceAction,
    });
    try {
      const result = await executor.execute(actionId, {
        machineId: 'machine', service: { pluginId: 'example.accounts', localId: 'service' }, modeId: 'password',
      }, {
        surface, authority, actionCaller: { kind: 'host' },
        serverId: 'home', serverIdentityId: 'home', runtimeAccountId: 'actor', actionRequestId: 'before-check',
        defaultSessionMachineId: 'machine',
        actionsSettings: ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: { [actionId]: [surface] } }),
      });
      expect(result, JSON.stringify(result)).toMatchObject({ ok: false, errorCode: 'approval_rejected' });
      expect(stored).toMatchObject({ status: 'open', automaticChecks: { phase: 'override', humanApprovalRequired: false } });
      expect(notifyPresenter.mock.calls).toEqual(pendingPhases.map(phase => [
        expect.objectContaining({
          artifactId: 'approval',
          request: phase === 'override' ? stored : expect.objectContaining({
            automaticChecks: expect.objectContaining({ phase, humanApprovalRequired: false }),
          }),
        }),
      ]));
      expect(approvalsWaitForDecision).toHaveBeenCalledOnce();
      expect(connectedServiceAction).not.toHaveBeenCalled();
    } finally { port.dispose(); }
  });

  it.each((['skipped', 'unavailable'] as const).flatMap(outcome =>
    (['host', 'workflowRun'] as const).map(callerKind => ({ outcome, callerKind }))))(
    'settles a before-wait admission with no Run as $outcome for $callerKind', async ({ outcome, callerKind }) => {
    const actionId = 'example.fixture/actions/write';
    let effects = 0;
    let effectAuthority: ActionExecutorContext['authority'];
    let stored: Parameters<NonNullable<ActionExecutorDeps['approvalsCreate']>>[0]['request'] | null = null;
    const port = createActionAutomationPortV1({ accountId: 'actor', seed: async () => ({ v: 1, rows: [
      { automationId: 'review', triggerId: 'before', triggerRevision: 1, workflowId: 'workflow', workflowRevision: 1,
        ownerAccountId: 'actor', actionIds: [actionId], phase: 'before', mode: 'wait', onFailure: 'refuse' },
    ] }), start: async () => ({ runs: [], notices: outcome === 'skipped'
      ? [{ code: 'action_automation_skipped', reason: 'causeSuppressed', automationId: 'review', triggerId: 'before', workflowId: 'workflow' }]
      : [] }) });
    // Approval persistence and the contributed effect host are external boundaries.
    const executor = createActionExecutor({ actionAutomations: port,
      approvalsCreate: async ({ request }) => { stored = request; return { artifactId: 'approval' }; },
      approvalsGet: async () => stored,
      approvalsUpdate: async ({ request }) => { stored = request; return { ok: true }; },
      isApprovalExecutionOriginCurrent: async () => true,
      invokeContributedAction: async ({ context }) => { effects++; effectAuthority = context.authority;
        return { ok: true, result: { applied: true } }; },
    });
    try {
      const context: ActionExecutorContext = {
        surface: callerKind === 'host' ? 'cli' : 'agent',
        authority: callerKind === 'host' ? 'present_user' : 'account_automation',
        actionCaller: callerKind === 'host' ? { kind: 'host' } : { kind: 'workflowRun', runId: 'check-run',
          authorization: { principal: { kind: 'host' }, admittedPermissionCeiling: 'default' },
          authenticatedStarterV1: { requestRef: 'start-check', requester: { serverId: 'home', accountId: 'actor' } } },
        bypassApprovals: true,
        serverId: 'home', serverIdentityId: 'home', runtimeAccountId: 'actor', actionRequestId: 'no-run-request',
        defaultSessionMachineId: 'machine',
      };
      const selection = await port.select({ actionId, input: {}, context });
      expect(selection.before).toHaveLength(1);
      const result = await executor.execute('action.invoke', {
        action: { pluginId: 'example.fixture', localId: 'write' }, input: {},
      }, { ...context, actionAutomationAdmission: createActionAutomationInvocationV1({ actionId, context, selection, port })
      });
      expect(result, JSON.stringify(result)).toMatchObject(outcome === 'skipped' ? { ok: true } : { ok: false, errorCode: 'target_unavailable' });
      expect(effects).toBe(outcome === 'skipped' ? 1 : 0);
      if (outcome === 'skipped') expect(effectAuthority).toBe(context.authority);
    } finally { port.dispose(); }
  });

  it.each([
    ['builtin', 'wait'], ['contributed', 'wait'], ['builtin', 'notify'], ['contributed', 'notify'],
  ] as const)('publishes one settlement after a prepared %s before-%s check resumes', async (kind, mode) => {
    const actionId = kind === 'builtin' ? 'account.name.set' : 'example.fixture/actions/write';
    const events: ActionSettlementV1[] = [];
    let stored: Parameters<NonNullable<ActionExecutorDeps['approvalsCreate']>>[0]['request'] | null = null;
    let effects = 0;
    const port = createActionAutomationPortV1({ accountId: 'actor', seed: async () => ({ v: 1, rows: [
      { automationId: 'review', triggerId: 'before', triggerRevision: 1, workflowId: 'workflow', workflowRevision: 1,
        ownerAccountId: 'actor', actionIds: [actionId], phase: 'before', mode, ...(mode === 'wait' ? { onFailure: 'refuse' } : {}) },
      { automationId: 'review', triggerId: 'after', triggerRevision: 1, workflowId: 'workflow', workflowRevision: 1,
        ownerAccountId: 'actor', actionIds: [actionId], phase: 'after' },
    ] }), start: async ({ selected }) => ({ runs: selected.map(row => ({ automationId: row.automationId,
      triggerId: row.triggerId, runId: 'before-run' })), notices: mode === 'notify'
      ? [{ code: 'action_automation_skipped', reason: 'causeSuppressed', automationId: 'review', triggerId: 'before', workflowId: 'workflow' }]
      : [] }),
    settle: async ({ event }) => { events.push(event); } });
    const actionAutomations = { ...port, wait: async () => ({ state: 'succeeded' as const }) };
    // Approval storage and the contributed/Home effect hosts are external boundaries.
    const executor = createActionExecutor({ actionAutomations,
      approvalsCreate: async ({ request }) => { stored = request; return { artifactId: 'approval' }; },
      approvalsGet: async () => stored,
      approvalsUpdate: async ({ request }) => { stored = request; return { ok: true }; },
      isApprovalExecutionOriginCurrent: async () => true,
      homeDomainAction: async () => { effects++; return { name: 'Accepted', firstName: null, lastName: null, timestamp: 1 }; },
      invokeContributedAction: async ({ context }) => {
        effects++;
        const result = { ok: true as const, result: { applied: true } };
        return context.actionAutomationAdmission?.settle(result, context) ?? result;
      },
    });
    let context: ActionExecutorContext = { surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' },
      serverId: 'home', serverIdentityId: 'home', runtimeAccountId: 'actor', actionRequestId: 'prepared-request',
      defaultSessionMachineId: 'machine', bypassApprovals: true };
    try {
      if (kind === 'contributed') {
        // The contributed invocation owner admits the qualified selection before entering action.invoke.
        const selection = await port.select({ actionId, input: {}, context });
        context = { ...context, actionAutomationAdmission: createActionAutomationInvocationV1({ actionId,
          context, selection, port: actionAutomations }) };
      }
      const prepared = kind === 'builtin'
        ? await executor.prepare('account.name.set', { name: 'Accepted' }, context)
        : await executor.prepare('action.invoke', { action: { pluginId: 'example.fixture', localId: 'write' }, input: {} }, context);
      expect(prepared.kind, JSON.stringify(prepared)).toBe('ready');
      if (prepared.kind !== 'ready') throw new Error('Expected a prepared invocation');
      const result = await prepared.invocation.run();
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
      expect(effects).toBe(1);
      expect(events).toMatchObject([{ actionId, requestId: 'prepared-request', status: 'succeeded' }]);
      expect(events).toHaveLength(1);
      if (mode === 'notify') expect(result.automationNotices).toEqual([{ code: 'action_automation_skipped', reason: 'causeSuppressed',
        automationId: 'review', triggerId: 'before', workflowId: 'workflow' }]);
    } finally { port.dispose(); }
  });

  it.each(['after-only', 'known-empty', 'unavailable'] as const)('retains the admitted %s snapshot through an ordinary human approval', async mode => {
    let storedRequest: Parameters<NonNullable<ActionExecutorDeps['approvalsCreate']>>[0]['request'] | null = null;
    const events: ActionSettlementV1[] = [];
    const row = {
      automationId: 'review', triggerId: 'after', triggerRevision: 1, workflowId: 'review-workflow', workflowRevision: 1,
      ownerAccountId: 'actor', phase: 'after' as const, actionIds: ['account.name.set'],
    };
    const port = createActionAutomationPortV1({ accountId: 'actor', seed: async () => {
      if (mode === 'unavailable') throw Object.assign(new Error('unavailable'), { code: 'seed_unavailable' });
      return { v: 1, rows: mode === 'after-only' ? [row] : [] };
    }, settle: async ({ event }) => { events.push(event); } });
    let effects = 0;
    const writes: string[] = [];
    // Approval storage, Home HTTP and current host identity are external boundaries.
    const executor = createActionExecutor({ actionAutomations: port,
      approvalsCreate: async ({ request }) => { storedRequest = request; return { artifactId: 'approval' }; },
      approvalsGet: async () => storedRequest,
      approvalsUpdate: async ({ request }) => { storedRequest = request; writes.push(request.status); return { ok: true }; },
      isApprovalExecutionOriginCurrent: async () => true,
      homeDomainAction: async () => { effects++; return { ok: false, errorCode: 'forbidden', error: 'forbidden' }; },
    });
    try {
      const pending = await executor.execute('account.name.set', { name: 'private-name' }, {
        surface: 'cli', authority: 'account_automation', actionCaller: { kind: 'host' },
        serverId: 'home', serverIdentityId: 'home', runtimeAccountId: 'actor', actionRequestId: 'original-request',
        actionsSettings: ActionsSettingsV1Schema.parse({ v: 1,
          actions: { 'account.name.set': { approvalRequiredSurfaces: ['cli'] } } }),
      });
      expect(pending).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
      if (mode === 'unavailable') expect(pending.automationNotices)
        .toEqual([{ code: 'action_automations_not_checked', reason: 'seed_unavailable' }]);
      expect(events).toEqual([]);
      port.apply({ automationId: 'review', rows: mode === 'after-only' ? [] : [row] });
      const decided = await executor.execute('approval.request.decide', { artifactId: 'approval', decision: 'approve' }, {
        surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' },
        serverId: 'home', serverIdentityId: 'home', runtimeAccountId: 'actor',
      });
      expect(decided).toMatchObject({ ok: true, result: { status: 'failed', execution: { errorCode: 'forbidden' } } });
      expect(effects).toBe(1);
      if (mode === 'after-only') expect(events).toMatchObject([
        { requestId: 'original-request', actionId: 'account.name.set', status: 'failed' },
      ]);
      expect(events).toHaveLength(mode === 'after-only' ? 1 : 0);
      expect(writes).toEqual(['approved', 'executing', 'failed']);
      if (mode === 'unavailable') {
        const notices = [{ code: 'action_automations_not_checked', reason: 'seed_unavailable' }];
        expect(decided.automationNotices).toEqual(notices);
        if (!storedRequest) throw new Error('Missing approval execution receipt');
        expect(buildActionExecuteResultFromRecordedApprovalExecution(storedRequest)?.automationNotices).toEqual(notices);
      }
    } finally { port.dispose(); }
  });

  it.each(['effect', 'pending approval'] as const)('retains the unavailable-check notice on the %s result', async mode => {
    const port = createActionAutomationPortV1({ accountId: 'actor',
      // Seed HTTP, approval storage and Home-domain HTTP are external boundaries.
      seed: async () => { throw Object.assign(new Error('private-network-error'), { code: 'seed_unavailable' }); },
      settle: async () => { throw new Error('An unavailable selection cannot publish'); } });
    let effects = 0;
    const executor = createActionExecutor({ actionAutomations: port,
      approvalsCreate: async () => ({ artifactId: 'approval' }),
      homeDomainAction: async () => { effects++; return { ok: false, errorCode: 'forbidden', error: 'forbidden' }; } });
    try {
      const result = await executor.execute('account.name.set', { name: 'private-name' }, {
        surface: 'cli', authority: mode === 'effect' ? 'present_user' : 'account_automation',
        actionCaller: { kind: 'host' }, serverId: 'home', serverIdentityId: 'home', runtimeAccountId: 'actor',
        actionRequestId: 'notice-request',
        ...(mode === 'effect' ? { bypassApprovals: true } : { actionsSettings: ActionsSettingsV1Schema.parse({
          v: 1, actions: { 'account.name.set': { approvalRequiredSurfaces: ['cli'] } },
        }) }),
      });
      expect(result.automationNotices).toEqual([{ code: 'action_automations_not_checked', reason: 'seed_unavailable' }]);
      expect(JSON.stringify(result)).not.toContain('private-network-error');
      expect(effects).toBe(mode === 'effect' ? 1 : 0);
      expect(result).toMatchObject(mode === 'effect' ? { ok: false, errorCode: 'forbidden' }
        : { ok: true, result: { kind: 'approval_request_created', artifactId: 'approval', actionId: 'account.name.set' } });
    } finally { port.dispose(); }
  });

  it('settles each material Session target with its own request and subject', async () => {
    const events: ActionSettlementV1[] = [];
    const port = createActionAutomationPortV1({ accountId: 'actor', seed: async () => ({ v: 1, rows: [{
      automationId: 'auto', triggerId: 'trigger', triggerRevision: 1, workflowId: 'workflow', workflowRevision: 1,
      ownerAccountId: 'actor', actionIds: ['session.turn.cancel'], phase: 'after',
    }] }), settle: async ({ event }) => { events.push(event); } });
    let effects = 0;
    // Session RPC transport is the external boundary; selector/admission/settlement remain real.
    const executor = createActionExecutor({ actionAutomations: port,
      sessionTurnCancel: async () => { effects++; return { requested: true }; } });
    try {
      const result = await executor.execute('session.turn.cancel', { sessionId: { selector: 'workers' } }, {
        surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' },
        serverId: 'home', serverIdentityId: 'home', runtimeAccountId: 'actor', bypassApprovals: true,
        actionRequestId: 'parent-request', sessionTargetsV1: { actionId: 'session.turn.cancel', field: 'sessionId',
          targets: [{ serverId: 'home', sessionId: 's1' }, { serverId: 'home', sessionId: 's2' }], selector: true },
      });
      expect(result.ok).toBe(true);
      expect(effects).toBe(2);
      expect(events).toHaveLength(2);
      expect(new Set(events.map(event => event.requestId)).size).toBe(2);
      expect(events.map(event => event.subjects.filter(context => context.subject.kind === 'session')
        .map(context => context.subject.kind === 'session' ? context.subject.sessionId : undefined))).toEqual([['s1'], ['s2']]);
    } finally { port.dispose(); }
  });

  it('asks once for both shared phases of a native completion Action at admission', async () => {
    const actionId = DEPLOYMENT_DEPLOY_ACTION_ID_V1;
    const input = { serverId: 'home', environmentId: 'staging', expectedRevision: 1, requestKey: 'redeploy',
      targetLinkId: 'runtime', expectedTargetLinkRevision: 1, contentArtifactId: 'definition',
      contentHeaderVersion: 1, contentBodyVersion: 1 };
    const subject = { kind: 'environment', serverId: 'home', environmentId: 'staging' } as const;
    const shared = { automationId: 'shared', triggerRevision: 1, workflowId: 'workflow',
      workflowRevision: 1, ownerAccountId: 'author', actionIds: [actionId], reachesOthers: true,
      subjectKind: subject.kind, subjectKey: automationSubjectKeyV1(subject, 'workflow') };
    const rows = [
      { ...shared, triggerId: 'before', phase: 'before', mode: 'wait' },
      { ...shared, triggerId: 'after', phase: 'after' },
      { ...shared, triggerId: 'other-environment', phase: 'after',
        subjectKey: automationSubjectKeyV1({ ...subject, environmentId: 'other' }, shared.workflowId) },
      { ...shared, triggerId: 'own-after', phase: 'after', ownerAccountId: 'actor', subjectKey: automationSubjectKeyV1(subject) },
    ];
    const port = createActionAutomationPortV1({ accountId: 'actor', seed: async () => ({ v: 1, rows }),
      settle: async () => {} });
    const cards: unknown[] = [];
    const deploy = vi.fn(async () => ({ ok: false as const, errorCode: 'deployment_boundary_observed', error: 'deployment_boundary_observed' }));
    const executor = createExecutor({ actionAutomations: port, deploymentAction: deploy,
      resolveEnvironmentApprovalScope: async () => ({ scope: { kind: 'environment', environmentId: subject.environmentId } }),
      approvalsCreate: async ({ request }) => { cards.push(request); return { artifactId: 'check-consent' }; } });
    const requestId = 'native-redeploy';
    const context: ActionExecutorContext = { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
      serverId: 'home', serverIdentityId: 'home', runtimeAccountId: 'actor', defaultSessionMachineId: 'machine',
      actionRequestId: requestId, presentUserConfirmation: { actionId, requestId, accountId: 'actor', serverId: 'home',
        target: null, inputDigest: authority.computeActionInputApprovalDigestV1(actionId, input) } };

    const result = await executor.execute(actionId, input, context);
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true,
      result: { kind: 'approval_request_created', artifactId: 'check-consent' } });
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ automaticChecks: { phase: 'consent', consents: [
      { triggerId: 'before', decision: 'pending' }, { triggerId: 'after', decision: 'pending' },
    ] } });
    expect(deploy).not.toHaveBeenCalled();
  });

  it('keeps an external caller\'s own Before check with no Machine instead of skipping it', async () => {
    const row = { automationId: 'own', triggerId: 'before', triggerRevision: 1, workflowId: 'workflow',
      workflowRevision: 1, ownerAccountId: 'actor', actionIds: ['account.name.set'], phase: 'before', mode: 'wait' };
    const port = createActionAutomationPortV1({ accountId: 'actor', seed: async () => ({ v: 1, rows: [row] }),
      settle: async () => {} });
    let effects = 0;
    const profile = { name: 'QA', firstName: 'QA', lastName: null, timestamp: 1 };
    const executor = createExecutor({ actionAutomations: port,
      homeDomainAction: async () => { effects++; return profile; } });

    const result = await executor.execute('account.name.set', { name: 'QA' }, {
      surface: 'api', authority: 'account_automation', actionCaller: { kind: 'host' },
      serverId: 'home', serverIdentityId: 'home', runtimeAccountId: 'actor', bypassApprovals: true,
      externalActionCredential: { accountId: 'actor', principalId: 'token', credentialId: 'token',
        grant: credentials.API_TOKEN_FULL_GRANT_V1 },
    });
    // The own wait check is selected, so this host without approval custody refuses before the effect.
    expect(result, JSON.stringify(result)).toMatchObject({ ok: false, errorCode: 'approvals_not_supported' });
    expect(result).not.toHaveProperty('automationNotices');
    expect(effects).toBe(0);
  });

  it('observes an admitted pending deployment without evaluating its grant again', async () => {
    const grants = vi.spyOn(credentials, 'evaluateApiTokenGrantV1');
    const grant = { ...credentials.API_TOKEN_FULL_GRANT_V1 };
    const credential = { accountId: 'account', principalId: 'token', credentialId: 'token', grant };
    const input = { serverId: 'home', environmentId: 'environment', requestKey: 'deploy', targetLinkId: 'link' };
    const executor = createExecutor({
      resolveEnvironmentApprovalScope: async () => ({ scope: { kind: 'environment', environmentId: 'environment' } }),
      prepareDeploymentAction: async () => ({ observePendingOperation: async () => ({ ok: true,
        result: { ok: true, environmentId: 'environment', revision: 4, kind: 'pending', actionOperationId: 'operation' } }) }),
    });
    try {
      const prepared = await executor.prepare('deployments.deploy', input, {
        surface: 'api', authority: 'account_automation', serverId: 'home', bypassApprovals: true,
        externalActionCredential: credential, externalActionTarget: { kind: 'machine', machineId: 'machine' },
        externalActionExecutionAuthorization: { v: 1, token: 'signed', binding: {
          ...credential, serverIdentityId: 'home', custodianAccountId: 'account', installationId: 'installation',
          actionId: 'deployments.deploy', machineId: 'machine', target: { kind: 'machine', machineId: 'machine' },
          requestId: 'deploy', requestEnvelopeDigest: 'A'.repeat(43), environmentId: 'environment',
        } },
      });
      expect(prepared.kind, JSON.stringify(prepared)).toBe('ready');
      if (prepared.kind !== 'ready') throw new Error('Expected admitted pending operation');
      grants.mockClear();
      await expect(prepared.invocation.run()).resolves.toMatchObject({ ok: true, result: { kind: 'pending' } });
      expect(grants).not.toHaveBeenCalled();
    } finally { grants.mockRestore(); }
  });
  it('admits discussion participants once and spends the prepared machine-target grant at dispatch', async () => {
    const targets = vi.spyOn(credentials, 'isApiTokenGrantTargetMemberV1');
    const machineReads = vi.fn(async () => 'machine');
    const executor = createExecutor({
      resolveApiTokenGrantSessionMachineId: machineReads,
      discussionAction: async () => ({ v: 1, serverId: 'home', discussion: {
        id: 'discussion', ownerAccountId: 'account', title: 'Review', encryptionMode: 'plain',
        anchor: null, access: 'owner', keyReadiness: true, dataEncryptionKey: null, creationLocalId: 'review',
        latestMessage: { id: 'first', localId: 'first', seq: 1, authorAccountId: 'account',
          accountActor: { v: 1, accountId: 'account', profile: null }, producerV1: null, createdAt: 1 },
        messageSeq: 1, lastReadSeq: 1, unreadCount: 0, unreadMentionCount: 0,
        recentAuthorAccountIds: [], archivedAt: null,
        capabilities: { postMessages: true, rename: true, archive: true, restore: false, askAgent: true,
          sendToSession: true, manageAccess: true, leave: false },
      }, firstMessage: { id: 'first', localId: 'first', seq: 1, authorAccountId: 'account',
        accountActor: { v: 1, accountId: 'account', profile: null }, producerV1: null, createdAt: 1,
        discussionId: 'discussion', content: { v: 1, parts: [{ t: 'text', text: 'Review' }] }, mentionedAccountIds: [],
        messageRef: { kind: 'discussion', discussion: { serverId: 'home', discussionId: 'discussion' }, messageId: 'first' },
      } }),
    });
    try {
      const prepared = await executor.prepare('discussion.create', {
        title: 'Review', creationLocalId: 'review', firstMessage: { localId: 'first', content: {
          v: 1, parts: [{ t: 'text', text: 'Review' }],
        } }, participants: [{ kind: 'session', sessionId: 'allowed' }],
      }, { surface: 'ui', authority: 'present_user', serverId: 'home', bypassApprovals: true,
        externalActionCredential: { accountId: 'account', principalId: 'token', credentialId: 'token', grant: {
          v: 1, actions: { families: [], ids: ['discussion.create'] }, targets: { sessions: [], machines: ['machine'] },
          approve: false, origins: [], models: null, permissionModes: null, create: null,
        } },
      });
      expect(prepared.kind, JSON.stringify(prepared)).toBe('ready');
      if (prepared.kind !== 'ready') throw new Error('Expected admitted discussion');
      expect(machineReads).toHaveBeenCalledOnce();
      // The next request sees an unavailable lookup; this admitted invocation finishes.
      machineReads.mockRejectedValue(new Error('Machine lookup unavailable after admission'));
      const admissionEvaluations = targets.mock.calls.length;
      machineReads.mockClear();
      await expect(prepared.invocation.run()).resolves.toMatchObject({ ok: true });
      expect(targets).toHaveBeenCalledTimes(admissionEvaluations);
      expect(machineReads).not.toHaveBeenCalled();
    } finally { targets.mockRestore(); }
  });
  it.each(['cli', 'agent', 'mcp'] as const)('evaluates authority and credential scope once for a hook-wired %s Action request', async surface => {
    // Call-through instrumentation measures real admission, not a replacement policy.
    const admissions = vi.spyOn(authority, 'resolveCredentialActionAdmissionV1');
    const grants = vi.spyOn(credentials, 'evaluateApiTokenGrantV1');
    const normalizations = vi.spyOn(callerContext, 'normalizeActionCallerContext');
    const attestations = vi.spyOn(callerContext, 'sessionAttestedContextCallerFailure');
    const executor = createExecutor({
      interceptActionExecution: async ({ input }) => ({ status: 'continue', input }),
      observeActionExecution: async () => undefined,
      sessionStateFieldSet: async () => ({ updated: true }),
    });
    try {
      expect(await executor.execute('session.title.set', { sessionId: 'allowed', title: 'Title' }, {
        surface, authority: 'account_automation', defaultSessionId: 'allowed', bypassApprovals: true,
        externalActionCredential: { accountId: 'account', principalId: 'token', credentialId: 'token', grant: {
          v: 1, actions: { families: [], ids: ['session.title.set'] }, targets: { sessions: ['allowed'], machines: [] },
          approve: false, origins: [], models: null, permissionModes: null, create: null,
        } },
      })).toMatchObject({ ok: true });
      expect(admissions).toHaveBeenCalledTimes(1);
      expect(grants).toHaveBeenCalledTimes(1);
      expect(normalizations).toHaveBeenCalledTimes(1);
      expect(attestations).toHaveBeenCalledTimes(1);
    } finally { admissions.mockRestore(); grants.mockRestore(); normalizations.mockRestore(); attestations.mockRestore(); }
  });
  it.each([
    { actionId: 'session.title.set', input: { sessionId: 'session-1', title: 'Title' } },
    { actionId: 'session.manager.set', input: { sessionId: 'session-1', managerSessionId: null, expectedManagerSessionId: null } },
  ] as const)('passes admitted $actionId input into its domain without another parse', async ({ actionId, input }) => {
    const schema = getActionSpec(actionId).inputSchema;
    const safeParses = vi.spyOn(schema, 'safeParse');
    const parses = vi.spyOn(schema, 'parse');
    const executor = createExecutor({
      sessionStateFieldSet: async () => ({ updated: true }),
      sessionManagerSet: async () => ({ ok: true, sessionId: 'session-1', managerSessionId: null, attachedAt: null }),
    });
    try {
      const prepared = await executor.prepare(actionId, input, { surface: 'cli', bypassApprovals: true });
      expect(prepared.kind, JSON.stringify(prepared)).toBe('ready');
      if (prepared.kind !== 'ready') throw new Error('Expected admitted Session action');
      safeParses.mockClear();
      parses.mockClear();
      await expect(prepared.invocation.run()).resolves.toMatchObject({ ok: true });
      expect(safeParses).not.toHaveBeenCalled();
      expect(parses).not.toHaveBeenCalled();
    } finally {
      safeParses.mockRestore();
      parses.mockRestore();
    }
  });

  it.each(['direct', 'observed', 'unchanged hook'] as const)('admits an unchanged %s input once and adds no parses on run', async mode => {
    const schema = getActionSpec('session.list').inputSchema;
    // Instrument the real parser without replacing its validation behavior.
    const parses = vi.spyOn(schema, 'safeParse');
    const sessionList = vi.fn(async () => ({ sessions: [] }));
    const executor = createExecutor({ sessionList,
      ...(mode === 'observed' ? { observeActionExecution: async () => undefined } : {}),
      ...(mode === 'unchanged hook' ? { interceptActionExecution: async ({ input }) => ({ status: 'continue' as const, input }) } : {}),
    });
    try {
      const prepared = await executor.prepare('session.list', {}, { surface: 'cli' });
      expect(prepared.kind).toBe('ready');
      // A hook can mutate its operand in place, so its return remains an ingress.
      expect(parses).toHaveBeenCalledTimes(mode === 'unchanged hook' ? 2 : 1);
      if (prepared.kind !== 'ready') throw new Error('Expected admitted list');
      parses.mockClear();
      await expect(prepared.invocation.run()).resolves.toMatchObject({ ok: true, result: { sessions: [] } });
      expect(parses).not.toHaveBeenCalled();
      expect(sessionList).toHaveBeenCalledOnce();
    } finally {
      parses.mockRestore();
    }
  });

  it.each(['replacement', 'in place'] as const)('refuses a transformed target beyond the admitted credential grant (%s)', async transform => {
    const sessionStateFieldSet = vi.fn(async () => ({ updated: true }));
    const executor = createExecutor({ sessionStateFieldSet,
      interceptActionExecution: async ({ input }) => {
        if (transform === 'in place') {
          if (!input || typeof input !== 'object' || !('sessionId' in input)) throw new Error('Expected Session operand');
          input.sessionId = 'outside';
          return { status: 'continue', input };
        }
        return { status: 'continue', input: { ...input as object, sessionId: 'outside' } };
      },
    });
    const result = await executor.execute('session.title.set', { sessionId: 'allowed', title: 'Title' }, {
      surface: 'cli', authority: 'account_automation', defaultSessionId: 'allowed',
      externalActionCredential: { accountId: 'account', principalId: 'token', credentialId: 'token', grant: {
        v: 1, actions: { families: [], ids: ['session.title.set'] }, targets: { sessions: ['allowed'], machines: [] },
        approve: false, origins: [], models: null, permissionModes: null, create: null,
      } },
    });
    expect(result).toMatchObject({ ok: false, errorCode: 'credential_scope_denied' });
    expect(sessionStateFieldSet).not.toHaveBeenCalled();
  });

  it.each([false, true])('diagnoses invalid generic Action inputs before interception (observed=%s)', async observed => {
    const interceptActionExecution = vi.fn(async () => ({ status: 'continue' as const, input: {} }));
    const executor = createExecutor(observed ? { interceptActionExecution } : {});
    expect(await executor.execute('session.title.set', { sessionId: 'session-1', title: 42 }, { surface: 'cli' }))
      .toMatchObject({ ok: false, errorCode: 'invalid_parameters', details: { issues: [{
        code: 'invalid_type', path: ['title'], expected: 'string',
      }] } });
    expect(interceptActionExecution).not.toHaveBeenCalled();
  });

  const runStartInput = {
    sessionId: 'session-1',
    intent: 'delegate',
    backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
    instructions: 'do it',
    permissionMode: 'read_only',
    retentionPolicy: 'ephemeral',
    runClass: 'bounded',
    ioMode: 'request_response',
  } as const;

  it('revalidates transformed input and executes once before observational after', async () => {
    const sequence: string[] = [];
    const sessionStateFieldSet = vi.fn(async (_args: unknown) => {
      sequence.push('execute');
      return { updated: true };
    });
    const interceptActionExecution = vi.fn(async (request: { input: unknown }) => {
      sequence.push('before');
      return {
        status: 'continue' as const,
        input: { ...(request.input as object), title: 'transformed' },
      };
    });
    const observeActionExecution = vi.fn(async () => {
      sequence.push('after');
      throw new Error('observer failure must not replace the action result');
    });
    const executor = createExecutor({
      sessionStateFieldSet,
      interceptActionExecution,
      observeActionExecution,
    });

    const result = await executor.execute(
      'session.title.set',
      { sessionId: 'session-1', title: 'original' },
      {
        surface: 'cli',
        actionCaller: { kind: 'plugin', pluginId: 'caller.plugin' },
      },
    );

    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(sequence).toEqual(['before', 'execute', 'after']);
    expect(sessionStateFieldSet).toHaveBeenCalledOnce();
    expect(sessionStateFieldSet).toHaveBeenCalledWith({
      context: expect.objectContaining({ surface: 'cli', actionCaller: { kind: 'plugin', pluginId: 'caller.plugin' } }),
      actionId: 'session.title.set', fieldId: 'display.title',
      sessionId: 'session-1', value: 'transformed',
    });
    expect(interceptActionExecution).toHaveBeenCalledWith(expect.objectContaining({
      actionId: 'session.title.set',
      input: { sessionId: 'session-1', title: 'original' },
      caller: { kind: 'plugin', pluginId: 'caller.plugin' },
    }));
    expect(observeActionExecution).toHaveBeenCalledWith(expect.objectContaining({
      actionId: 'session.title.set',
      input: { sessionId: 'session-1', title: 'transformed' },
      caller: { kind: 'plugin', pluginId: 'caller.plugin' },
      result: expect.objectContaining({ ok: true }),
    }));
  });

  it('distinguishes explicit rejection from a hook failure and never executes', async () => {
    const sessionStateFieldSet = vi.fn(async () => ({}));
    const observeActionExecution = vi.fn(async () => undefined);
    const executor = createExecutor({
      sessionStateFieldSet,
      observeActionExecution,
      interceptActionExecution: async () => ({
        status: 'rejected',
        code: 'policy_denied',
        message: 'Denied by policy',
      }),
    });

    const result = await executor.execute(
      'session.title.set',
      { sessionId: 'session-1', title: 'original' },
      { surface: 'cli', actionCaller: { kind: 'host' } },
    );

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'action_interception_rejected',
      details: { code: 'policy_denied' },
    });
    expect(sessionStateFieldSet).not.toHaveBeenCalled();
    expect(observeActionExecution).not.toHaveBeenCalled();
  });

  it('rejects malformed transformed input before rights, approval, or action effects', async () => {
    const sessionStateFieldSet = vi.fn(async () => ({}));
    const readActionsSettings = vi.fn(() => ActionsSettingsV1Schema.parse({ v: 1 }));
    const executor = createExecutor({
      sessionStateFieldSet,
      readActionsSettings,
      interceptActionExecution: async () => ({
        status: 'continue',
        input: { sessionId: 'session-1', title: 42 },
      }),
    });

    const result = await executor.execute(
      'session.title.set',
      { sessionId: 'session-1', title: 'original' },
      { surface: 'cli', actionCaller: { kind: 'host' } },
    );

    expect(result).toMatchObject({ ok: false, errorCode: 'invalid_parameters', details: { issues: [{
      code: 'invalid_type', path: ['title'], expected: 'string',
    }] } });
    expect(readActionsSettings).not.toHaveBeenCalled();
    expect(sessionStateFieldSet).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'invalid initial input',
      input: {},
      interceptActionExecution: vi.fn(async () => ({ status: 'continue' as const, input: runStartInput })),
      expectedErrorCode: 'invalid_parameters',
    },
    {
      name: 'throwing hook',
      input: runStartInput,
      interceptActionExecution: vi.fn(async () => {
        throw new Error('hook failed');
      }),
      expectedErrorCode: 'action_interception_failed',
    },
    {
      name: 'rejected hook',
      input: runStartInput,
      interceptActionExecution: vi.fn(async () => ({ status: 'rejected' as const, code: 'policy_denied' })),
      expectedErrorCode: 'action_interception_rejected',
    },
    {
      name: 'failed hook',
      input: runStartInput,
      interceptActionExecution: vi.fn(async () => ({ status: 'failed' as const, code: 'plugin_hook_handler_failed' })),
      expectedErrorCode: 'action_interception_failed',
    },
    {
      name: 'invalid transformed input',
      input: runStartInput,
      interceptActionExecution: vi.fn(async () => ({ status: 'continue' as const, input: {} })),
      expectedErrorCode: 'invalid_parameters',
    },
  ])('classifies $name as owner-proven pre-dispatch failure for execution.run.start', async ({
    input,
    interceptActionExecution,
    expectedErrorCode,
  }) => {
    const executionRunStart = vi.fn(async () => ({
      runId: 'run_1',
      callId: 'call_1',
      sidechainId: 'call_1',
    }));
    const executor = createExecutor({ executionRunStart, interceptActionExecution });

    const result = await executor.execute(
      'execution.run.start' as any,
      input,
      { surface: 'cli', actionCaller: { kind: 'host' } },
    );

    expect(result).toMatchObject({
      ok: false,
      errorCode: expectedErrorCode,
    });
    expect(result).toHaveProperty('details', {
      executionRunStart: { v: 1, runCreation: 'noRunCreated' },
      ...(expectedErrorCode === 'invalid_parameters' ? { issues: expect.arrayContaining([
        expect.objectContaining({ code: 'invalid_value', path: ['retentionPolicy'],
          acceptedValues: ['ephemeral', 'resumable'] }),
      ]) } : {}),
    });
    expect(executionRunStart).not.toHaveBeenCalled();
  });

  it('classifies an invalid Plugin caller before interception as noRunCreated for execution.run.start', async () => {
    const executionRunStart = vi.fn(async () => ({
      runId: 'run_1',
      callId: 'call_1',
      sidechainId: 'call_1',
    }));
    const interceptActionExecution = vi.fn(async () => ({ status: 'continue' as const, input: runStartInput }));
    const executor = createExecutor({ executionRunStart, interceptActionExecution });

    await expect(executor.execute(
      'execution.run.start' as any,
      runStartInput,
      { surface: 'plugin', actionCaller: { kind: 'host' } },
    )).resolves.toEqual({
      ok: false,
      errorCode: 'plugin_action_caller_required',
      error: 'plugin_action_caller_required',
      details: { executionRunStart: { v: 1, runCreation: 'noRunCreated' } },
    });
    expect(interceptActionExecution).not.toHaveBeenCalled();
    expect(executionRunStart).not.toHaveBeenCalled();
  });

  it('disables interception for one explicitly nested execution', async () => {
    const interceptActionExecution = vi.fn(async () => ({ status: 'rejected' as const }));
    const observeActionExecution = vi.fn(async () => undefined);
    const sessionStateFieldSet = vi.fn(async () => ({ updated: true }));
    const executor = createExecutor({ interceptActionExecution, observeActionExecution, sessionStateFieldSet });

    const result = await executor.execute(
      'session.title.set',
      { sessionId: 'session-1', title: 'nested' },
      {
        surface: 'cli',
        actionCaller: { kind: 'plugin', pluginId: 'hook.plugin' },
        bypassActionInterception: true,
      },
    );

    expect(result.ok).toBe(true);
    expect(sessionStateFieldSet).toHaveBeenCalledOnce();
    expect(interceptActionExecution).not.toHaveBeenCalled();
    expect(observeActionExecution).not.toHaveBeenCalled();
  });

  it('publishes the target after event only when a deferred approved action actually executes', async () => {
    let storedRequest: Parameters<NonNullable<ActionExecutorDeps['approvalsCreate']>>[0]['request'] | null = null;
    const sessionStateFieldSet = vi.fn(async () => ({ updated: true }));
    const interceptActionExecution = vi.fn(async (request: { input: unknown }) => ({
      status: 'continue' as const,
      input: request.input,
    }));
    const observer = Promise.withResolvers<void>();
    const observeActionExecution = vi.fn<NonNullable<ActionExecutorDeps['observeActionExecution']>>(
      ({ actionId }) => actionId === 'session.title.set' ? observer.promise : undefined,
    );
    const executor = createExecutor({
      sessionStateFieldSet,
      interceptActionExecution,
      observeActionExecution,
      readActionsSettings: context => ActionsSettingsV1Schema.parse({ v: 1, actions: { ['session.title.set']: { approvalRequiredSurfaces: [context.surface ?? 'ui'] } } }),
      approvalsCreate: async ({ request }) => {
        storedRequest = request;
        return { artifactId: 'approval-1' };
      },
      approvalsGet: async () => storedRequest,
      approvalsUpdate: async ({ request }) => {
        storedRequest = request;
        return { ok: true };
      },
      isApprovalExecutionOriginCurrent: async () => true,
    });

    const deferred = await executor.execute(
      'session.title.set',
      { sessionId: 'session-1', title: 'deferred' },
      {
        surface: 'plugin',
        serverId: 'server-1',
        defaultSessionMachineId: 'machine-1',
        actionRequestId: 'deferred-title-1',
        actionCaller: {
          kind: 'plugin',
          pluginId: 'caller.plugin',
          contributionLocalId: 'title-hook',
          sourceCustody: { kind: 'development', registeredRootId: 'root-1' },
        },
      },
    );
    expect(deferred).toMatchObject({
      ok: true,
      result: { kind: 'approval_request_created', artifactId: 'approval-1' },
    });
    expect(observeActionExecution.mock.calls.filter(([event]) => event.actionId === 'session.title.set')).toHaveLength(0);

    const deciding = executor.execute(
      'approval.request.decide',
      { artifactId: 'approval-1', decision: 'approve' },
      { surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' } },
    );
    let decision: Awaited<typeof deciding> | undefined;
    void deciding.then(result => { decision = result; });
    try {
      await vi.waitFor(() => expect(decision).toMatchObject({
        ok: true, result: { status: 'executed', execution: { ok: true } },
      }));
      expect(storedRequest).toMatchObject({ status: 'executed' });
    } finally {
      observer.resolve();
      await deciding;
    }

    expect(sessionStateFieldSet).toHaveBeenCalledOnce();
    expect(observeActionExecution.mock.calls.filter(([event]) => event.actionId === 'session.title.set'))
      .toEqual([[expect.objectContaining({
        input: { sessionId: 'session-1', title: 'deferred' },
        caller: { kind: 'host' },
        context: expect.objectContaining({ approvedActionReplay: expect.objectContaining({
          origin: expect.objectContaining({ caller: {
            kind: 'plugin',
            pluginId: 'caller.plugin',
            contributionLocalId: 'title-hook',
            sourceCustody: { kind: 'development', registeredRootId: 'root-1' },
            startedBy: 'trigger',
          } }),
        }) }),
        result: expect.objectContaining({ ok: true }),
      })]]);
  });
});
