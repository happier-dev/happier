import { describe, expect, it, vi } from 'vitest';
import tweetnacl from 'tweetnacl';

import {
  ApprovalRequestV1Schema,
  ApprovalRequestV2Schema,
  ApprovalExecutionOriginV1Schema,
  type ApprovalRequest,
  type ApprovalRequestV1,
} from '../approvals/approvalRequestV1.js';
import { createActionExecutor } from './actionExecutor.js';
import { createWorkflowAccountRunActionOwner, type WorkflowAccountRunActionDeps } from './executor/workflowRunActions.js';
import { WorkflowRunSummaryV1Schema } from '../workflows/workflowProgressV1.js';
import { openWorkflowAcceptedSnapshotStoredEnvelopeV1, parseWorkflowStoredContentEnvelopeV1 } from '../workflows/workflowStoredContentV1.js';
import type { ActionExecutorContext, ActionExecutorDeps } from './executor/types.js';
import type { ExternalActionTargetV1 } from './externalActionApi.js';
import { ApiTokenGrantV1Schema } from '../auth/apiTokenGrant.js';
import { SessionAgentSpawnPolicyV1Schema } from '../account/settings/accountSettings.js';
import type { AgentStartContextV1 } from '../account/settings/admitAgentStartV1.js';
import {
  signExternalActionApprovalInputV1,
  verifyExternalActionApprovalInputV1,
} from './externalActionExecutionAuthorization.js';

const sessionSpawnInput = {
  creationKey: 'plugin-approval-1',
  executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
  directory: { kind: 'path', path: '/workspace/project' },
  organizationPlacement: { folderId: null, tagIds: [] },
  agentTarget: {
    kind: 'agent',
    identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
  },
  initialInput: { text: 'Inspect this repository.' },
} as const;

describe('createActionExecutor (durable plugin approval caller provenance)', () => {
  it('persists the complete authenticated Session caller for an approved Account mutation', async () => {
    let stored: ApprovalRequest | null = null;
    const caller = { kind: 'session', sessionId: 'parent-1', starterDepth: 2, turnDepth: 3 } as const;
    const deps = {
      approvalsCreate: async ({ request }) => { stored = ApprovalRequestV2Schema.parse(JSON.parse(JSON.stringify(request))); return { artifactId: 'session-mutation' }; },
      isActionApprovalRequired: () => true,
    } satisfies Pick<ActionExecutorDeps, 'approvalsCreate' | 'isActionApprovalRequired'>;
    const executor = createActionExecutor(deps as unknown as ActionExecutorDeps);
    expect(await executor.execute('teams.update', { v: 1, teamId: 'team-1', name: 'Session proposal' }, {
      surface: 'agent', authority: 'account_automation', serverId: 'server-1', runtimeAccountId: 'account-1',
      actionRequestId: 'session-mutation', actionCaller: caller, defaultSessionId: caller.sessionId,
      callerPermissionMode: 'default',
    })).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
    expect(stored).toMatchObject({ executionOriginV1: { caller } });
  });

  it.each([false, true])('replays original Session depths while rechecking current depth policy (tightened=%s)', async (tightened) => {
    let stored: ApprovalRequest | null = null;
    const caller = { kind: 'session', sessionId: 'parent-1', starterDepth: 2, turnDepth: 3 } as const;
    let current: AgentStartContextV1 = { caller, baseline: { machineId: 'machine-1', directory: '/workspace/project' },
      ledSubtreeSessionIds: [], workDepthLimit: 4, roles: {}, callerPermissionCeiling: 'default' };
    const createdSessions: Parameters<ActionExecutorDeps['sessionSpawnNew']>[0][] = [];
    const deps = {
      approvalsCreate: async ({ request }) => { stored = ApprovalRequestV2Schema.parse(JSON.parse(JSON.stringify(request))); return { artifactId: 'session-start' }; },
      approvalsGet: async () => stored,
      approvalsUpdate: async ({ request }) => { stored = ApprovalRequestV2Schema.parse(JSON.parse(JSON.stringify(request))); return { ok: true }; },
      isApprovalExecutionOriginCurrent: async () => true,
      isActionApprovalRequired: actionId => actionId === 'session.spawn_new',
      resolveAgentStartContext: async () => current,
      sessionSpawnNew: async (args) => { createdSessions.push(args); return { type: 'success', disposition: 'created', sessionId: 'child-1',
        executionTarget: sessionSpawnInput.executionTarget, organizationPlacement: sessionSpawnInput.organizationPlacement,
        initialInput: { status: 'accepted', localId: 'initial-1' } }; },
    } satisfies Pick<ActionExecutorDeps, 'approvalsCreate' | 'approvalsGet' | 'approvalsUpdate'
      | 'isApprovalExecutionOriginCurrent' | 'isActionApprovalRequired' | 'resolveAgentStartContext' | 'sessionSpawnNew'>;
    const executor = createActionExecutor(deps as unknown as ActionExecutorDeps);
    expect(await executor.execute('session.spawn_new', sessionSpawnInput, {
      surface: 'agent', authority: 'account_automation', serverId: 'server-1', runtimeAccountId: 'account-1',
      defaultSessionId: caller.sessionId, actionRequestId: 'session-start', actionCaller: caller, callerPermissionMode: 'default',
    })).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
    expect(stored).toMatchObject({ executionOriginV1: { caller } });
    expect(createdSessions).toEqual([]);
    current = { ...current, caller: { ...caller, starterDepth: 0, turnDepth: 0 }, workDepthLimit: tightened ? 3 : 4 };
    expect(await executor.execute('approval.request.decide', { artifactId: 'session-start', decision: 'approve' }, {
      surface: 'ui', authority: 'present_user', serverId: 'server-1', runtimeAccountId: 'account-1',
      agentStartContext: { ...current, caller: { ...caller, sessionId: 'approver-session' } }, callerPermissionMode: 'yolo',
    })).toMatchObject({ ok: true, result: tightened
      ? { status: 'failed', execution: { ok: false, errorCode: 'work_depth_exceeded' } }
      : { status: 'executed', execution: { ok: true } } });
    expect(createdSessions).toMatchObject(tightened ? [] : [{ actionCaller: caller, workDepth: 4, originSessionId: caller.sessionId }]);
  });

  it.each([
    { kind: 'session', sessionId: 'parent-1' },
    { kind: 'session', sessionId: 'parent-1', starterDepth: 0, turnDepth: -1 },
    { kind: 'session', sessionId: 'parent-1', starterDepth: 0, turnDepth: 0, workDepth: 0 },
  ])('refuses malformed Session provenance before durable capture: %j', async (caller) => {
    const requests: ApprovalRequest[] = [];
    const deps = { approvalsCreate: async ({ request }) => { requests.push(request); return { artifactId: 'invalid' }; },
      isActionApprovalRequired: () => true } satisfies Pick<ActionExecutorDeps, 'approvalsCreate' | 'isActionApprovalRequired'>;
    const executor = createActionExecutor(deps as unknown as ActionExecutorDeps);
    expect(await executor.execute('teams.update', { v: 1, teamId: 'team-1', name: 'Forged' }, {
      surface: 'agent', authority: 'account_automation', serverId: 'server-1', runtimeAccountId: 'account-1',
      actionRequestId: 'invalid', actionCaller: caller as unknown as NonNullable<ActionExecutorContext['actionCaller']>, callerPermissionMode: 'default',
    })).toMatchObject({ ok: false, errorCode: 'approval_origin_unavailable' });
    expect(requests).toEqual([]);
  });

  it.each([
    { initiatingCaller: { kind: 'host' }, startedBy: 'user' },
    { initiatingCaller: { kind: 'session', sessionId: 'agent-origin', starterDepth: 1, turnDepth: 2 }, startedBy: 'agent' },
  ] as const)('freezes $startedBy starter through durable plugin Workflow approval and replay', async ({ initiatingCaller, startedBy }) => {
    const runId = '99999999-9999-4999-8999-999999999999';
    let acceptedEnvelope: string | undefined;
    let storedRequest: ApprovalRequest | null = null;
    const run = WorkflowRunSummaryV1Schema.parse({ id: runId, sourceArtifactId: null,
      ownerAccountId: 'account-1', visibleTeamId: null, origin: { kind: 'direct' }, state: 'queued', revision: 0,
      machineId: 'machine-1', workflowCustodyState: 'pending', originDeliveryAckRevision: null,
      availability: { pause: true, resumeBoundary: false, restoreWorkspace: false, cancel: true, inspectExecution: false, disabledReasons: [] },
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' });
    const workflowDeps: WorkflowAccountRunActionDeps = {
      resolveAccountId: async () => 'account-1',
      storage: { execute: async operation => {
        if (operation.operation === 'get') throw Object.assign(new Error('run_not_found'), { code: 'run_not_found' });
        if (operation.operation !== 'admit') throw new Error('unexpected_storage_operation');
        acceptedEnvelope = String(operation.acceptedEnvelope);
        return { kind: 'created', run };
      } },
      definitions: { get: async () => { throw new Error('inline_definition_only'); } },
      resolveEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
      normalizeAbsolutePath: directory => directory.startsWith('/') ? directory : null,
      randomBytes: () => { throw new Error('plain_account_does_not_need_keys'); },
      prepareWorkspace: async () => ({ ok: true, workspaceTarget: { project: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' } } }),
      resolveMaterializationContext: async () => ({ effects: { resolveTargetAvailability: async () => true } }),
    };
    const owner = createWorkflowAccountRunActionOwner(workflowDeps);
    const approvalDeps = {
      approvalsCreate: async ({ request }) => {
        storedRequest = ApprovalRequestV2Schema.parse(JSON.parse(JSON.stringify(request)));
        return { artifactId: 'workflow-starter-approval' };
      },
      approvalsGet: async () => storedRequest,
      approvalsUpdate: async ({ request }) => {
        storedRequest = ApprovalRequestV2Schema.parse(JSON.parse(JSON.stringify(request)));
        return { ok: true };
      },
      isApprovalExecutionOriginCurrent: async () => true,
      isActionApprovalRequired: actionId => actionId === 'workflow.run.start',
      workflowAction: args => {
        if (args.actionId !== 'workflow.run.start') throw new Error('unexpected_workflow_action');
        return owner.execute(args);
      },
    } satisfies Pick<ActionExecutorDeps, 'approvalsCreate' | 'approvalsGet' | 'approvalsUpdate'
      | 'isApprovalExecutionOriginCurrent' | 'isActionApprovalRequired' | 'workflowAction'>;
    // Only Artifact persistence/currentness and the Account storage are process boundaries; real capture, parsing, replay and admission run.
    const executor = createActionExecutor(approvalDeps as unknown as ActionExecutorDeps);
    const created = await executor.execute('workflow.run.start', { runId, source: { kind: 'inline', definition: {
      version: 1, blocks: [{ kind: 'wait', id: 'wait', document: { text: 'Review', references: [], attachments: [] } }],
    } } }, {
      surface: 'cli', serverId: 'home-1', runtimeAccountId: 'account-1', callerPermissionMode: 'default',
      actionRequestId: 'workflow-starter-request',
      externalActionTarget: { kind: 'machine', machineId: 'machine-1', project: { machineId: 'machine-1', directory: '/repo' } },
      actionCaller: { kind: 'plugin', pluginId: 'acme.background', contributionLocalId: 'job',
        sourceCustody: { kind: 'development', registeredRootId: 'background-root' }, initiatingCaller },
    });
    expect(created, JSON.stringify(created)).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
    expect(acceptedEnvelope).toBeUndefined();
    const approved = await executor.execute('approval.request.decide', { artifactId: 'workflow-starter-approval', decision: 'approve' }, {
      surface: 'ui', authority: 'present_user', serverId: 'home-1', runtimeAccountId: 'account-1',
    });
    expect(approved, JSON.stringify(approved)).toMatchObject({ ok: true, result: { status: 'executed', execution: { ok: true } } });
    expect(openWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain',
      binding: { v: 1, purpose: 'accepted_snapshot', accountId: 'account-1', runId },
      envelope: parseWorkflowStoredContentEnvelopeV1(acceptedEnvelope),
    })).toMatchObject({ kind: 'available', content: { startedBy,
      authorization: { principal: { kind: 'plugin', pluginId: 'acme.background', contributionLocalId: 'job',
        sourceCustody: { kind: 'development', registeredRootId: 'background-root' } } } } });
  });

  it('defers teams.update and replays its exact mutation once after approval', async () => {
    let storedRequest: ApprovalRequest | null = null;
    const updatedTeam = {
      id: 'team-1',
      name: 'Approval rename',
      description: null,
      logo: null,
      archivedAt: null,
      recovery: null,
      policy: {
        v: 1,
        sessionCreationPolicy: 'team_default',
        externalSharingPolicy: 'allowed',
        defaultSessionHistoryAccess: 'from_membership',
        admissionMode: 'invite_only',
        authenticationPolicy: null,
      },
      viewerRole: 'owner',
      capabilities: {
        viewTeam: true,
        manageSettings: true,
        managePolicy: false,
        manageMembers: false,
        manageGroups: false,
        manageInvitations: false,
        manageOwners: false,
        manageAuthentication: false,
        archiveTeam: false,
        restoreTeam: false,
      },
      admission: {
        historyChoice: { admin: 'choice', member: 'choice', guest: 'hidden' },
      },
    } as const;
    const homeDomainAction = vi.fn(async () => updatedTeam);
    const executor = createActionExecutor({
      approvalsCreate: async ({ request }: { request: ApprovalRequest }) => {
        storedRequest = ApprovalRequestV2Schema.parse(JSON.parse(JSON.stringify(request)));
        return { artifactId: 'team-update-approval' };
      },
      approvalsGet: async () => storedRequest,
      approvalsUpdate: async ({ request }: { request: ApprovalRequest }) => {
        storedRequest = ApprovalRequestV2Schema.parse(JSON.parse(JSON.stringify(request)));
        return { ok: true as const };
      },
      isApprovalExecutionOriginCurrent: async () => true,
      isActionApprovalRequired: (actionId: string) => actionId === 'teams.update',
      homeDomainAction,
    } as unknown as ActionExecutorDeps);
    const input = { v: 1 as const, teamId: 'team-1', name: 'Approval rename' };

    const created = await executor.execute('teams.update', input, {
      surface: 'ui',
      authority: 'present_user',
      serverId: 'home-1',
      runtimeAccountId: 'account-1',
      actionRequestId: 'team-update-request-1',
    });
    expect(created).toMatchObject({
      ok: true,
      result: {
        kind: 'approval_request_created',
        artifactId: 'team-update-approval',
        actionId: 'teams.update',
      },
    });
    expect(homeDomainAction).not.toHaveBeenCalled();

    const approved = await executor.execute('approval.request.decide', {
      artifactId: 'team-update-approval',
      decision: 'approve',
    }, {
      surface: 'ui', authority: 'present_user', serverId: 'home-1', runtimeAccountId: 'account-1',
    });
    expect(approved).toMatchObject({
      ok: true,
      result: { status: 'executed', execution: { ok: true, result: updatedTeam } },
    });
    expect(homeDomainAction).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      actionId: 'teams.update',
      input,
      context: expect.objectContaining({
        surface: 'ui', authority: 'present_user', serverId: 'home-1', runtimeAccountId: 'account-1',
      }),
    }));
  });

  it('rejects broadened or unbound Session list scope in persisted approval origin', () => {
    const origin = {
      v: 1, authority: 'account_automation', surface: 'mcp', caller: { kind: 'host' },
      serverId: 'home-1', sessionId: 'session-1', actionId: 'session.list', requestId: 'request-1',
    };
    expect(ApprovalExecutionOriginV1Schema.safeParse({ ...origin, sessionListAccess: 'account' }).success).toBe(false);
    expect(ApprovalExecutionOriginV1Schema.safeParse({ ...origin, sessionId: undefined, sessionListAccess: 'current_session' }).success).toBe(false);
    expect(ApprovalExecutionOriginV1Schema.safeParse(origin).success).toBe(false);
    expect(ApprovalExecutionOriginV1Schema.safeParse({
      ...origin,
      surface: 'ui',
    }).success).toBe(true);
  });

  it('rejects contradictory repeated V2 surface and plugin-caller facts', () => {
    const request = {
      v: 2 as const,
      status: 'open' as const,
      createdAtMs: 1,
      updatedAtMs: 1,
      createdBy: {
        surface: 'system' as const,
        pluginId: 'example.plugin',
        contributionLocalId: 'review',
      },
      requestedSurface: 'plugin',
      executionOriginV1: {
        v: 1 as const,
        authority: 'account_automation' as const,
        surface: 'plugin' as const,
        caller: {
          kind: 'plugin' as const,
          pluginId: 'example.plugin',
          contributionLocalId: 'review',
          sourceCustody: { kind: 'development', registeredRootId: 'root-1' },
        },
        serverId: 'home-1',
        actionId: 'review.start' as const,
        requestId: 'request-1',
      },
      actionId: 'review.start' as const,
      actionArgs: { sessionId: 'session-target' },
      summary: 'Start review',
    };
    expect(ApprovalRequestV2Schema.safeParse(request).success).toBe(true);
    expect(ApprovalRequestV2Schema.safeParse({ ...request, requestedSurface: 'mcp' }).success).toBe(false);
    expect(ApprovalRequestV2Schema.safeParse({
      ...request,
      createdBy: { ...request.createdBy, pluginId: 'other.plugin' },
    }).success).toBe(false);
    expect(ApprovalRequestV2Schema.safeParse({
      ...request,
      createdBy: { surface: 'system' },
    }).success).toBe(true);
  });

  it.each(['mcp', 'agent'] as const)('retains the admitted Session list scope through %s approval replay', async (surface) => {
    let storedRequest: ApprovalRequest | null = null;
    const sessionList = vi.fn(async () => ({ sessions: [], nextCursor: null, hasNext: false }));
    const executor = createActionExecutor({
      approvalsCreate: async ({ request }) => {
        storedRequest = ApprovalRequestV2Schema.parse(JSON.parse(JSON.stringify(request)));
        return { artifactId: 'list-approval' };
      },
      approvalsGet: async () => storedRequest,
      approvalsWaitForDecision: async ({ request }) => ({
        decision: 'approve' as const,
        request: { ...request, status: 'approved' as const, decision: { kind: 'approve' as const, decidedAtMs: 2 } },
      }),
      approvalsUpdate: async ({ request }) => {
        storedRequest = request;
        return { ok: true as const };
      },
      isApprovalExecutionOriginCurrent: async () => true,
      isActionApprovalRequired: () => true,
      sessionList,
    } as unknown as ActionExecutorDeps);
    const admitted = await executor.execute('session.list', {}, {
      surface, authority: 'account_automation', serverId: 'home-original',
      serverIdentityId: 'stable-home-identity',
      defaultSessionId: 'session-original', sessionListAccess: 'current_session',
      actionRequestId: 'list-request',
    });
    expect(admitted).toEqual({ ok: true, result: { sessions: [], nextCursor: null, hasNext: false } });
    expect(storedRequest).toMatchObject({ executionOriginV1: {
      serverId: 'home-original', serverIdentityId: 'stable-home-identity',
      sessionId: 'session-original', sessionListAccess: 'current_session',
    } });
    const result = await executor.execute('approval.request.decide', {
      artifactId: 'list-approval', decision: 'approve',
    }, { surface: 'ui', authority: 'present_user', serverId: 'home-original', defaultSessionId: 'different-session' });
    expect(result).toMatchObject({ ok: true, result: { status: 'executed' } });
    expect(sessionList).toHaveBeenCalledWith(expect.objectContaining({ context: expect.objectContaining({
      defaultSessionId: 'session-original', sessionListAccess: 'current_session',
      serverIdentityId: 'stable-home-identity', surface,
    }) }));
  });

  it.each([
    'original',
    'resolved Session target',
    'explicit approval',
    'changed stored input',
    'changed resolved target',
    'different machine key',
    'wrong observed Home identity',
  ] as const)(
    'binds deferred PAT replay to the original exact target and stored input: %s', async (scenario) => {
    const machineKey = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(8));
    const currentMachineKey = scenario === 'different machine key'
      ? tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(9))
      : machineKey;
    const admittedTarget: ExternalActionTargetV1 = scenario === 'resolved Session target'
      ? { kind: 'session', sessionId: 'session-1' }
      : { kind: 'machine', machineId: 'machine-1' };
    const grant = ApiTokenGrantV1Schema.parse({
      v: 1,
      actions: { families: [], ids: ['teams.members.remove', ...(scenario === 'explicit approval' ? ['approval.request.create'] : [])] },
      targets: admittedTarget.kind === 'session'
        ? { sessions: [admittedTarget.sessionId], machines: [] }
        : { sessions: [], machines: [admittedTarget.machineId] },
      approve: false, origins: [], models: null, permissionModes: null, create: null,
    });
    const authorization = {
      v: 1 as const,
      token: 'home-signed-exact-invocation',
      binding: {
        serverIdentityId: 'server-1',
        accountId: 'account-1',
        principalId: 'account-1',
        credentialId: '00000000-0000-4000-8000-000000000001',
        machineId: 'machine-1',
        actionId: scenario === 'explicit approval' ? 'approval.request.create' : 'teams.members.remove',
        requestId: 'pat-request-1',
        requestEnvelopeDigest: 'a'.repeat(43),
        target: admittedTarget,
        grant,
      },
    };
    let storedRequest: ApprovalRequest | null = null;
    const verifiedTargets: ExternalActionTargetV1[] = [];
    // Artifact persistence and the Home request are process boundaries. The
    // real executor owns capture, strict parsing, decision and replay context.
    const homeDomainAction = vi.fn(async () => ({ status: 'removed', membershipId: 'membership-1' }));
    const executor = createActionExecutor({
      approvalsCreate: async ({ request }: { request: ApprovalRequest }) => {
        storedRequest = ApprovalRequestV2Schema.parse(JSON.parse(JSON.stringify(request)));
        return { artifactId: 'pat-membership-approval' };
      },
      approvalsGet: async () => {
        if (!storedRequest) return null;
        if (scenario === 'changed stored input') {
          return { ...storedRequest, actionArgs: { v: 1, teamId: 'team-1', membershipId: 'membership-other' } };
        }
        if (scenario === 'changed resolved target' && storedRequest.v === 2) {
          // A persisted approval may not substitute a different routing target
          // beneath the original external authorization.
          return {
            ...storedRequest,
            executionOriginV1: {
              ...storedRequest.executionOriginV1,
              sessionId: 'session-substituted',
              target: { kind: 'session', sessionId: 'session-substituted' },
            },
          } as unknown as ApprovalRequest;
        }
        return storedRequest;
      },
      approvalsUpdate: async ({ request }: { request: ApprovalRequest }) => {
        storedRequest = ApprovalRequestV2Schema.parse(JSON.parse(JSON.stringify(request)));
        return { ok: true as const };
      },
      isApprovalExecutionOriginCurrent: async ({ origin, request }: Parameters<NonNullable<ActionExecutorDeps['isApprovalExecutionOriginCurrent']>>[0]) => {
        if (!origin.target) return false;
        verifiedTargets.push(origin.target);
        return verifyExternalActionApprovalInputV1({
          authorizationToken: origin.externalActionExecutionAuthorization?.token ?? '',
          actionId: request.actionId,
          target: origin.target,
          input: request.actionArgs,
          publicKey: currentMachineKey.publicKey,
          signature: origin.externalActionInputSignature ?? '',
        });
      },
      isActionApprovalRequired: () => true,
      homeDomainAction,
    } as unknown as ActionExecutorDeps);

    const admittedAuthorization = authorization;
    const admittedContext = {
      surface: 'api' as const,
      authority: 'account_automation' as const,
      actionCaller: { kind: 'host' as const },
      serverId: 'server-1',
      ...(scenario === 'wrong observed Home identity'
        ? { serverIdentityId: 'different-home-identity' }
        : {}),
      actionRequestId: authorization.binding.requestId,
      externalActionCredential: {
        accountId: authorization.binding.accountId,
        principalId: authorization.binding.principalId,
        credentialId: authorization.binding.credentialId,
        grant,
      },
      externalActionTarget: admittedTarget,
      externalActionExecutionAuthorization: admittedAuthorization,
      signExternalActionApprovalInput: ({ actionId, input, target, authorization: admittedAuthorization }:
        Parameters<NonNullable<ActionExecutorContext['signExternalActionApprovalInput']>>[0]) => signExternalActionApprovalInputV1({
        authorizationToken: admittedAuthorization.token, actionId, target, input, privateKey: machineKey.secretKey,
      }),
    };
    const targetInput = { v: 1, teamId: 'team-1', membershipId: 'membership-1' };
    const created = scenario === 'explicit approval'
      ? await executor.execute('approval.request.create', {
          actionId: 'teams.members.remove', actionArgs: targetInput,
          summary: 'Remove member', createdBy: { surface: 'cli' },
        }, admittedContext)
      : await executor.execute('teams.members.remove', targetInput, admittedContext);
    if (scenario === 'wrong observed Home identity') {
      expect(created).toMatchObject({
        ok: false,
        errorCode: 'approval_origin_unavailable',
      });
      expect(storedRequest).toBeNull();
      expect(homeDomainAction).not.toHaveBeenCalled();
      return;
    }
    expect(created).toMatchObject({
      ok: true,
      result: scenario === 'explicit approval'
        ? { artifactId: 'pat-membership-approval' }
        : { kind: 'approval_request_created' },
    });
    expect(homeDomainAction).not.toHaveBeenCalled();
    expect(storedRequest).toMatchObject({
      actionId: 'teams.members.remove',
      actionArgs: targetInput,
      executionOriginV1: {
        actionId: 'teams.members.remove',
        target: admittedTarget,
        externalActionExecutionAuthorization: admittedAuthorization,
      },
    });

    const approverContext = {
      surface: 'ui' as const,
      authority: 'present_user' as const,
      serverId: 'server-1',
      externalActionExecutionAuthorization: {
        ...authorization,
        token: 'different-approver-invocation',
        binding: { ...authorization.binding, credentialId: '00000000-0000-4000-8000-000000000002' },
      },
    };
    const replay = await executor.execute('approval.request.decide', {
      artifactId: 'pat-membership-approval', decision: 'approve',
    }, approverContext);
    if (scenario === 'changed resolved target') {
      expect(replay).toMatchObject({
        ok: true,
        result: { status: 'failed', execution: { ok: false, errorCode: 'approval_stale' } },
      });
      expect(homeDomainAction).not.toHaveBeenCalled();
      expect(verifiedTargets).toEqual([{ kind: 'session', sessionId: 'session-substituted' }]);
      expect(storedRequest).toMatchObject({
        status: 'failed',
        execution: { ok: false, errorCode: 'approval_stale' },
      });
      return;
    }
    if (scenario === 'changed stored input' || scenario === 'different machine key') {
      expect(replay).toMatchObject({
        ok: true,
        result: { status: 'failed', execution: { ok: false, errorCode: 'approval_stale' } },
      });
      expect(homeDomainAction).not.toHaveBeenCalled();
      expect(storedRequest).toMatchObject({
        status: 'failed',
        execution: { ok: false, errorCode: 'approval_stale' },
      });
      return;
    }
    expect(replay).toMatchObject({ ok: true, result: { status: 'executed', execution: { ok: true } } });
    expect(homeDomainAction).toHaveBeenCalledWith(expect.objectContaining({
      actionId: 'teams.members.remove',
      input: { v: 1, teamId: 'team-1', membershipId: 'membership-1' },
      context: expect.objectContaining({
        surface: 'api', authority: 'account_automation',
        externalActionExecutionAuthorization: admittedAuthorization,
      }),
    }));
  });

  it('persists nested contributed PAT approvals as API authority with exact plugin provenance', async () => {
    const machineKey = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(12));
    const target = { kind: 'machine' as const, machineId: 'machine-1' };
    const grant = ApiTokenGrantV1Schema.parse({
      v: 1,
      actions: { families: [], ids: ['acme.external/actions/archive-member', 'teams.members.remove'] },
      targets: { sessions: [], machines: [target.machineId] },
      approve: false, origins: [], models: null, permissionModes: null, create: null,
    });
    const authorization = {
      v: 1 as const,
      token: 'home-signed-contributed-invocation',
      binding: {
        serverIdentityId: 'server-1',
        accountId: 'account-1',
        principalId: 'principal-1',
        credentialId: '00000000-0000-4000-8000-000000000001',
        machineId: 'machine-1',
        actionId: 'action.invoke' as const,
        requestId: 'outer-request-1',
        requestEnvelopeDigest: 'a'.repeat(43),
        target,
        grant,
      },
    };
    let storedRequest: ApprovalRequest | null = null;
    const executor = createActionExecutor({
      approvalsCreate: async ({ request }: { request: ApprovalRequest }) => {
        storedRequest = ApprovalRequestV2Schema.parse(JSON.parse(JSON.stringify(request)));
        return { artifactId: 'nested-pat-approval' };
      },
      isActionApprovalRequired: () => true,
      homeDomainAction: async () => ({ status: 'removed', membershipId: 'membership-1' }),
    } as unknown as ActionExecutorDeps);
    const input = { v: 1, teamId: 'team-1', membershipId: 'membership-1' };

    await expect(executor.execute('teams.members.remove', input, {
      surface: 'plugin',
      authority: 'account_automation',
      actionCaller: {
        kind: 'plugin',
        pluginId: 'acme.external',
        contributionLocalId: 'archive-member',
        sourceCustody: { kind: 'development', registeredRootId: 'root-1' },
      },
      serverId: 'server-1',
      serverIdentityId: 'server-1',
      actionRequestId: authorization.binding.requestId,
      externalActionCredential: {
        accountId: authorization.binding.accountId,
        principalId: authorization.binding.principalId,
        credentialId: authorization.binding.credentialId,
        grant,
      },
      externalActionTarget: target,
      externalActionExecutionAuthorization: authorization,
      signExternalActionApprovalInput: ({ actionId, input: effectInput, target: effectTarget, authorization: admitted }) => (
        signExternalActionApprovalInputV1({
          authorizationToken: admitted.token,
          actionId,
          target: effectTarget,
          input: effectInput,
          privateKey: machineKey.secretKey,
        })
      ),
    })).resolves.toMatchObject({
      ok: true,
      result: { kind: 'approval_request_created', artifactId: 'nested-pat-approval' },
    });
    expect(storedRequest).toMatchObject({
      requestedSurface: 'plugin',
      createdBy: {
        pluginId: 'acme.external',
        contributionLocalId: 'archive-member',
      },
      executionOriginV1: {
        surface: 'api',
        caller: {
          kind: 'plugin',
          pluginId: 'acme.external',
          contributionLocalId: 'archive-member',
          sourceCustody: { kind: 'development', registeredRootId: 'root-1' },
        },
        externalActionExecutionAuthorization: authorization,
      },
    });
  });

  it('replays Agent Session creation with its original strict spawn policy, not the approver policy', async () => {
    let storedRequest: ApprovalRequest | null = null;
    const policy = SessionAgentSpawnPolicyV1Schema.parse({ permissionCeiling: 'read-only' });
    const caller = { kind: 'session', sessionId: 'parent-1', starterDepth: 0, turnDepth: 0 } as const;
    const sessionSpawnNew = vi.fn(async (_input: Parameters<ActionExecutorDeps['sessionSpawnNew']>[0]) => ({
      type: 'success', disposition: 'created', sessionId: 'child-1',
      executionTarget: sessionSpawnInput.executionTarget,
      organizationPlacement: sessionSpawnInput.organizationPlacement,
      initialInput: { status: 'accepted', localId: 'initial-1' },
    }));
    const executor = createActionExecutor({
      approvalsCreate: async ({ request }: { request: ApprovalRequest }) => { storedRequest = request; return { artifactId: 'spawn-approval' }; },
      approvalsGet: async () => storedRequest,
      approvalsUpdate: async ({ request }: { request: ApprovalRequest }) => { storedRequest = request; return { ok: true as const }; },
      isApprovalExecutionOriginCurrent: async () => true,
      isActionApprovalRequired: (actionId: string) => actionId === 'session.spawn_new',
      resolveAgentStartContext: async () => ({
        caller,
        baseline: { machineId: 'machine-1', directory: sessionSpawnInput.directory.path, configuration: { agentTarget: sessionSpawnInput.agentTarget, permissionMode: 'safe-yolo' } },
        ledSubtreeSessionIds: [], workDepthLimit: 4, roles: {}, callerPermissionCeiling: 'safe-yolo',
      }),
      sessionSpawnNew,
    } as unknown as ActionExecutorDeps);
    await expect(executor.execute('session.spawn_new', { ...sessionSpawnInput, permissionMode: 'read-only' }, {
      surface: 'agent', authority: 'account_automation', serverId: 'server-1',
      runtimeAccountId: 'account-1',
      actionCaller: caller,
      defaultSessionId: 'parent-1', actionRequestId: 'spawn-request-1',
      callerPermissionMode: 'safe-yolo', sessionAgentSpawnPolicyV1: policy,
      causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'safe-yolo' },
    })).resolves.toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
    const approvedSpawn = await executor.execute('approval.request.decide', {
      artifactId: 'spawn-approval', decision: 'approve',
    }, {
      surface: 'ui', authority: 'present_user', serverId: 'server-1',
      sessionAgentSpawnPolicyV1: { permissionCeiling: 'yolo' },
    });
    expect(approvedSpawn, JSON.stringify(approvedSpawn)).toMatchObject({ ok: true, result: { status: 'executed' } });
    expect(sessionSpawnNew).toHaveBeenCalledWith(expect.objectContaining({
      sessionAgentSpawnPolicyV1: policy, permissionMode: 'read-only',
    }));
    const deferredSpawnArgs = sessionSpawnNew.mock.calls[0]?.[0];
    if (!deferredSpawnArgs?.context) throw new Error('Expected the captured spawn context');
    const { actionCaller, defaultSessionMachineId, executionRunTargetMachineId, placement, ...capturedContext } = deferredSpawnArgs.context;
    // Durable replay restores routing defaults that the direct invocation omits.
    expect({ actionCaller, defaultSessionMachineId, executionRunTargetMachineId, placement }).toEqual({
      actionCaller: caller,
      defaultSessionMachineId: sessionSpawnInput.executionTarget.machineId,
      executionRunTargetMachineId: sessionSpawnInput.executionTarget.machineId,
      placement: null,
    });
    await expect(executor.execute('session.spawn_new', { ...sessionSpawnInput, permissionMode: 'read-only' }, {
      surface: 'agent', authority: 'account_automation', serverId: 'server-1',
      runtimeAccountId: 'account-1', defaultSessionId: 'parent-1',
      actionCaller: caller,
      actionRequestId: 'spawn-request-1', bypassApprovals: true,
      callerPermissionMode: 'safe-yolo', sessionAgentSpawnPolicyV1: policy,
      causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'safe-yolo' },
    })).resolves.toMatchObject({ ok: true });
    expect(sessionSpawnNew.mock.calls.map(([args]) => ({
      actionCaller: args.actionCaller, permissionMode: args.permissionMode,
      sessionAgentSpawnPolicyV1: args.sessionAgentSpawnPolicyV1,
      workDepth: args.workDepth, originSessionId: args.originSessionId,
    }))).toEqual([0, 1].map(() => ({ actionCaller: caller, permissionMode: 'read-only',
      sessionAgentSpawnPolicyV1: policy, workDepth: 1, originSessionId: caller.sessionId })));
    expect(sessionSpawnNew.mock.calls[1]?.[0]).toEqual({ ...deferredSpawnArgs, context: { ...capturedContext, actionCaller } });
  });

  it('retains an Agent permission ceiling through durable Run approval replay', async () => {
    let storedRequest: ApprovalRequest | null = null;
    const causalPermissionAuthority = { kind: 'admittedSessionInputV1' as const, admittedPermissionCeiling: 'read-only' as const };
    const executionRunAction = vi.fn(async () => ({ ok: true, result: {} }));
    const executor = createActionExecutor({
      approvalsCreate: async ({ request }: { request: ApprovalRequest }) => { storedRequest = request; return { artifactId: 'agent-stop-approval' }; },
      approvalsGet: async () => storedRequest,
      approvalsUpdate: async ({ request }: { request: ApprovalRequest }) => { storedRequest = request; return { ok: true as const }; },
      isApprovalExecutionOriginCurrent: async () => true,
      isActionApprovalRequired: (actionId: string) => actionId === 'execution.run.action',
      executionRunAction,
    } as unknown as ActionExecutorDeps);
    await expect(executor.execute('execution.run.action', { sessionId: 'session-1', runId: 'run-1', actionId: 'review.triage', input: {} }, {
      surface: 'agent', authority: 'account_automation', serverId: 'server-1',
      defaultSessionId: 'session-1', actionRequestId: 'stop-request-1',
      callerPermissionMode: 'safe-yolo', causalPermissionAuthority,
    })).resolves.toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
    await expect(executor.execute('approval.request.decide', {
      artifactId: 'agent-stop-approval', decision: 'approve',
    }, {
      surface: 'ui', authority: 'present_user', serverId: 'server-1',
      callerPermissionMode: 'yolo',
      causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'yolo' },
    })).resolves.toMatchObject({ ok: true, result: { status: 'executed' } });
    expect(executionRunAction).toHaveBeenCalledWith('session-1', { runId: 'run-1', actionId: 'review.triage', input: {} }, expect.objectContaining({
      causalPermissionAuthority, effectiveCallerPermissionMode: 'read-only',
    }));
  });

  it('requires a host-stamped present-user authority to decide an approval', async () => {
    const openRequest = ApprovalRequestV1Schema.parse({
      v: 1,
      status: 'open',
      createdAtMs: 100,
      updatedAtMs: 100,
      createdBy: { surface: 'system' },
      actionId: 'session.title.set',
      actionArgs: { sessionId: 'session-1', title: 'Approved title' },
      summary: 'Set title',
    });
    const approvalsUpdate = vi.fn(async () => ({ ok: true }));
    const executor = createActionExecutor({
      approvalsGet: async () => openRequest,
      approvalsUpdate,
    } as unknown as ActionExecutorDeps);

    await expect(executor.execute('approval.request.decide', {
      artifactId: 'approval-present-user-1',
      decision: 'reject',
    }, {
      surface: 'api',
      authority: 'account_automation',
    })).resolves.toMatchObject({
      ok: false,
      errorCode: 'present_user_required',
    });
    expect(approvalsUpdate).not.toHaveBeenCalled();

    await expect(executor.execute('approval.request.decide', {
      artifactId: 'approval-present-user-1',
      decision: 'reject',
    }, {
      surface: 'ui',
      authority: 'present_user',
    })).resolves.toMatchObject({
      ok: true,
      result: { status: 'rejected' },
    });
    expect(approvalsUpdate).toHaveBeenCalledTimes(1);
  });

  it('reaches the injected canonical contributed-Action invoker through action.invoke', async () => {
    const invokeContributedAction = vi.fn(async () => ({
      ok: true as const,
      result: { status: 'executed', value: { opened: true } },
    }));
    const executor = createActionExecutor({
      invokeContributedAction,
      isActionApprovalRequired: () => false,
    } as unknown as ActionExecutorDeps);

    await expect(executor.execute('action.invoke', {
      action: { pluginId: 'acme.notes', localId: 'save-note' },
      input: { title: 'Quarterly notes' },
    }, {
      surface: 'api',
      authority: 'account_automation',
    })).resolves.toEqual({
      ok: true,
      result: { status: 'executed', value: { opened: true } },
    });

    expect(invokeContributedAction).toHaveBeenCalledWith(expect.objectContaining({
      action: { pluginId: 'acme.notes', localId: 'save-note' },
      input: { title: 'Quarterly notes' },
    }));
  });

  it('projects contributed failures onto the public Action failure envelope', async () => {
    const invokeContributedAction = vi.fn(async () => ({
      ok: false as const,
      errorCode: 'target_declined',
      error: 'Target rejected this request',
      details: { reason: 'policy' },
      retryable: true,
      data: { internalTargetState: 'declined' },
      actionHandlerInvocation: 'notStarted' as const,
    }));
    const executor = createActionExecutor({
      invokeContributedAction,
      isActionApprovalRequired: () => false,
    } as unknown as ActionExecutorDeps);

    await expect(executor.execute('action.invoke', {
      action: { pluginId: 'acme.notes', localId: 'save-note' },
      input: { title: 'Quarterly notes' },
    }, {
      surface: 'api',
      authority: 'account_automation',
    })).resolves.toEqual({
      ok: false,
      errorCode: 'target_declined',
      error: 'Target rejected this request',
      details: { reason: 'policy' },
    });
  });

  it('replays a plugin-approved Session spawn with the exact contribution and nested initial-input settlement', async () => {
    let storedRequest: ApprovalRequest | null = null;
    const approvalsCreate = vi.fn(async ({ request }: { request: ApprovalRequest }) => {
      storedRequest = request;
      return { artifactId: 'approval-plugin-spawn-1' };
    });
    const approvalsGet = vi.fn(async () => storedRequest);
    const approvalsUpdate = vi.fn(async ({ request }: { request: ApprovalRequest }) => {
      storedRequest = request;
      return { ok: true as const };
    });
    const sessionSpawnNew = vi.fn(async () => ({
      type: 'success' as const,
      disposition: 'created' as const,
      sessionId: 'session-1',
      executionTarget: sessionSpawnInput.executionTarget,
      organizationPlacement: sessionSpawnInput.organizationPlacement,
      initialInput: { status: 'accepted' as const, localId: 'initial-input-1' },
    }));
    const executor = createActionExecutor({
      approvalsCreate,
      approvalsGet,
      approvalsUpdate,
      sessionSpawnNew,
      isApprovalExecutionOriginCurrent: async () => true,
      isActionApprovalRequired: (actionId, context) => (
        actionId === 'session.spawn_new' && context.surface === 'plugin'
      ),
    } as unknown as ActionExecutorDeps);

    await expect(executor.execute('session.spawn_new', sessionSpawnInput, {
      surface: 'plugin',
      authority: 'account_automation',
      serverId: 'server-1',
      defaultSessionMachineId: 'machine-1',
      actionRequestId: 'request-plugin-spawn-1',
      actionCaller: {
        kind: 'plugin',
        pluginId: 'plugin.example',
        contributionLocalId: 'session-spawn',
        sourceCustody: { kind: 'development', registeredRootId: 'plugin-root-1' },
      },
    })).resolves.toMatchObject({
      ok: true,
      result: { kind: 'approval_request_created', artifactId: 'approval-plugin-spawn-1' },
    });

    expect(storedRequest).toMatchObject({
      v: 2,
      requestedSurface: 'plugin',
      executionOriginV1: {
        authority: 'account_automation',
        surface: 'plugin',
        serverId: 'server-1',
        machineId: 'machine-1',
        caller: {
          kind: 'plugin',
          pluginId: 'plugin.example',
          contributionLocalId: 'session-spawn',
          sourceCustody: { kind: 'development', registeredRootId: 'plugin-root-1' },
        },
      },
      createdBy: {
        surface: 'system',
        pluginId: 'plugin.example',
        contributionLocalId: 'session-spawn',
      },
      actionArgs: sessionSpawnInput,
    });

    await expect(executor.execute('approval.request.decide', {
      artifactId: 'approval-plugin-spawn-1',
      decision: 'approve',
    }, { surface: 'ui', authority: 'present_user' })).resolves.toMatchObject({
      ok: true,
      result: {
        status: 'executed',
        execution: {
          ok: true,
          result: {
            type: 'success',
            sessionId: 'session-1',
            initialInput: { status: 'accepted', localId: 'initial-input-1' },
          },
        },
      },
    });
    expect(sessionSpawnNew).toHaveBeenCalledWith(expect.objectContaining({
      initialInput: { text: 'Inspect this repository.' },
      actionCaller: {
        kind: 'plugin',
        pluginId: 'plugin.example',
        contributionLocalId: 'session-spawn',
        sourceCustody: { kind: 'development', registeredRootId: 'plugin-root-1' },
        startedBy: 'trigger',
      },
    }));
  });

  it('refuses to create a durable plugin approval without source custody', async () => {
    const approvalsCreate = vi.fn();
    const executor = createActionExecutor({
      approvalsCreate,
      isActionApprovalRequired: () => true,
    } as unknown as ActionExecutorDeps);

    await expect(executor.execute('session.spawn_new', sessionSpawnInput, {
      surface: 'plugin',
      authority: 'account_automation',
      serverId: 'server-1',
      defaultSessionMachineId: 'machine-1',
      actionRequestId: 'request-plugin-generationless',
      actionCaller: {
        kind: 'plugin',
        pluginId: 'plugin.example',
        contributionLocalId: 'session-spawn',
      },
    })).resolves.toMatchObject({
      ok: false,
      errorCode: 'approval_origin_unavailable',
    });
    expect(approvalsCreate).not.toHaveBeenCalled();
  });

  it('fails an incomplete legacy plugin approval before it can start a Session', async () => {
    let storedRequest: ApprovalRequestV1 = {
      v: 1,
      status: 'open',
      createdAtMs: 100,
      updatedAtMs: 100,
      createdBy: { surface: 'system', pluginId: 'plugin.example' },
      requestedSurface: 'plugin',
      actionId: 'session.spawn_new',
      actionArgs: sessionSpawnInput,
      summary: 'Create session',
    };
    const approvalsGet = vi.fn(async () => storedRequest);
    const approvalsUpdate = vi.fn(async ({ request }: { request: ApprovalRequestV1 }) => {
      storedRequest = request;
      return { ok: true as const };
    });
    const sessionSpawnNew = vi.fn(async () => ({
      type: 'success' as const,
      disposition: 'created' as const,
      sessionId: 'session-1',
      executionTarget: sessionSpawnInput.executionTarget,
      organizationPlacement: sessionSpawnInput.organizationPlacement,
      initialInput: { status: 'accepted' as const, localId: 'initial-input-1' },
    }));
    const executor = createActionExecutor({
      approvalsGet,
      approvalsUpdate,
      sessionSpawnNew,
    } as unknown as ActionExecutorDeps);

    await expect(executor.execute('approval.request.decide', {
      artifactId: 'approval-plugin-spawn-legacy-1',
      decision: 'approve',
    }, { surface: 'ui', authority: 'present_user' })).resolves.toMatchObject({
      ok: true,
      result: {
        status: 'failed',
        execution: { ok: false, errorCode: 'approval_stale' },
      },
    });
    expect(approvalsUpdate).toHaveBeenCalledTimes(2);
    expect(storedRequest).toMatchObject({
      status: 'failed',
      execution: { ok: false, errorCode: 'approval_stale' },
    });
    expect(sessionSpawnNew).not.toHaveBeenCalled();
  });

  it('does not create a durable automatic approval when a plugin caller lacks contribution provenance', async () => {
    const approvalsCreate = vi.fn(async () => ({ artifactId: 'approval-plugin-missing-caller-1' }));
    const executor = createActionExecutor({
      approvalsCreate,
      isActionApprovalRequired: (actionId, context) => (
        actionId === 'session.spawn_new' && context.surface === 'plugin'
      ),
    } as unknown as ActionExecutorDeps);

    await expect(executor.execute('session.spawn_new', sessionSpawnInput, {
      surface: 'plugin',
      actionCaller: { kind: 'plugin', pluginId: 'plugin.example' },
    })).resolves.toMatchObject({
      ok: false,
      errorCode: 'plugin_action_caller_required',
    });
    expect(approvalsCreate).not.toHaveBeenCalled();
  });

  it('does not create an explicit approval-queue row when a plugin caller lacks contribution provenance', async () => {
    const approvalsCreate = vi.fn(async () => ({ artifactId: 'approval-plugin-missing-caller-2' }));
    const executor = createActionExecutor({ approvalsCreate } as unknown as ActionExecutorDeps);

    await expect(executor.execute('approval.request.create', {
      actionId: 'session.list',
      actionArgs: {},
      summary: 'List sessions',
      createdBy: { surface: 'system' },
    }, {
      surface: 'plugin',
      actionCaller: { kind: 'plugin', pluginId: 'plugin.example' },
    })).resolves.toMatchObject({
      ok: false,
      errorCode: 'plugin_action_caller_required',
    });
    expect(approvalsCreate).not.toHaveBeenCalled();
  });

  it('refuses a plugin request to have the user approve a host-internal Action', async () => {
    const approvalsCreate = vi.fn(async () => ({ artifactId: 'approval-plugin-internal-target-1' }));
    const executor = createActionExecutor({ approvalsCreate } as unknown as ActionExecutorDeps);

    await expect(executor.execute('approval.request.create', {
      actionId: 'sessions.subagents.upsert',
      actionArgs: {
        id: 'subagent-1',
        parentSessionId: 'session-1',
        origin: 'agent',
        kind: 'native',
        status: 'running',
      },
      summary: 'Record a child agent',
      createdBy: { surface: 'system' },
    }, {
      surface: 'plugin',
      authority: 'account_automation',
      serverId: 'server-1',
      actionCaller: {
        kind: 'plugin',
        pluginId: 'plugin.example',
        contributionLocalId: 'approval-requester',
      },
    })).resolves.toMatchObject({
      ok: false,
      errorCode: 'invalid_parameters',
    });
    expect(approvalsCreate).not.toHaveBeenCalled();
  });

  it('still creates an approval row for a plugin-invocable Action target', async () => {
    const approvalsCreate = vi.fn(async () => ({ artifactId: 'approval-plugin-invocable-target-1' }));
    const executor = createActionExecutor({ approvalsCreate } as unknown as ActionExecutorDeps);

    await expect(executor.execute('approval.request.create', {
      actionId: 'session.list',
      actionArgs: {},
      summary: 'List sessions',
      createdBy: { surface: 'system' },
    }, {
      surface: 'plugin',
      authority: 'account_automation',
      serverId: 'server-1',
      defaultSessionId: 'session-1',
      sessionListAccess: 'current_session',
      actionRequestId: 'request-plugin-approval-1',
      actionCaller: {
        kind: 'plugin',
        pluginId: 'plugin.example',
        contributionLocalId: 'approval-requester',
        sourceCustody: { kind: 'development', registeredRootId: 'plugin-root-1' },
      },
    })).resolves.toMatchObject({ ok: true });
    expect(approvalsCreate).toHaveBeenCalledTimes(1);
  });

  it('rejects a noncanonical plugin identity in a durable approval row', () => {
    expect(ApprovalRequestV1Schema.safeParse({
      v: 1,
      status: 'open',
      createdAtMs: 100,
      updatedAtMs: 100,
      createdBy: {
        surface: 'system',
        pluginId: ' plugin.example ',
        contributionLocalId: 'session-spawn',
      },
      requestedSurface: 'plugin',
      actionId: 'session.list',
      actionArgs: {},
      summary: 'List sessions',
    }).success).toBe(false);
  });

  it('keeps predecessor V1 approvals readable but never replays them', async () => {
    let storedRequest = ApprovalRequestV1Schema.parse({
      v: 1,
      status: 'open',
      createdAtMs: 100,
      updatedAtMs: 100,
      createdBy: { surface: 'session_agent', sessionId: 'requesting-session' },
      actionId: 'session.title.set',
      actionArgs: { sessionId: 'session-1', title: 'From predecessor' },
      summary: 'Set title',
    });
    const approvalsGet = vi.fn(async () => storedRequest);
    const approvalsUpdate = vi.fn(async ({ request }: { request: ApprovalRequestV1 }) => {
      storedRequest = request;
      return { ok: true as const };
    });
    const sessionTitleSet = vi.fn(async () => ({ updated: true }));
    const observeActionExecution = vi.fn(async () => undefined);
    const executor = createActionExecutor({
      approvalsGet,
      approvalsUpdate,
      sessionTitleSet,
      observeActionExecution,
    } as unknown as ActionExecutorDeps);

    await expect(executor.execute('approval.request.decide', {
      artifactId: 'approval-session-agent-predecessor-1',
      decision: 'approve',
    }, { surface: 'ui', authority: 'present_user' })).resolves.toMatchObject({
      ok: true,
      result: {
        status: 'failed',
        execution: { ok: false, errorCode: 'approval_stale' },
      },
    });
    expect(approvalsUpdate).toHaveBeenCalledTimes(2);
    expect(storedRequest).toMatchObject({
      status: 'failed',
      execution: { ok: false, errorCode: 'approval_stale' },
    });
    expect(sessionTitleSet).not.toHaveBeenCalled();
    expect(observeActionExecution).not.toHaveBeenCalled();
  });

  it.each([
    ['revoked PAT', false, 'server-1', 'server-1', true],
    ['wrong current Home', true, 'server-2', 'server-2', false],
  ] as const)('fails a V2 API approval when %s invalidates its execution origin', async (
    _case,
    isCurrent,
    decidingServerId,
    observedServerIdentityId,
    checksCurrentness,
  ) => {
    const grant = ApiTokenGrantV1Schema.parse({
      v: 1,
      actions: { families: [], ids: ['session.title.set'] },
      targets: { sessions: ['session-1'], machines: [] },
      approve: false, origins: [], models: null, permissionModes: null, create: null,
    });
    let storedRequest: ApprovalRequest = ApprovalRequestV2Schema.parse({
      v: 2,
      status: 'open',
      createdAtMs: 100,
      updatedAtMs: 100,
      createdBy: { surface: 'mcp' },
      executionOriginV1: {
        v: 1,
        authority: 'account_automation',
        surface: 'api',
        caller: { kind: 'host' },
        accountId: 'account-1',
        principalId: 'principal-1',
        credentialId: 'credential-1',
        serverId: 'server-1',
        serverIdentityId: 'server-1',
        sessionId: 'session-1',
        target: { kind: 'session', sessionId: 'session-1' },
        actionId: 'session.title.set',
        requestId: 'request-1',
        machineId: 'machine-1',
        externalActionInputSignature: 'a'.repeat(86),
        externalActionExecutionAuthorization: {
          v: 1,
          token: 'home-signed-original-session-invocation',
          binding: {
            serverIdentityId: 'server-1', accountId: 'account-1', principalId: 'principal-1',
            credentialId: 'credential-1', machineId: 'machine-1',
            actionId: 'session.title.set', requestId: 'request-1',
            requestEnvelopeDigest: 'a'.repeat(43),
            target: { kind: 'session', sessionId: 'session-1' },
            grant,
          },
        },
      },
      actionId: 'session.title.set',
      actionArgs: { sessionId: 'session-1', title: 'From PAT' },
      summary: 'Set title',
    });
    const approvalsUpdate = vi.fn(async ({ request }: { request: ApprovalRequest }) => {
      storedRequest = request;
      return { ok: true as const };
    });
    const sessionTitleSet = vi.fn(async () => ({ updated: true }));
    const isApprovalExecutionOriginCurrent = vi.fn(async () => isCurrent);
    const executor = createActionExecutor({
      approvalsGet: async () => storedRequest,
      approvalsUpdate,
      sessionTitleSet,
      isApprovalExecutionOriginCurrent,
    } as unknown as ActionExecutorDeps);

    const result = await executor.execute('approval.request.decide', {
      artifactId: 'approval-api-1',
      decision: 'approve',
    }, {
      surface: 'ui',
      authority: 'present_user',
      serverId: decidingServerId,
      serverIdentityId: observedServerIdentityId,
    });
    expect(result).toMatchObject({
      ok: true,
      result: {
        status: 'failed',
        execution: { ok: false, errorCode: 'approval_stale' },
      },
    });
    if (checksCurrentness) {
      expect(isApprovalExecutionOriginCurrent).toHaveBeenCalledWith(expect.objectContaining({
        origin: expect.objectContaining({
          accountId: 'account-1',
          principalId: 'principal-1',
          credentialId: 'credential-1',
          target: { kind: 'session', sessionId: 'session-1' },
        }),
      }));
      expect(approvalsUpdate).toHaveBeenCalledTimes(2);
    } else {
      expect(isApprovalExecutionOriginCurrent).not.toHaveBeenCalled();
      expect(approvalsUpdate).toHaveBeenCalledTimes(2);
    }
    expect(storedRequest).toMatchObject({
      status: 'failed',
      execution: { ok: false, errorCode: 'approval_stale' },
    });
    expect(sessionTitleSet).not.toHaveBeenCalled();
  });

  it('routes an approval artifact through a current-device profile while validating the immutable creator profile and Home identity', async () => {
    let storedRequest: ApprovalRequest = ApprovalRequestV2Schema.parse({
      v: 2,
      status: 'open',
      createdAtMs: 100,
      updatedAtMs: 100,
      createdBy: { surface: 'mcp', sessionId: 'session-1' },
      executionOriginV1: {
        v: 1,
        authority: 'account_automation',
        surface: 'mcp',
        caller: { kind: 'host' },
        serverId: 'creator-device-profile',
        serverIdentityId: 'srv_shared_home',
        accountId: 'account-1',
        machineId: 'machine-1',
        sessionId: 'session-1',
        target: { kind: 'session', sessionId: 'session-1' },
        actionId: 'session.title.set',
        requestId: 'request-1',
      },
      actionId: 'session.title.set',
      actionArgs: { sessionId: 'session-1', title: 'Cross-device approval' },
      summary: 'Set title',
    });
    const approvalsGet = vi.fn(async () => storedRequest);
    const approvalsUpdate = vi.fn(async ({ request, serverId }: { request: ApprovalRequest; serverId?: string | null }) => {
      expect(serverId).toBe('creator-device-profile');
      storedRequest = request;
      return { ok: true as const };
    });
    const sessionTitleSet = vi.fn(async () => ({ updated: true }));
    const executor = createActionExecutor({
      approvalsGet,
      approvalsUpdate,
      sessionTitleSet,
      isApprovalExecutionOriginCurrent: async ({ origin }) => origin.serverIdentityId === 'srv_shared_home',
    } as unknown as ActionExecutorDeps);

    await expect(executor.execute('approval.request.decide', {
      artifactId: 'approval-cross-device-1',
      decision: 'approve',
      originServerId: 'creator-device-profile',
      serverIdentityId: 'srv_shared_home',
      serverId: 'current-device-profile',
    }, {
      surface: 'ui',
      authority: 'present_user',
      serverId: 'current-device-profile',
      serverIdentityId: 'srv_shared_home',
    })).resolves.toMatchObject({
      ok: true,
      result: { status: 'executed' },
    });
    expect(approvalsGet.mock.calls[0]?.[0]).toEqual({
      artifactId: 'approval-cross-device-1',
      serverId: null,
    });
    expect(sessionTitleSet).toHaveBeenCalledOnce();
  });

  it('rejects an obsolete execution-run occurrence after the host origin remains current', async () => {
    let storedRequest: ApprovalRequest = ApprovalRequestV2Schema.parse({
      v: 2,
      status: 'open',
      createdAtMs: 100,
      updatedAtMs: 100,
      createdBy: { surface: 'mcp', sessionId: 'session-1' },
      executionOriginV1: {
        v: 1,
        authority: 'account_automation',
        surface: 'mcp',
        caller: { kind: 'host' },
        serverId: 'server-1',
        sessionId: 'session-1',
        runId: 'run-1',
        runOccurrenceId: 'occurrence-original',
        actionId: 'execution.run.stop',
        requestId: 'request-run-stop-1',
      },
      actionId: 'execution.run.stop',
      actionArgs: { sessionId: 'session-1', runId: 'run-1' },
      summary: 'Stop run',
    });
    const approvalsUpdate = vi.fn(async ({ request }: { request: ApprovalRequest }) => {
      storedRequest = request;
      return { ok: true as const };
    });
    const executionRunGet = vi.fn(async () => ({
      run: {
        runId: 'run-1',
        inputTurns: { occurrenceId: 'occurrence-replaced' },
      },
    }));
    const executionRunStop = vi.fn(async () => ({ ok: true }));
    const executor = createActionExecutor({
      approvalsGet: async () => storedRequest,
      approvalsUpdate,
      isApprovalExecutionOriginCurrent: async () => true,
      executionRunGet,
      executionRunStop,
    } as unknown as ActionExecutorDeps);

    await expect(executor.execute('approval.request.decide', {
      artifactId: 'approval-run-stop-1',
      decision: 'approve',
    }, { surface: 'ui', authority: 'present_user', serverId: 'server-1' })).resolves.toMatchObject({
      ok: true,
      result: { status: 'failed', execution: { ok: false, errorCode: 'approval_stale' } },
    });
    expect(executionRunGet).toHaveBeenCalledWith(
      'session-1',
      { runId: 'run-1', includeStructured: false },
      {},
    );
    expect(approvalsUpdate).toHaveBeenCalledTimes(2);
    expect(storedRequest).toMatchObject({
      status: 'failed',
      execution: { ok: false, errorCode: 'approval_stale' },
    });
    expect(executionRunStop).not.toHaveBeenCalled();
  });

  it('keeps legacy PAT approvals readable but refuses replay from descriptive credential IDs alone', async () => {
    let storedRequest: ApprovalRequest = ApprovalRequestV2Schema.parse({
      v: 2,
      status: 'open',
      createdAtMs: 100,
      updatedAtMs: 100,
      createdBy: { surface: 'mcp' },
      executionOriginV1: {
        v: 1,
        authority: 'account_automation',
        surface: 'api',
        caller: { kind: 'host' },
        accountId: 'account-1',
        principalId: 'principal-1',
        credentialId: 'credential-1',
        serverId: 'server-1',
        sessionId: 'session-1',
        target: { kind: 'session', sessionId: 'session-1' },
        actionId: 'session.title.set',
        requestId: 'request-1',
      },
      actionId: 'session.title.set',
      actionArgs: { sessionId: 'session-1', title: 'From PAT' },
      summary: 'Set title',
    });
    const sessionTitleSet = vi.fn(async () => ({ updated: true }));
    const approvalsUpdate = vi.fn(async ({ request }: { request: ApprovalRequest }) => {
      storedRequest = request;
      return { ok: true as const };
    });
    const executor = createActionExecutor({
      approvalsGet: async () => storedRequest,
      approvalsUpdate,
      sessionTitleSet,
      isApprovalExecutionOriginCurrent: async ({ origin }) => (
        origin.authority === 'account_automation'
        && origin.credentialId === 'credential-1'
        && origin.target?.kind === 'session'
        && origin.target.sessionId === 'session-1'
      ),
    } as unknown as ActionExecutorDeps);

    await expect(executor.execute('approval.request.decide', {
      artifactId: 'approval-api-current-1',
      decision: 'approve',
    }, { surface: 'ui', authority: 'present_user', serverId: 'server-1' })).resolves.toMatchObject({
      ok: true,
      result: { status: 'failed', execution: { ok: false, errorCode: 'approval_stale' } },
    });
    expect(approvalsUpdate).toHaveBeenCalledTimes(2);
    expect(storedRequest).toMatchObject({
      status: 'failed',
      execution: { ok: false, errorCode: 'approval_stale' },
    });
    expect(sessionTitleSet).not.toHaveBeenCalled();
  });
  it('persists the exact Workflow Run caller in a durable approval origin', async () => {
    const approvalsCreate = vi.fn(async () => ({ artifactId: 'workflow-approval-1' }));
    const executor = createActionExecutor({
      approvalsCreate,
      isActionApprovalRequired: () => true,
    } as unknown as ActionExecutorDeps);
    const authorization = {
      admittedPermissionCeiling: 'default' as const,
      principal: {
        kind: 'api' as const,
        accountId: 'account-1',
        principalId: 'principal-1',
        credentialId: 'credential-1',
      },
    };

    await expect(executor.execute('agents.backends.list', {}, {
      surface: 'cli',
      authority: 'account_automation',
      serverId: 'server-1',
      actionRequestId: 'request-workflow-1',
      actionCaller: { kind: 'workflowRun', runId: 'run-1', authorization },
    })).resolves.toMatchObject({ ok: true, result: { kind: 'approval_request_created', artifactId: 'workflow-approval-1' } });

    expect(approvalsCreate).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({
        executionOriginV1: expect.objectContaining({
          caller: { kind: 'workflowRun', runId: 'run-1', authorization },
        }),
      }),
    }));
  });

  it('refuses to create a durable Workflow approval without its accepted authorization', async () => {
    const approvalsCreate = vi.fn();
    const executor = createActionExecutor({
      approvalsCreate,
      isActionApprovalRequired: () => true,
    } as unknown as ActionExecutorDeps);

    await expect(executor.execute('agents.backends.list', {}, {
      surface: 'cli',
      authority: 'account_automation',
      serverId: 'server-1',
      actionRequestId: 'request-workflow-2',
      actionCaller: {
        kind: 'workflowRun',
        runId: 'run-2',
        authorization: { admittedPermissionCeiling: 'default' } as never,
      },
    })).resolves.toMatchObject({ ok: false, errorCode: 'approval_origin_unavailable' });
    expect(approvalsCreate).not.toHaveBeenCalled();
  });
});
