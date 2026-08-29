import { describe, expect, it, vi } from 'vitest';

import type { ActionId } from './actionIds.js';
import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';

function createDeps(overrides: Partial<ActionExecutorDeps> = {}): ActionExecutorDeps {
  return {
    executionRunStart: vi.fn(async () => ({})),
    executionRunList: vi.fn(async () => ({})),
    executionRunGet: vi.fn(async () => ({})),
    executionRunSend: vi.fn(async () => ({})),
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
    ...overrides,
  };
}

describe('createActionExecutor (runtime-unification actions)', () => {
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

  it('requires present-user authority before delegating browser automation cancellation', async () => {
    const runtimeActionExecute = vi.fn(async () => ({ v: 1, outcome: 'canceled' as const, canceledCount: 1 }));
    const executor = createActionExecutor(createDeps({ runtimeActionExecute }));

    const result = await executor.execute('browser.automation.cancelActive', {
      browserSessionId: 'browser_session_1',
      viewId: 'view_1',
    }, {
      surface: 'api',
      authority: 'account_automation',
      actionCaller: { kind: 'host' },
    });

    expect(result).toEqual({
      ok: false,
      errorCode: 'present_user_required',
      error: 'present_user_required',
    });
    expect(runtimeActionExecute).not.toHaveBeenCalled();
  });

  it('fails closed when a caller omits host-stamped authority', async () => {
    const runtimeActionExecute = vi.fn(async () => ({ v: 1, outcome: 'canceled' as const, canceledCount: 1 }));
    const executor = createActionExecutor(createDeps({ runtimeActionExecute }));

    const result = await executor.execute('browser.automation.cancelActive', {
      browserSessionId: 'browser_session_1',
      viewId: 'view_1',
    }, { surface: 'ui' });

    expect(result).toEqual({
      ok: false,
      errorCode: 'present_user_required',
      error: 'present_user_required',
    });
    expect(runtimeActionExecute).not.toHaveBeenCalled();
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
      result: { run: { runId: 'run-1', status: 'succeeded' as const } },
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
