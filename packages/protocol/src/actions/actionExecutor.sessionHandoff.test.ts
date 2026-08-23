import { describe, expect, it, vi } from 'vitest';

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

describe('createActionExecutor (session.handoff)', () => {
  it('returns unsupported_action when the handoff dependency is unavailable', async () => {
    const deps = createDeps();
    const executor = createActionExecutor(deps);

    const result = await executor.execute(
      'session.handoff',
      { sessionId: 'sess_1', targetMachineId: 'machine_2' },
      { defaultSessionId: 'sess_1' },
    );

    expect(result).toEqual({
      ok: false,
      errorCode: 'unsupported_action',
      error: 'unsupported_action:session.handoff',
    });
  });

  it('delegates to sessionHandoffStart with the resolved session and server ids', async () => {
    const sessionHandoffStart = vi.fn(async () => ({ handoffId: 'handoff_1', status: { handoffId: 'handoff_1', status: 'pending', phase: 'preparing', recoveryActions: [] } }));
    const deps = createDeps({
      sessionHandoffStart,
      resolveServerIdForSessionId: vi.fn(() => 'server_a'),
    });
    const executor = createActionExecutor(deps);

    const signal = new AbortController().signal;
    const result = await executor.execute(
      'session.handoff',
      { targetMachineId: 'machine_2' },
      { defaultSessionId: 'sess_1', signal },
    );

    expect(result.ok).toBe(true);
    expect(sessionHandoffStart).toHaveBeenCalledWith({
      sessionId: 'sess_1',
      targetMachineId: 'machine_2',
      serverId: 'server_a',
      signal,
    });
  });

  it('passes workspace transfer and target storage mode through to sessionHandoffStart', async () => {
    const sessionHandoffStart = vi.fn(async () => ({ handoffId: 'handoff_1', status: { handoffId: 'handoff_1', status: 'pending', phase: 'preparing', recoveryActions: [] } }));
    const deps = createDeps({
      sessionHandoffStart,
      resolveServerIdForSessionId: vi.fn(() => 'server_a'),
    });
    const executor = createActionExecutor(deps);

    const result = await executor.execute(
      'session.handoff',
      {
        targetMachineId: 'machine_2',
        targetSessionStorageMode: 'persisted',
        workspaceTransfer: {
          enabled: true,
          conflictPolicy: 'replace_existing',
          includeIgnoredMode: 'include_selected',
          ignoredIncludeGlobs: ['dist/**'],
        },
      },
      { defaultSessionId: 'sess_1' },
    );

    expect(result.ok).toBe(true);
    expect(sessionHandoffStart).toHaveBeenCalledWith({
      sessionId: 'sess_1',
      targetMachineId: 'machine_2',
      targetSessionStorageMode: 'persisted',
      workspaceTransfer: {
        enabled: true,
        strategy: 'transfer_snapshot',
        conflictPolicy: 'replace_existing',
        includeIgnoredMode: 'include_selected',
        ignoredIncludeGlobs: ['dist/**'],
      },
      serverId: 'server_a',
    });
  });

  it('fails when the target machine id is missing', async () => {
    const deps = createDeps({
      sessionHandoffStart: vi.fn(async () => ({ handoffId: 'handoff_1' })),
    });
    const executor = createActionExecutor(deps);

    const result = await executor.execute(
      'session.handoff',
      { sessionId: 'sess_1' },
      { defaultSessionId: 'sess_1' },
    );

    expect(result).toEqual({
      ok: false,
      errorCode: 'invalid_parameters',
      error: 'invalid_parameters',
    });
  });

  it('delegates session.handoff.prepare_target to the prepare-target dependency', async () => {
    const sessionHandoffPrepareTarget = vi.fn(async () => ({ handoffId: 'handoff_1', status: 'prepared' }));
    const deps = createDeps({
      sessionHandoffPrepareTarget,
    });
    const executor = createActionExecutor(deps);
    const input = {
      handoffId: 'handoff_1',
      sourceMachineId: 'machine_1',
      targetMachineId: 'machine_2',
      negotiatedTransportStrategy: 'server_routed_stream',
      sourceSessionStorageMode: 'persisted',
      targetPath: '/tmp/project',
    };

    const result = await executor.execute('session.handoff.prepare_target', input, { surface: 'rpc' });

    expect(result).toEqual({ ok: true, result: { handoffId: 'handoff_1', status: 'prepared' } });
    expect(sessionHandoffPrepareTarget).toHaveBeenCalledWith({
      ...input,
      endpointCandidates: [],
    });
  });

  it('delegates session.handoff.prepare_target_result.get to the prepare-target-result dependency', async () => {
    const prepareTargetResult = {
      handoffId: 'handoff_1',
      status: {
        handoffId: 'handoff_1',
        status: 'ready_for_cutover',
        phase: 'staging_target',
        recoveryActions: [],
      },
      remoteSessionId: 'remote_session_1',
      directSource: {
        kind: 'ohMyPiAgentDir',
        agentDir: '/tmp/ohmypi',
      },
      resume: {
        directory: '/repo',
        agent: 'pi',
        resume: 'resume-token',
        transcriptStorage: 'persisted',
        approvedNewDirectoryCreation: true,
      },
    } as const;
    const sessionHandoffPrepareTargetResultGet = vi.fn(async () => prepareTargetResult);
    const deps = createDeps({
      sessionHandoffPrepareTargetResultGet,
    });
    const executor = createActionExecutor(deps);

    const result = await executor.execute(
      'session.handoff.prepare_target_result.get' as any,
      { handoffId: 'handoff_1' },
      { surface: 'rpc' },
    );

    expect(result).toEqual({ ok: true, result: prepareTargetResult });
    expect(sessionHandoffPrepareTargetResultGet).toHaveBeenCalledWith({ handoffId: 'handoff_1' });
  });

  it('delegates session.handoff.commit to the commit dependency', async () => {
    const sessionHandoffCommit = vi.fn(async () => ({ handoffId: 'handoff_1', status: 'completed' }));
    const deps = createDeps({
      sessionHandoffCommit,
    });
    const executor = createActionExecutor(deps);

    const result = await executor.execute(
      'session.handoff.commit',
      { handoffId: 'handoff_1', mode: 'target' },
      { surface: 'rpc' },
    );

    expect(result).toEqual({ ok: true, result: { handoffId: 'handoff_1', status: 'completed' } });
    expect(sessionHandoffCommit).toHaveBeenCalledWith({ handoffId: 'handoff_1', mode: 'target' });
  });

  it('delegates session.handoff.abort to the abort dependency', async () => {
    const sessionHandoffAbort = vi.fn(async () => ({ handoffId: 'handoff_1', status: 'aborted' }));
    const deps = createDeps({
      sessionHandoffAbort,
    });
    const executor = createActionExecutor(deps);

    const result = await executor.execute(
      'session.handoff.abort',
      { handoffId: 'handoff_1', reason: 'user_requested' },
      { surface: 'rpc' },
    );

    expect(result).toEqual({ ok: true, result: { handoffId: 'handoff_1', status: 'aborted' } });
    expect(sessionHandoffAbort).toHaveBeenCalledWith({ handoffId: 'handoff_1', reason: 'user_requested' });
  });

  it('delegates session.handoff.status.get to the status dependency', async () => {
    const sessionHandoffStatusGet = vi.fn(async () => ({ handoffId: 'handoff_1', status: 'pending' }));
    const deps = createDeps({
      sessionHandoffStatusGet,
    });
    const executor = createActionExecutor(deps);

    const result = await executor.execute(
      'session.handoff.status.get',
      { handoffId: 'handoff_1' },
      { surface: 'rpc' },
    );

    expect(result).toEqual({ ok: true, result: { handoffId: 'handoff_1', status: 'pending' } });
    expect(sessionHandoffStatusGet).toHaveBeenCalledWith({ handoffId: 'handoff_1' });
  });
});
