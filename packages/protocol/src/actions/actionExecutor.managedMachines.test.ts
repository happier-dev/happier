import { ACTION_IDS } from './actionIds.js';
import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1 } from '../account/settings/sessionAgentSpawnPolicyV1.js';
import { API_TOKEN_FULL_GRANT_V1 } from '../auth/apiTokenGrant.js';
import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';
import { ApprovalRequestV1Schema, type ApprovalRequest } from '../approvals/approvalRequestV1.js';
import { buildApprovalRequestArtifactHeaderV1 } from '../approvals/approvalArtifactHeaderV1.js';

const agentTarget = { kind: 'agent', identity: { pluginId: 'native.agent', localId: 'agent' } } as const;

describe('machine environment apply admission', () => {
  it('runs only the reviewed preset revision after confirmation through the machine transport', async () => {
    const applied: unknown[] = [];
    const executor = createActionExecutor({ machineEnvironmentApply: async request => {
      applied.push(request.input);
      return { operationId: 'environment-operation', terminalId: 'environment-output' };
    } } as ActionExecutorDeps);
    const input = { homeId: 'home', machineId: 'guest', presetId: 'preset', presetRevision: 4 };
    expect(await executor.execute('machines.environment.apply', input, { surface: 'cli', authority: 'present_user',
      presentUserConfirmation: { actionId: 'machines.environment.apply' } }))
      .toEqual({ ok: true, result: { operationId: 'environment-operation', terminalId: 'environment-output' } });
    expect(applied).toEqual([input]);
    expect(await executor.execute('machines.environment.apply', { ...input, environment: { setupScript: 'unreviewed' } },
      { surface: 'cli', authority: 'present_user', presentUserConfirmation: { actionId: 'machines.environment.apply' } }))
      .toMatchObject({ ok: false });
    expect(applied).toEqual([input]);
  });
});
const acquireInput = {
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
    let networkResult: unknown = { choices: [] };
    const executor = createActionExecutor({ managedMachineAction: async () => networkResult,
      isActionApprovalRequired: () => false } as unknown as ActionExecutorDeps);
    const input = { homeId: 'home', controller: acquireInput.selection.controller,
      contribution: acquireInput.selection.launch.provider, selectors: {} };
    expect(await executor.execute('machines.provisioners.options', input, { surface: 'cli' }))
      .toMatchObject({ ok: true, result: { choices: [] } });
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
    } }, { ...agentContext, agentStartContext: { ...agentContext.agentStartContext, roles: {
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
      throw Object.assign(new Error('private diagnostics'), { code: 'controller_unavailable' });
    } } as unknown as ActionExecutorDeps);
    expect(await unavailable.execute('machines.managed.list', { homeId: 'home' }, { surface: 'cli' }))
      .toEqual({ ok: false, errorCode: 'controller_unavailable', error: 'controller_unavailable' });
  });
});
