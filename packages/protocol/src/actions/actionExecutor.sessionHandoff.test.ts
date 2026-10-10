import { describe, expect, it, vi } from 'vitest';

import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';
import { computeWorkspaceSyncPolicyDigest } from '../sessions/control/handoff/workspaceSyncSchemas.js';
import { PUBLIC_ACTION_INPUT_SCHEMAS, PLUGIN_ACTION_INPUT_SCHEMAS } from './actionSpecs.js';

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
    ...overrides,
  };
}

describe('createActionExecutor (session.handoff)', () => {
  it('keeps public callers on the same no-copy policy and rejects contradictory workspace work', async () => {
    const input = { sessionId: 'session_1', targetMachineId: 'target', stateTransfer: 'existing', workspaceAction: { kind: 'none' } };
    const copying = { ...input, workspaceAction: { kind: 'copy_once', contentPolicy: {
      v: 1, selection: 'git_worktree', extraIgnorePatterns: [], extraIncludePatterns: [],
      policyDigest: computeWorkspaceSyncPolicyDigest({ v: 1, selection: 'git_worktree', extraIgnorePatterns: [], extraIncludePatterns: [] }),
    } } };
    for (const schema of [PUBLIC_ACTION_INPUT_SCHEMAS['session.handoff'], PLUGIN_ACTION_INPUT_SCHEMAS['session.handoff']]) {
      expect(schema.parse(input)).toEqual(input);
      expect(schema.safeParse(copying).success).toBe(false);
      expect(schema.safeParse({ ...input, sourceMachineId: 'forged' }).success).toBe(false);
    }
    const executor = createActionExecutor(createDeps());
    expect(await executor.execute('session.handoff', copying, { surface: 'ui', authority: 'present_user' })).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
  });

  it('carries existing-state policy through the public Action and preserves target absence', async () => {
    const sessionHandoffStart = vi.fn(async () => ({ ok: false as const, errorCode: 'existing_session_state_unavailable', error: 'Turn on session data transfer' }));
    const executor = createActionExecutor(createDeps({
      sessionHandoffStart,
      sessionHandoffTargetReplacementApprovalPreflight: vi.fn(async () => ({ type: 'not_required' as const })),
    }));
    const result = await executor.execute('session.handoff', {
      sessionId: 'session_1', targetMachineId: 'target', stateTransfer: 'existing', workspaceAction: { kind: 'none' },
    }, { surface: 'ui', authority: 'present_user' });
    expect(result).toEqual({ ok: false, errorCode: 'existing_session_state_unavailable', error: 'Turn on session data transfer' });
    expect(sessionHandoffStart).toHaveBeenCalledWith(expect.objectContaining({ stateTransfer: 'existing' }));
  });

  it('returns unsupported_action when the handoff dependency is unavailable', async () => {
    const deps = createDeps();
    const executor = createActionExecutor(deps);

    const result = await executor.execute(
      'session.handoff',
      { sessionId: 'sess_1', targetMachineId: 'machine_2' },
      { surface: 'ui', defaultSessionId: 'sess_1' },
    );

    expect(result).toEqual({
      ok: false,
      errorCode: 'unsupported_action',
      error: 'unsupported_action:session.handoff',
    });
  });

  it('delegates to sessionHandoffStart with the resolved session and server ids', async () => {
    const sessionHandoffStart = vi.fn(async () => ({ handoffId: 'handoff_1', status: { handoffId: 'handoff_1', status: 'pending', phase: 'preparing', recoveryActions: [] }, workspace: { kind: 'none' as const } }));
    const deps = createDeps({
      sessionHandoffStart,
      sessionHandoffTargetReplacementApprovalPreflight: vi.fn(async () => ({ type: 'not_required' as const })),
      resolveServerIdForSessionId: vi.fn(() => 'server_a'),
    });
    const executor = createActionExecutor(deps);

    const signal = new AbortController().signal;
    const result = await executor.execute(
      'session.handoff',
      { targetMachineId: 'machine_2' },
      { surface: 'ui', authority: 'present_user', defaultSessionId: 'sess_1', signal },
    );

    expect(result.ok).toBe(true);
    expect(sessionHandoffStart).toHaveBeenCalledWith({
      sessionId: 'sess_1',
      targetMachineId: 'machine_2',
      serverId: 'server_a',
      signal,
    });
  });

  it('rejects caller-named WorkspaceRefs and settings versions outside the canonical workspace action', async () => {
    const sessionHandoffStart = vi.fn(async () => ({ handoffId: 'handoff_1', status: { handoffId: 'handoff_1', status: 'pending', phase: 'preparing', recoveryActions: [] }, workspace: { kind: 'none' as const } }));
    const deps = createDeps({
      sessionHandoffStart,
      sessionHandoffTargetReplacementApprovalPreflight: vi.fn(async () => ({ type: 'not_required' as const })),
      resolveServerIdForSessionId: vi.fn(() => 'server_a'),
    });
    const executor = createActionExecutor(deps);

    const policyDigest = computeWorkspaceSyncPolicyDigest({
      v: 1, selection: 'git_worktree', extraIgnorePatterns: [], extraIncludePatterns: ['dist/**'],
    });
    const result = await executor.execute(
      'session.handoff',
      {
        targetMachineId: 'machine_2',
        targetPath: '/home/guest/workspace',
        targetSessionStorageMode: 'persisted',
        workspaceAction: {
          kind: 'copy_once',
          contentPolicy: {
            v: 1,
            selection: 'git_worktree',
            extraIgnorePatterns: [],
            extraIncludePatterns: ['dist/**'],
            policyDigest,
          },
        },
        // Retired daemon mechanics are not part of the strict current Action
        // envelope. Compatibility belongs only at a named predecessor seam.
        workspaceSyncSourceWorkspaceRefId: 'workspace-source',
        workspaceSyncTargetWorkspaceRefId: 'workspace-target',
        workspaceSyncSettingsVersion: 8,
      },
      { surface: 'ui', authority: 'present_user', defaultSessionId: 'sess_1', actionRequestId: 'handoff-action-copy-1' },
    );

    expect(result).toEqual({
      ok: false,
      errorCode: 'invalid_parameters',
      error: 'invalid_parameters',
    });
    expect(sessionHandoffStart).not.toHaveBeenCalled();
  });

  it('routes one non-empty target replacement approval and replays only its exact host proof', async () => {
    const contentPolicy = {
      v: 1 as const,
      selection: 'all_files' as const,
      extraIgnorePatterns: [],
      extraIncludePatterns: [],
      policyDigest: computeWorkspaceSyncPolicyDigest({
        v: 1,
        selection: 'all_files',
        extraIgnorePatterns: [],
        extraIncludePatterns: [],
      }),
    };
    const approval = {
      v: 1 as const,
      consequences: ['replace_nonempty_workspace_target'] as const,
      serverId: 'server_a',
      machineId: 'machine_2',
      canonicalRoot: '/workspace/target',
      rootFingerprint: 'a'.repeat(64),
      operationId: 'handoff-action-1',
    };
    const preflight = vi.fn(async () => ({ type: 'approval_required' as const, approval }));
    const sessionHandoffStart = vi.fn(async () => ({
      handoffId: 'handoff_1',
      status: { handoffId: 'handoff_1', status: 'completed' as const, phase: 'finalizing' as const, recoveryActions: [] },
      workspace: { kind: 'none' as const },
    }));
    let persistedApproval: Record<string, unknown> | null = null;
    const approvalsCreate = vi.fn(async ({ request }: { request: Record<string, unknown> }) => {
      persistedApproval = request;
      return { artifactId: 'handoff-target-approval-1' };
    });
    const approvalsGet = vi.fn(async () => persistedApproval);
    const approvalsUpdate = vi.fn(async ({ request }: { request: Record<string, unknown> }) => {
      persistedApproval = request;
      return { ok: true as const };
    });
    const executor = createActionExecutor(createDeps({
      sessionHandoffStart,
      sessionHandoffTargetReplacementApprovalPreflight: preflight,
      approvalsCreate,
      approvalsGet,
      approvalsUpdate,
      isApprovalExecutionOriginCurrent: vi.fn(async () => true),
      resolveServerIdForSessionId: vi.fn(() => 'server_a'),
    } as Partial<ActionExecutorDeps>));
    const actionInput = {
      sessionId: 'sess_1',
      targetMachineId: 'machine_2',
      targetPath: '/workspace/target',
      workspaceAction: { kind: 'copy_once' as const, contentPolicy },
    };

    await expect(executor.execute('session.handoff', actionInput, {
      surface: 'ui',
      authority: 'present_user',
      serverId: 'server_a',
      actionRequestId: 'handoff-action-1',
    })).resolves.toEqual({
      ok: true,
      result: {
        kind: 'approval_request_created',
        artifactId: 'handoff-target-approval-1',
        actionId: 'session.handoff',
      },
    });
    expect(sessionHandoffStart).not.toHaveBeenCalled();
    expect(persistedApproval).toMatchObject({
      actionId: 'session.handoff',
      handoffTargetReplacementApproval: approval,
    });

    const decision = await executor.execute('approval.request.decide', {
      artifactId: 'handoff-target-approval-1',
      decision: 'approve',
    }, { surface: 'ui', authority: 'present_user', serverId: 'server_a' });
    expect(decision).toMatchObject({ ok: true, result: { execution: { ok: true } } });
    expect(preflight).toHaveBeenCalledTimes(2);
    expect(sessionHandoffStart).toHaveBeenCalledWith(expect.objectContaining({
      actionRequestId: 'handoff-action-1',
      handoffTargetReplacementApproval: approval,
      handoffTargetReplacementApprovalReceiptId: 'handoff-target-approval-1',
      handoffTargetReplacementApprovalActionInput: actionInput,
    }));
    await expect(executor.execute('approval.request.decide', {
      artifactId: 'handoff-target-approval-1',
      decision: 'approve',
    }, { surface: 'ui', authority: 'present_user', serverId: 'server_a' })).resolves.toMatchObject({ ok: true });
    expect(sessionHandoffStart).toHaveBeenCalledTimes(1);
    expect(approvalsCreate).toHaveBeenCalledTimes(1);
  });

  it('routes one combined mirror-and-replacement approval and refuses a changed target on replay', async () => {
    const contentPolicy = {
      v: 1 as const,
      selection: 'all_files' as const,
      extraIgnorePatterns: [],
      extraIncludePatterns: [],
      policyDigest: computeWorkspaceSyncPolicyDigest({
        v: 1,
        selection: 'all_files',
        extraIgnorePatterns: [],
        extraIncludePatterns: [],
      }),
    };
    const approval = {
      v: 1 as const,
      consequences: [
        'replace_nonempty_workspace_target',
        'delete_target_only_files_during_exact_mirror',
      ] as const,
      serverId: 'server_a',
      machineId: 'machine_2',
      canonicalRoot: '/workspace/target',
      rootFingerprint: 'b'.repeat(64),
      operationId: 'handoff-action-mirror-1',
    };
    const refreshedApproval = { ...approval, rootFingerprint: 'c'.repeat(64) };
    let preflightCalls = 0;
    const preflight = vi.fn(async () => {
      preflightCalls += 1;
      return {
        type: 'approval_required' as const,
        approval: preflightCalls === 1 ? approval : refreshedApproval,
      };
    });
    const sessionHandoffStart = vi.fn(async () => ({ handoffId: 'handoff_1', status: { handoffId: 'handoff_1', status: 'completed' as const, phase: 'finalizing' as const, recoveryActions: [] } }));
    let persistedApproval: Record<string, unknown> | null = null;
    const approvalsCreate = vi.fn(async ({ request }: { request: Record<string, unknown> }) => {
      persistedApproval = request;
      return { artifactId: 'handoff-target-approval-mirror-1' };
    });
    const approvalsGet = vi.fn(async () => persistedApproval);
    const approvalsUpdate = vi.fn(async ({ request }: { request: Record<string, unknown> }) => {
      persistedApproval = request;
      return { ok: true as const };
    });
    const executor = createActionExecutor(createDeps({
      sessionHandoffStart,
      sessionHandoffTargetReplacementApprovalPreflight: preflight,
      approvalsCreate,
      approvalsGet,
      approvalsUpdate,
      isApprovalExecutionOriginCurrent: vi.fn(async () => true),
      resolveServerIdForSessionId: vi.fn(() => 'server_a'),
    } as Partial<ActionExecutorDeps>));

    await expect(executor.execute('session.handoff', {
      sessionId: 'sess_1',
      targetMachineId: 'machine_2',
      targetPath: '/workspace/target',
      workspaceAction: {
        kind: 'create_relationship' as const,
        mode: 'mirror_exactly' as const,
        contentPolicy,
        flushBeforeCommit: true as const,
      },
    }, {
      surface: 'ui',
      authority: 'present_user',
      serverId: 'server_a',
      actionRequestId: 'handoff-action-mirror-1',
    })).resolves.toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
    expect(persistedApproval).toMatchObject({ handoffTargetReplacementApproval: approval });
    expect(approvalsCreate).toHaveBeenCalledTimes(1);

    const decided = await executor.execute('approval.request.decide', {
      artifactId: 'handoff-target-approval-mirror-1',
      decision: 'approve',
    }, { surface: 'ui', authority: 'present_user' });

    expect(decided).toMatchObject({ ok: true, result: { execution: { ok: false, errorCode: 'approval_stale' } } });
    expect(sessionHandoffStart).not.toHaveBeenCalled();
    expect(approvalsCreate).toHaveBeenCalledTimes(1);
  });

  it('passes the canonical workspaceAction through to sessionHandoffStart', async () => {
    const sessionHandoffStart = vi.fn(async () => ({ handoffId: 'handoff_1', status: { handoffId: 'handoff_1', status: 'pending', phase: 'preparing', recoveryActions: [] }, workspace: { kind: 'none' as const } }));
    const deps = createDeps({
      sessionHandoffStart,
      resolveServerIdForSessionId: vi.fn(() => 'server_a'),
    });
    const executor = createActionExecutor(deps);
    const workspaceAction = {
      kind: 'relationship' as const,
      relationshipId: 'relationship_1',
      flushBeforeCommit: true,
    };

    const result = await executor.execute(
      'session.handoff',
      {
        targetMachineId: 'machine_2',
        workspaceAction,
      },
      { surface: 'ui', authority: 'present_user', defaultSessionId: 'sess_1' },
    );

    expect(result.ok).toBe(true);
    expect(sessionHandoffStart).toHaveBeenCalledWith({
      sessionId: 'sess_1',
      targetMachineId: 'machine_2',
      workspaceAction,
      serverId: 'server_a',
    });
  });

  it('fails when the target machine id is missing', async () => {
    const deps = createDeps({
      sessionHandoffStart: vi.fn(async () => ({ handoffId: 'handoff_1', status: { handoffId: 'handoff_1', status: 'completed' as const, phase: 'finalizing' as const, recoveryActions: [] } })),
    });
    const executor = createActionExecutor(deps);

    const result = await executor.execute(
      'session.handoff',
      { sessionId: 'sess_1' },
      { surface: 'ui', defaultSessionId: 'sess_1' },
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
