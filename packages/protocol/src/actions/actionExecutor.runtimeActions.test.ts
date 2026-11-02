import { describe, expect, it, vi } from 'vitest';

import type { ActionId } from './actionIds.js';
import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';
import { ApprovalRequestV2Schema } from '../approvals/approvalRequestV1.js';
import { isApprovalRequiredByActionsSettings } from './actionApprovalPolicy.js';
import { ActionsSettingsV1Schema } from './actionSettings.js';

function createDeps(overrides: Partial<ActionExecutorDeps> = {}): ActionExecutorDeps {
  return {
    executionRunStart: vi.fn(async () => ({})),
    executionRunList: vi.fn(async () => ({})),
    executionRunGet: vi.fn(async () => ({})),
    detachedExecutionRunSend: vi.fn(async () => ({})),
    executionRunStop: vi.fn(async () => ({})),
    executionRunAction: vi.fn(async () => ({})),
    executionRunWait: vi.fn(async () => ({})),
    sessionOpen: vi.fn(async () => ({})),
    sessionFork: vi.fn(async () => ({})),
    sessionRollback: vi.fn(async () => ({})),
    sessionSpawnNew: vi.fn(async () => ({})),
    pathsListRecent: vi.fn(async () => ({ items: [] })),
    machinesList: vi.fn(async () => ({ items: [] })),
    serversList: vi.fn(async () => ({ items: [] })),
    reviewEnginesList: vi.fn(async () => ({ items: [] })),
    agentsBackendsList: vi.fn(async () => ({ items: [] })),
    agentsModelsList: vi.fn(async () => ({ items: [] })),
    sessionSendMessage: vi.fn(async () => ({})),
    sessionPermissionRespond: vi.fn(async () => ({})),
    sessionUserActionAnswer: vi.fn(async () => ({})),
    sessionModeSet: vi.fn(async () => ({})),
    sessionModesList: vi.fn(async () => ({ items: [] })),
    sessionTargetPrimarySet: vi.fn(async () => ({})),
    sessionTargetTrackedSet: vi.fn(async () => ({})),
    sessionList: vi.fn(async () => ({})),
    sessionActivityGet: vi.fn(async () => ({})),
    sessionRecentMessagesGet: vi.fn(async () => ({})),
    resetGlobalVoiceAgent: vi.fn(),
    // Runtime routing is tested independently from approval policy here.
    isActionApprovalRequired: () => false,
    ...overrides,
  };
}

describe('createActionExecutor (runtime-unification actions)', () => {
  it('retains an exchange occurrence revision instead of preparing a fresh grant on replay', async () => {
    let currentRevision = 'session-message-row-revision:v1:0';
    const prepare = vi.fn(async () => currentRevision);
    const control = vi.fn(async ({ request }: Parameters<NonNullable<ActionExecutorDeps['sessionExchangeControl']>>[0]) => {
      if (request.observedRevision !== currentRevision) return { ok: false, errorCode: 'exchange_revision_conflict' };
      currentRevision = 'session-message-row-revision:v1:1';
      return { state: { v: 1, observedStarts: 5, pauseAtStarts: 10, stopped: false, afterTurns: 5 },
        observedRevision: currentRevision };
    });
    const executor = createActionExecutor(createDeps({ sessionExchangePrepare: prepare,
      sessionExchangeControl: control }));
    const input = { sessionId: 'session-1', originInputLocalId: 'root-1', decision: 'continue' };
    const context = { surface: 'ui', authority: 'present_user', bypassApprovals: true } as const;
    expect(await executor.execute('session.exchange.control', input, context)).toMatchObject({ ok: true });
    expect(prepare).toHaveBeenCalledTimes(1);
    currentRevision = 'session-message-row-revision:v1:3'; // Later starts and a different control advanced the root.
    expect(await executor.execute('session.exchange.control', { ...input,
      observedRevision: 'session-message-row-revision:v1:0' }, context)).toMatchObject({ ok: false });
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(control).toHaveBeenCalledTimes(2);
    expect(control.mock.calls.at(-1)?.[0].request.observedRevision).toBe('session-message-row-revision:v1:0');
  });
  it('opens Browser views directly for their user, while honoring Ask and Agent defaults', async () => {
    const target = { kind: 'localServicePreview', targetId: 'preview_1', machineId: 'machine_1' } as const;
    const output = { v: 1, commandId: 'open_1', status: 'dispatched', adapterKind: 'localPreview', events: [] } as const;
    for (const row of [
      { id: 'browser.workspace.open', input: { scopeId: 'workspace_1', commandId: 'open_1', target },
        output: { ...output, outcome: 'workspaceTab' } },
      { id: 'browser.view.open', input: { commandId: 'open_1', browserSessionId: 'browser_1', viewId: 'view_1',
        kind: 'openView', target, platform: 'web' }, output },
    ] as const) {
      const effects: unknown[] = [];
      // Only the client/runtime effect is a boundary; declaration and policy stay real.
      const executor = createActionExecutor(createDeps({
        isActionApprovalRequired: undefined,
        runtimeActionExecute: async args => { effects.push(args); return row.output; },
      }));
      const context = { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } } as const;
      expect(await executor.execute(row.id, row.input, context), row.id).toEqual({ ok: true, result: row.output });
      expect(effects.splice(0)).toHaveLength(1);
      const actionsSettings = ActionsSettingsV1Schema.parse({ v: 1, actions: {
        [row.id]: { approvalRequiredSurfaces: ['ui'] },
      } });
      expect(await executor.execute(row.id, row.input, { ...context, actionsSettings }))
        .toMatchObject({ ok: false, errorCode: 'approvals_not_supported' });
      expect(await executor.execute(row.id, row.input, { surface: 'agent', authority: 'account_automation' }))
        .toMatchObject({ ok: false, errorCode: 'approvals_not_supported' });
      expect(effects).toEqual([]);
    }
  });

  it('preserves the approval bypass but returns the picker requirement without selecting a target', async () => {
    const runtimeActionExecute = vi.fn(async () => ({ consentGranted: false,
      approvalDisplay: { machineDisplayName: 'Workstation', requiresTargetSelection: true } }));
    const approvalsCreate = vi.fn(async () => ({ artifactId: 'must-not-create' }));
    const executor = createActionExecutor(createDeps({ runtimeActionExecute, approvalsCreate }));
    expect(await executor.execute('computer.capture', { machineId: 'native-machine' }, {
      surface: 'agent', authority: 'account_automation', defaultSessionId: 'session', bypassApprovals: true,
    })).toMatchObject({ ok: true, result: { status: 'target_selection_required',
      approvalDisplay: { requiresTargetSelection: true } } });
    expect(approvalsCreate).not.toHaveBeenCalled();
  });
  it('preserves the existing bypass for a selected target without prior computer consent', async () => {
    const target = { kind: 'window', displayId: ':77', pid: 123, windowId: 456 } as const;
    const runtimeActionExecute = vi.fn<NonNullable<ActionExecutorDeps['runtimeActionExecute']>>(async ({ actionId }) =>
      actionId === 'computer.target.get' ? { consentGranted: false, selectedTarget: target, sourceId: 'source_1',
        approvalDisplay: { machineDisplayName: 'Workstation', requiresTargetSelection: false,
          target: { kind: 'window', title: 'Editor' } } }
        : { status: 'dispatched', target, sourceId: 'source_1' });
    const approvalsCreate = vi.fn(async () => ({ artifactId: 'must-not-create' }));
    const settings = ActionsSettingsV1Schema.parse({ v: 1 });
    const executor = createActionExecutor(createDeps({ runtimeActionExecute, approvalsCreate,
      isActionApprovalRequired: (actionId, context) => isApprovalRequiredByActionsSettings(actionId, settings, context) }));
    expect(await executor.execute('computer.input', {
      machineId: 'machine_1', captureId: 'capture_1', operation: { kind: 'press', key: 'Return' },
    }, { surface: 'agent', authority: 'account_automation', defaultSessionId: 'session_1', bypassApprovals: true }))
      .toMatchObject({ ok: true, result: { status: 'dispatched', target } });
    expect(approvalsCreate).not.toHaveBeenCalled();
  });
  it('binds native capture approval to the explicitly selected machine before any capture effect', async () => {
    // This fixture represents the machine IPC boundary, not the computer owner's logic.
    const runtimeActionExecute = vi.fn(async () => ({ consentGranted: false,
      approvalDisplay: { machineDisplayName: 'Workstation', requiresTargetSelection: true } }));
    const approvalsCreate = vi.fn(async (_args: Parameters<NonNullable<ActionExecutorDeps['approvalsCreate']>>[0]) => ({ artifactId: 'native-capture-approval' }));
    const settings = ActionsSettingsV1Schema.parse({ v: 1 });
    const executor = createActionExecutor(createDeps({
      runtimeActionExecute,
      approvalsCreate,
      approvalsWaitForDecision: async ({ request }) => ({
        decision: 'reject',
        request: { ...request, status: 'rejected', decision: { kind: 'reject', decidedAtMs: 2 } },
      }),
      approvalsUpdate: async () => ({ ok: true }),
      isActionApprovalRequired: (actionId, context) => isApprovalRequiredByActionsSettings(actionId, settings, context),
    }));
    const result = await executor.execute('computer.capture', { machineId: 'native-machine' }, {
      surface: 'agent', authority: 'account_automation', serverId: 'home-1',
      defaultSessionId: 'agent-session', defaultSessionMachineId: 'agent-machine',
      actionRequestId: 'native-capture-request',
    });

    expect(result).toEqual({ ok: false, errorCode: 'approval_rejected', error: 'approval_rejected' });
    expect(ApprovalRequestV2Schema.parse(approvalsCreate.mock.calls[0]?.[0].request)).toMatchObject({
      actionArgs: { machineId: 'native-machine' },
      preview: { computerApprovalDisplay: { machineDisplayName: 'Workstation', requiresTargetSelection: true } },
      executionOriginV1: { machineId: 'native-machine', sessionId: 'agent-session' },
    });
    expect(runtimeActionExecute.mock.calls).toHaveLength(1);
  });

  it('dispatches native input and policy-admitted interruption without substituting human authority', async () => {
    const target = { kind: 'window', displayId: ':77', pid: 123, windowId: 456 } as const;
    const runtimeActionExecute = vi.fn<NonNullable<ActionExecutorDeps['runtimeActionExecute']>>(async ({ actionId }) => actionId === 'computer.target.get'
      ? { consentGranted: true, selectedTarget: target, sourceId: 'source_1', provider: 'agent-desktop',
        approvalDisplay: { machineDisplayName: 'Workstation', requiresTargetSelection: false, target: { kind: 'window', title: 'Editor' } } }
      : { status: 'dispatched' as const, target, sourceId: 'source_1' });
    const executor = createActionExecutor(createDeps({ runtimeActionExecute }));
    const input = { machineId: 'machine_1', target, provider: 'agent-desktop', captureId: 'capture_1',
      operation: { kind: 'element', elementId: 'element_1', action: 'set_value', value: 'hello' } };
    const result = await executor.execute('computer.input', input,
      { surface: 'agent', authority: 'account_automation', defaultSessionId: 'session_1' });
    expect(result).toEqual({ ok: true, result: { status: 'dispatched', target, sourceId: 'source_1' } });
    expect(runtimeActionExecute).toHaveBeenCalledWith(expect.objectContaining({ actionId: 'computer.target.get',
      input: { machineId: 'machine_1', provider: 'agent-desktop' } }));
    expect(runtimeActionExecute).toHaveBeenCalledWith({ actionId: 'computer.input', input: { ...input, sourceId: 'source_1' },
      context: { surface: 'agent', authority: 'account_automation', defaultSessionId: 'session_1', bypassApprovals: true } });
    const { provider: _provider, ...defaultInput } = input;
    await executor.execute('computer.input', defaultInput,
      { surface: 'agent', authority: 'account_automation', defaultSessionId: 'session_1' });
    expect(runtimeActionExecute).toHaveBeenLastCalledWith(expect.objectContaining({ actionId: 'computer.input',
      input: { ...input, sourceId: 'source_1' } }));
    const admitted = await executor.execute('computer.control.interrupt', { machineId: 'machine_1', target },
      { surface: 'ui', authority: 'account_automation' });
    expect(admitted).toEqual({ ok: true, result: { status: 'dispatched', target, sourceId: 'source_1' } });
    const interrupted = await executor.execute('computer.control.interrupt', { machineId: 'machine_1', target },
      { surface: 'ui', authority: 'present_user' });
    expect(interrupted).toEqual({ ok: true, result: { status: 'dispatched', target, sourceId: 'source_1' } });
  });

  it.each(['source', 'target'] as const)('refuses an element from a replaced %s before native input', async changed => {
    const target = { kind: 'window', displayId: ':77', pid: 123, windowId: 456 } as const;
    const runtimeActionExecute = vi.fn<NonNullable<ActionExecutorDeps['runtimeActionExecute']>>(async () => ({
      consentGranted: true, selectedTarget: changed === 'target' ? { ...target, windowId: 789 } : target,
      sourceId: changed === 'source' ? 'replacement' : 'old_source', provider: 'agent-desktop',
      approvalDisplay: { machineDisplayName: 'Workstation', requiresTargetSelection: false },
    }));
    const executor = createActionExecutor(createDeps({ runtimeActionExecute }));
    const result = await executor.execute('computer.input', { machineId: 'machine_1', provider: 'agent-desktop', target,
      sourceId: 'old_source', captureId: 'capture_1', operation: { kind: 'element', elementId: 'element_1', action: 'click' } },
    { surface: 'agent', authority: 'account_automation', defaultSessionId: 'session_1' });
    expect(result).toMatchObject({ ok: false, errorCode: 'computer_element_stale' });
    expect(runtimeActionExecute.mock.calls.map(([call]) => call.actionId)).toEqual(['computer.target.get']);
  });

  it('returns unsupported_action until the runtime action executor is wired', async () => {
    const executor = createActionExecutor(createDeps());

    const result = await executor.execute(
      'browser.navigate',
      {
        commandId: 'cmd_1',
        kind: 'navigate',
        browserSessionId: 'browser_session_1',
        viewId: 'view_1',
        url: 'https://example.com',
      },
      { surface: 'ui' },
    );

    expect(result).toEqual({
      ok: false,
      errorCode: 'unsupported_action',
      error: 'unsupported_action:browser.navigate',
    });
  });

  it('delegates validated runtime actions to the canonical runtime action executor', async () => {
    const runtimeOutput = {
      v: 1,
      commandId: 'cmd_1',
      status: 'dispatched',
      adapterKind: 'localPreview',
      events: [],
    } as const;
    const runtimeActionExecute = vi.fn(async () => runtimeOutput);
    const executor = createActionExecutor(createDeps({ runtimeActionExecute }));

    const input = {
      commandId: 'cmd_1',
      kind: 'navigate',
      browserSessionId: 'browser_session_1',
      viewId: 'view_1',
      url: 'https://example.com',
    };
    const result = await executor.execute('browser.navigate', input, { serverId: 'server_1', surface: 'ui' });

    expect(result).toEqual({ ok: true, result: runtimeOutput });
    expect(runtimeActionExecute).toHaveBeenCalledWith({
      actionId: 'browser.navigate',
      input,
      context: { serverId: 'server_1', surface: 'ui' },
    });
  });

  it('asks before browser cancellation and native target close unless the user waived that surface', async () => {
    const rows = [
      { id: 'browser.automation.cancelActive', input: { browserSessionId: 'browser_session_1', viewId: 'view_1' },
        output: { v: 1, outcome: 'canceled', canceledCount: 1, completion: 'stopped' } },
      { id: 'computer.target.close', input: { machineId: 'machine_1' }, output: { status: 'dispatched',
        target: { kind: 'window', displayId: ':77', pid: 123, windowId: 456 }, sourceId: 'source_1' } },
    ] as const;
    for (const row of rows) {
      const effects: unknown[] = [];
      // The machine runtime is the external boundary; policy and admission remain real.
      const executor = createActionExecutor(createDeps({
        runtimeActionExecute: async args => { effects.push(args); return row.output; },
        isActionApprovalRequired: (id, context) => isApprovalRequiredByActionsSettings(id,
          context.actionsSettings ?? ActionsSettingsV1Schema.parse({ v: 1 }), context),
      }));
      for (const surface of ['agent', 'mcp'] as const) {
        const context = { surface, authority: 'account_automation', defaultSessionId: 'session_1', actionCaller: { kind: 'host' } } as const;
        expect(await executor.execute(row.id, row.input, context)).toMatchObject({ ok: false, errorCode: 'approvals_not_supported' });
        expect(effects).toEqual([]);
        const actionsSettings = ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: { [row.id]: [surface] } });
        expect(await executor.execute(row.id, row.input, { ...context, actionsSettings })).toEqual({ ok: true, result: row.output });
        expect(effects.pop()).toMatchObject({ actionId: row.id, input: row.input, context: { authority: 'account_automation' } });
      }
    }
  });

  it('fails closed when a runtime action producer returns output outside its declared schema', async () => {
    const runtimeActionExecute = vi.fn(async () => ({ navigated: true }));
    const executor = createActionExecutor(createDeps({ runtimeActionExecute }));

    const result = await executor.execute('browser.navigate', {
      commandId: 'cmd_1',
      kind: 'navigate',
      browserSessionId: 'browser_session_1',
      viewId: 'view_1',
      url: 'https://example.com',
    }, { surface: 'ui' });

    expect(result).toEqual({
      ok: false,
      errorCode: 'invalid_action_output',
      error: 'invalid_action_output',
    });
  });

  it('validates public action-specific payloads before runtime delegation', async () => {
    const runtimeActionExecute = vi.fn(async () => ({ ok: true }));
    const executor = createActionExecutor(createDeps({ runtimeActionExecute }));

    const result = await executor.execute('browser.navigate', {
      commandId: 'cmd_1',
      kind: 'reload',
      browserSessionId: 'browser_session_1',
      viewId: 'view_1',
    }, { surface: 'ui' });

    expect(result).toEqual({
      ok: false,
      errorCode: 'invalid_parameters',
      error: 'invalid_parameters',
      details: { issues: [
        { path: ['kind'], code: 'invalid_value', acceptedValues: ['navigate'] },
        { path: ['url'], code: 'invalid_type', expected: 'string' },
      ] },
    });
    expect(runtimeActionExecute).not.toHaveBeenCalled();
  });

  it('keeps no-real-executor runtime actions fail-closed on public surfaces', async () => {
    // `devices.simulator.input.orientation` is statically-unbacked (no producer in stock scrcpy —
    // rotate is relative), so it is UNSURFACED on every surface. The enablement gate must
    // short-circuit before the runtime executor. (The browser-diagnostics interaction verbs are now
    // executor-backed via the live sidecar CDP interaction transport, so they are no longer the
    // canonical fail-closed example.)
    const runtimeActionExecute = vi.fn(async () => ({ ok: true }));
    const executor = createActionExecutor(createDeps({ runtimeActionExecute }));

    const result = await executor.execute(
      'devices.simulator.input.orientation',
      {
        type: 'simulator.input.orientation',
        orientation: 'landscapeLeft',
      },
      { surface: 'ui' },
    );

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      errorCode: 'action_disabled',
      error: 'action_disabled',
      details: expect.objectContaining({
        actionId: 'devices.simulator.input.orientation',
        surface: 'ui',
        reason: 'unsupported_surface',
      }),
    }));
    expect(runtimeActionExecute).not.toHaveBeenCalled();
  });

  it('enables real-executor runtime families on the user-initiated ui surface (§3.2 flip)', async () => {
    const runtimeOutput = {
      v: 1,
      commandId: 'cmd_1',
      status: 'dispatched',
      adapterKind: 'localPreview',
      events: [],
    } as const;
    const runtimeActionExecute = vi.fn(async () => runtimeOutput);
    const executor = createActionExecutor(createDeps({ runtimeActionExecute }));

    const result = await executor.execute(
      'browser.navigate',
      {
        commandId: 'cmd_1',
        kind: 'navigate',
        browserSessionId: 'browser_session_1',
        viewId: 'view_1',
        url: 'https://example.com',
      },
      { surface: 'ui' },
    );

    expect(result).toEqual({ ok: true, result: runtimeOutput });
    expect(runtimeActionExecute).toHaveBeenCalledTimes(1);
  });

  it('rejects raw daemon transport ids before runtime action delegation', async () => {
    const runtimeActionExecute = vi.fn(async () => ({ ok: true }));
    const executor = createActionExecutor(createDeps({ runtimeActionExecute }));

    await expect(
      executor.execute('daemon.browser.recording.start' as ActionId, {}, undefined),
    ).rejects.toThrow('Unknown action spec: daemon.browser.recording.start');
    expect(runtimeActionExecute).not.toHaveBeenCalled();
  });

  it('re-enters the public Action boundary for an SCM-owned execution run', async () => {
    const executionRunStart = vi.fn(async () => ({
      runId: 'run-1',
      callId: 'call-1',
      sidechainId: 'sidechain-1',
    }));
    const executionRunWait = vi.fn(async () => ({
      ok: true as const,
      status: 'succeeded' as const,
      result: {
        run: {
          runId: 'run-1',
          callId: 'call-1',
          sidechainId: 'sidechain-1',
          intent: 'task' as const,
          backendTarget: { kind: 'builtInAgent' as const, agentId: 'codex' },
          permissionMode: 'read_only',
          retentionPolicy: 'ephemeral' as const,
          runClass: 'bounded' as const,
          ioMode: 'request_response' as const,
          status: 'succeeded' as const,
          startedAtMs: 1,
          finishedAtMs: 2,
        },
      },
    }));
    const interceptActionExecution = vi.fn(async ({ input }: Readonly<{ input: unknown }>) => ({
      status: 'continue' as const,
      input,
    }));
    const scmActionExecute: NonNullable<ActionExecutorDeps['scmActionExecute']> = vi.fn(async (args) => {
      const started = await args.executeCanonicalAction('execution.run.start', {
        intent: 'task',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        instructions: 'Summarize the current worktree.',
        permissionMode: 'read_only',
        retentionPolicy: 'ephemeral',
        runClass: 'bounded',
        ioMode: 'request_response',
        waitForCompletion: true,
      });
      expect(started).toMatchObject({
        ok: true,
        result: {
          runId: 'run-1',
          wait: { ok: true, status: 'succeeded' },
        },
      });
      return {
        success: false,
        error: 'test result',
        errorCode: 'SUMMARY_FAILED',
        sourceKey: 'workingTree:/workspace',
      };
    });
    const executor = createActionExecutor(createDeps({
      executionRunStart,
      executionRunWait,
      executionRunCheckProtocolV2: async () => ({ ok: true }),
      interceptActionExecution,
      scmActionExecute,
    }));

    const result = await executor.execute('scm.diffSummary.generate', {
      cwd: '/workspace',
      source: { kind: 'workingTree' },
    }, {
      surface: 'rpc',
      defaultSessionId: 'session-1',
    });
    expect(result).toMatchObject({
      ok: true,
      result: { errorCode: 'SUMMARY_FAILED' },
    });
    expect(executionRunStart).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ intent: 'task' }),
      undefined,
    );
    expect(executionRunWait).toHaveBeenCalledWith(
      'session-1',
      { runId: 'run-1' },
      undefined,
    );
    expect(interceptActionExecution.mock.calls.map(([request]) => request.actionId)).toEqual([
      'scm.diffSummary.generate',
      'execution.run.start',
    ]);
  });
});
