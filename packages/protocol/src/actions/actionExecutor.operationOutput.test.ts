import { describe, expect, it, vi } from 'vitest';
import { completeActionResult, createActionExecutor, settleActionOutput, type ActionExecutorDeps } from './actionExecutor.js';
import type { ActionOperationCredentialUseV1 } from './actionExecutionResult.js';
import { getActionSpec } from './actionSpecs.js';
import { ActionIdSchema } from './actionIds.js';
import { resolveActionApprovalRouting } from './actionApprovalPolicy.js';
import { normalizeActionsSettingsV1, setActionApprovalOverride } from './actionSettings.js';
import { executeActionOperationActionV1 } from './executor/actionOperationActions.js';
import { ACTION_OPERATION_ACTION_IDS_V1 } from './operations/actionIdsV1.js';

describe('operation and retained output Actions', () => {
  it.each(['accept', 'decline', 'unmounted'] as const)(
    'keeps %s product Stop confirmation out of agent approval custody', async outcome => {
      const transport = vi.fn(async () => ({ kind: 'requested' }));
      const confirm = vi.fn(async () => outcome === 'accept');
      const approvalsCreate = vi.fn(async () => ({ artifactId: 'unexpected-approval' }));
      const executor = createActionExecutor({ approvalsCreate,
        isActionApprovalRequired: () => true,
        ...(outcome === 'unmounted' ? {} : { presentUserActionConfirmation: confirm }),
        actionOperationAction: args => executeActionOperationActionV1({ ...args, transport }),
      });
      const result = await executor.execute('action.operations.cancel', {
        serverId: 'home', machineId: 'machine', operationId: 'operation',
      }, { surface: 'ui', serverId: 'home', authority: 'present_user', actionCaller: { kind: 'host' } });
      expect(result).toMatchObject(outcome === 'accept' ? { ok: true, result: { kind: 'requested' } }
        : { ok: false, errorCode: outcome === 'decline' ? 'approval_canceled' : 'action_interactive_review_required' });
      expect(confirm).toHaveBeenCalledTimes(outcome === 'unmounted' ? 0 : 1);
      expect(transport).toHaveBeenCalledTimes(outcome === 'accept' ? 1 : 0);
      expect(approvalsCreate).not.toHaveBeenCalled();
    },
  );
  it('admits operation observation directly while retaining product cancellation confirmation and automation approval', () => {
    for (const actionId of ACTION_OPERATION_ACTION_IDS_V1) {
      const spec = getActionSpec(actionId);
      const context = { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } } as const;
      const consequence = spec.sideEffectClass === 'write';
      const decision = resolveActionApprovalRouting({ actionId, spec, context });
      expect(decision.required, actionId).toBe(false);
      expect(decision.uiConfirmationRequired === true, actionId).toBe(consequence);
      for (const surface of ['agent', 'mcp'] as const) {
        expect(resolveActionApprovalRouting({ actionId, spec,
          context: { surface, authority: 'account_automation' } }).required, `${surface}:${actionId}`).toBe(consequence);
      }
      for (const approvalRequired of [false, true]) {
        const settings = setActionApprovalOverride({ settings: normalizeActionsSettingsV1(null),
          actionId, surface: 'ui', approvalRequired });
        const configured = resolveActionApprovalRouting({ actionId, spec, context, settings });
        expect(configured.required, actionId).toBe(false);
        expect(configured.uiConfirmationRequired === true, actionId).toBe(consequence && approvalRequired);
      }
    }
  });
  it('observes the pending New Session operation without confirming the person’s own read', async () => {
    const transport = vi.fn(async () => ({ kind: 'not_found' }));
    const confirm = vi.fn(async () => false);
    const executor = createActionExecutor({
      presentUserActionConfirmation: confirm,
      actionOperationAction: args => executeActionOperationActionV1({ ...args, transport }),
    } as ActionExecutorDeps);
    expect(await executor.execute('action.operations.get', {
      serverId: 'home', machineId: 'machine', operationId: 'session-creation', waitForTerminal: true,
    }, { surface: 'ui', serverId: 'home', authority: 'present_user', actionCaller: { kind: 'host' } }))
      .toEqual({ ok: true, result: { kind: 'not_found' } });
    expect(confirm).not.toHaveBeenCalled();
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport).toHaveBeenCalledWith(expect.objectContaining({
      machineId: 'machine', payload: { operationId: 'session-creation', waitForTerminal: true },
    }));
  });

  it('shares strict terminal projection, pending custody and credential facts with native Action hosts', () => {
    const operationCredentialUses = [{ v: 1, kind: 'connected_account', label: null,
      owner: { kind: 'account', accountId: 'owner' }, service: { pluginId: 'example.service', localId: 'git' },
      why: { kind: 'purpose_binding', purpose: { consumer: { pluginId: 'example.worker', localId: 'publish' }, purpose: 'repository-write' }, target: 'account' },
      currentness: { kind: 'current_at_materialization' } }] satisfies readonly ActionOperationCredentialUseV1[];
    expect(settleActionOutput('action.operations.get', { ok: true, result: { kind: 'not_found' }, operationCredentialUses }))
      .toEqual({ ok: true, result: { kind: 'not_found' }, operationCredentialUses });
    expect(settleActionOutput('action.operations.get', completeActionResult({ kind: 'not_found', privateTransport: 'not public' })))
      .toEqual({ ok: false, errorCode: 'invalid_action_output', error: 'invalid_action_output' });
    const pending = { ok: true as const, result: {
      kind: 'approval_request_created', artifactId: 'update-approval', actionId: 'artifact.update',
    }, operationCredentialUses };
    expect(settleActionOutput('artifact.public_link.create', pending)).toBe(pending);
    const failure = { ok: false as const, errorCode: 'outcome_unknown', error: 'outcome_unknown',
      effectAttempted: true, privateTransport: 'not public', operationCredentialUses };
    // Uncertainty remains a failure for ordinary Actions; only Project Open has its existing domain result.
    expect(settleActionOutput('action.operations.get', failure)).toEqual({ ok: false,
      errorCode: 'outcome_unknown', error: 'outcome_unknown', effectAttempted: true, operationCredentialUses });
  });

  it('routes a qualified selected copy through public UI, agent, MCP and CLI Action admission', async () => {
    const input = { serverId: 'home', machineId: 'machine', operationId: 'operation', byteOffset: 1,
      selection: { kind: 'bytes', endByteOffset: 3 } };
    // Machine RPC is the system boundary; Action schemas, dispatch and output projection stay real.
    const transport = vi.fn(async ({ method }: { method: string }) => method === 'actionOperation.get.v2'
      ? { kind: 'found', operation: { version: 1, operationId: 'operation', revision: 1,
        actionId: 'projects.script.run', state: 'succeeded', scope: { accountId: 'account', machineId: 'machine' },
        title: 'Build', createdAt: 1, startedAt: 1, settledAt: 2, cancellation: 'supported', domainRef: { kind: 'projectCommand', purpose: 'script',
          serverId: 'home', machineId: 'machine', workspaceRefId: 'workspace', cwd: '/project', terminalId: 'terminal' } } }
      : { ok: true, terminalId: 'terminal', frames: [{ t: 'bytes', terminalId: 'terminal', seq: 1,
        byteOffset: 1, byteLength: 2, encoding: 'base64', data: 'YmM=' }],
        nextByteOffset: 3, availableByteOffset: 4, droppedBeforeByteOffset: 0, done: false });
    const executor = createActionExecutor({
      actionOperationAction: args => executeActionOperationActionV1({ ...args, transport }),
    } as ActionExecutorDeps);
    for (const surface of ['ui', 'agent', 'mcp', 'cli'] as const) {
      const result = await executor.execute('projects.execution.output.copy', input,
        { surface, serverId: 'home', bypassApprovals: true });
      expect(result, JSON.stringify({ surface, result })).toMatchObject({ ok: true, result: { kind: 'bytes',
          selection: { request: input, text: 'bc', coverage: { complete: true, gaps: [] } } } });
    }
  });

  it('keeps managed Action routing scope out of the unchanged ordinary operation RPC input', async () => {
    const transport = vi.fn(async () => ({ kind: 'not_found' }));
    expect(await executeActionOperationActionV1({ actionId: 'action.operations.get', input: {
      serverId: 'home', machineId: 'controller', operationId: 'operation', managed: { homeId: 'home', managedId: 'managed' },
    }, transport })).toEqual({ kind: 'not_found' });
    expect(transport).toHaveBeenCalledWith(expect.objectContaining({ payload: { operationId: 'operation' } }));
  });
  it.each(['action.operations.get', 'action.operations.cancel'] as const)('admits %s through the existing portable Home scope owner', async actionId => {
    const transport = vi.fn(async () => actionId === 'action.operations.cancel' ? { kind: 'requested' } : { kind: 'not_found' });
    const executor = createActionExecutor({
      actionOperationAction: args => executeActionOperationActionV1({ ...args, transport }),
    } as ActionExecutorDeps);
    const context = { surface: 'ui' as const, authority: 'present_user' as const, serverId: 'local-profile',
      serverIdentityId: 'portable-home', bypassApprovals: true };
    expect(await executor.execute(actionId, { serverId: 'portable-home', machineId: 'machine', operationId: 'operation' }, context))
      .toMatchObject({ ok: true });
    expect(await executor.execute(actionId, { serverId: 'unrelated-home', machineId: 'machine', operationId: 'operation' }, context))
      .toMatchObject({ ok: false, errorCode: 'server_scope_mismatch' });
  });

  it('refuses a conflicting observation Home before dispatch or approval', async () => {
    const transport = vi.fn();
    const executor = createActionExecutor({
      actionOperationAction: args => executeActionOperationActionV1({ ...args, transport }),
    } as ActionExecutorDeps);
    expect(await executor.execute('action.operations.get', {
      serverId: 'other-home', machineId: 'machine', operationId: 'operation',
    }, { surface: 'cli', serverId: 'bound-home' }))
      .toMatchObject({ ok: false, errorCode: 'server_scope_mismatch' });
    expect(transport).not.toHaveBeenCalled();
    transport.mockResolvedValue({ error: 'Forbidden', errorCode: 'RPC_FORBIDDEN' });
    expect(await executor.execute('action.operations.get', {
      serverId: 'bound-home', machineId: 'machine', operationId: 'operation',
    }, { surface: 'cli', serverId: 'bound-home' }))
      .toMatchObject({ ok: false, errorCode: 'RPC_FORBIDDEN' });
  });
  it('requires default present-user Stop confirmation but respects the canonical waiver', () => {
    const actionId = 'action.operations.cancel' as const;
    const spec = getActionSpec(actionId);
    const context = { surface: 'ui', authority: 'present_user' } as const;
    expect(resolveActionApprovalRouting({ actionId, spec, context })).toMatchObject({ required: false, uiConfirmationRequired: true });
    const settings = setActionApprovalOverride({
      settings: normalizeActionsSettingsV1(null), actionId, surface: 'ui', approvalRequired: false,
    });
    const waived = resolveActionApprovalRouting({ actionId, spec, context, settings });
    expect(waived.required).toBe(false);
    expect(waived.uiConfirmationRequired).toBeUndefined();
  });
  it('declares exact-Home safe observation and configurable consequential cancellation', () => {
    const read = getActionSpec(ActionIdSchema.parse('projects.execution.output.read'));
    expect(read.safety).toBe('safe');
    expect(read.inputSchema.safeParse({ serverId: 'home', machineId: 'machine', operationId: 'operation', byteOffset: 0 }).success).toBe(true);
    expect(read.inputSchema.safeParse({ serverId: 'home', machineId: 'machine', operationId: 'operation', terminalId: 'forged', byteOffset: 0 }).success).toBe(false);
    expect(read.inputSchema.safeParse({ serverId: 'home', machineId: 'machine', operationId: 'operation', byteOffset: 4, ackedByteOffset: 4 }).success).toBe(true);
    const invalidCursor = read.inputSchema.safeParse({ serverId: 'home', machineId: 'machine', operationId: 'operation', byteOffset: 4, ackedByteOffset: 5 });
    expect(invalidCursor.success).toBe(false);
    if (!invalidCursor.success) expect(invalidCursor.error.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: ['ackedByteOffset'] }),
    ]));
    expect(getActionSpec(ActionIdSchema.parse('action.operations.cancel')).safety).toBe('danger');
  });

  it('refuses unsupported headless presentation and does not dispatch across an admitted Home', async () => {
    const executor = createActionExecutor({} as ActionExecutorDeps);
    expect(await executor.execute(ActionIdSchema.parse('projects.execution.output.open'), {
      serverId: 'home', machineId: 'machine', operationId: 'operation',
    }, { surface: 'agent', serverId: 'home' })).toMatchObject({ ok: false });
  });
});
