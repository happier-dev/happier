import { describe, expect, it, vi } from 'vitest';

import { coordinateTrackedSessionHandoff } from './sessionHandoffCoordinator';
import { computeWorkspaceSyncPolicyDigest } from '@/workspaces/sync/workspaceSyncTypes';
import { createWorkspaceSyncHandoffAdapter } from '@/workspaces/sync/workspaceSyncHandoffAdapter';

const allFilesPolicyInput = {
  v: 1 as const,
  selection: 'all_files' as const,
  extraIgnorePatterns: [],
  extraIncludePatterns: [],
};
const allFilesContentPolicy = {
  ...allFilesPolicyInput,
  policyDigest: computeWorkspaceSyncPolicyDigest(allFilesPolicyInput),
};

const status = (phase: 'preparing' | 'staging_target' | 'finalizing', state: 'in_progress' | 'ready_for_cutover' | 'completed' = 'in_progress') => ({
  handoffId: 'handoff-1',
  status: state,
  phase,
  transportStrategy: 'server_routed_stream',
  recoveryActions: [],
});

const started = {
  handoffId: 'handoff-1',
  status: status('preparing'),
  endpointCandidates: [],
  targetPath: '/repo',
};

const prepared = {
  handoffId: 'handoff-1',
  status: status('staging_target', 'ready_for_cutover'),
  remoteSessionId: 'remote-1',
  directSource: { kind: 'claudeConfig', configDir: null, projectId: null },
  resume: {
    directory: '/repo',
    agent: 'claude',
    resume: 'remote-1',
    transcriptStorage: 'persisted',
    approvedNewDirectoryCreation: true,
  },
};

function createDeps(overrides: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const workspaceSyncAdapter = {
    prepare: vi.fn(async () => { throw new Error('unexpected workspace preparation'); }),
    finalize: vi.fn(async () => { throw new Error('unexpected workspace finalization'); }),
    commit: vi.fn(async () => { throw new Error('unexpected workspace commit'); }),
    abort: vi.fn(async () => undefined),
  };
  return {
    calls,
    deps: {
      start: vi.fn(async () => ({ ok: true as const, result: started })),
      resolveSource: vi.fn(async () => ({
        ok: true as const,
        sourceMachineId: 'source-machine',
        sessionStorageMode: 'persisted' as const,
      })),
      checkExistingTarget: vi.fn(async () => ({ ok: true })),
      prepareTarget: vi.fn(async () => {
        calls.push('prepare');
        return prepared;
      }),
      getPreparedTargetResult: vi.fn(async () => prepared),
      getTargetStatus: vi.fn(async () => ({
        handoffId: 'handoff-1',
        transitionRevision: 1,
        status: status('staging_target'),
      })),
      resumeTarget: vi.fn(async () => {
        calls.push('resume');
        return { ok: true as const };
      }),
      confirmTarget: vi.fn(async () => {
        calls.push('confirm');
        return { ok: true as const };
      }),
      commitTarget: vi.fn(async () => {
        calls.push('commit-target');
        return { handoffId: 'handoff-1', status: status('finalizing', 'completed') };
      }),
      cleanupSource: vi.fn(async () => {
        calls.push('cleanup-source');
        return { handoffId: 'handoff-1', status: status('finalizing', 'completed') };
      }),
      abort: vi.fn(async () => undefined),
      publishOwnerUpdate: vi.fn(),
      wait: vi.fn(async () => undefined),
      workspaceSyncAdapter,
      ...overrides,
    },
  };
}

describe('tracked session handoff coordinator', () => {
  it('leaves the source untouched when the target cannot resolve existing native state', async () => {
    const { deps } = createDeps({
      checkExistingTarget: vi.fn(async () => ({ ok: false, errorCode: 'existing_session_state_unavailable', error: 'Turn session data transfer on.' })),
    });
    const result = await coordinateTrackedSessionHandoff({
      input: { sessionId: 'session-1', targetMachineId: 'target-machine', targetPath: '/repo', stateTransfer: 'existing', workspaceAction: { kind: 'none' } },
      signal: new AbortController().signal, ...deps,
    });
    expect(result).toMatchObject({ ok: false, errorCode: 'existing_session_state_unavailable' });
    expect(deps.start).not.toHaveBeenCalled();
    expect(deps.prepareTarget).not.toHaveBeenCalled();
    expect(deps.abort).not.toHaveBeenCalled();
  });

  it.each(['source-machine', 'target-machine'])('uses existing state through the ordinary handoff lifecycle to %s', async targetMachineId => {
    const order: string[] = [];
    const checkExistingTarget = vi.fn(async () => { order.push('check'); return { ok: true }; });
    const { deps, calls } = createDeps({
      checkExistingTarget,
      start: vi.fn(async () => { order.push('stop'); return { ok: true as const, result: started }; }),
    });
    const result = await coordinateTrackedSessionHandoff({
      input: { sessionId: 'session-1', targetMachineId, targetPath: '/repo', stateTransfer: 'existing', workspaceAction: { kind: 'none' } },
      signal: new AbortController().signal, ...deps,
    });
    expect(result).toMatchObject({ ok: true, result: { status: { status: 'completed' } } });
    expect(order).toEqual(['check', 'stop']);
    expect(checkExistingTarget).toHaveBeenCalledWith({ sessionId: 'session-1', sourceMachineId: 'source-machine', targetMachineId,
      targetPath: '/repo', sourceSessionStorageMode: 'persisted' }, expect.any(AbortSignal));
    expect(deps.prepareTarget).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'session-1', stateTransfer: 'existing' }), expect.any(AbortSignal));
    expect(calls).toEqual(['prepare', 'resume', 'confirm', 'commit-target', 'cleanup-source']);
  });

  it('does not stop the source after cancellation of the read-only target check', async () => {
    const controller = new AbortController();
    const { deps } = createDeps({
      checkExistingTarget: vi.fn(async () => { controller.abort(); return { ok: true }; }),
    });
    const result = await coordinateTrackedSessionHandoff({
      input: { sessionId: 'session-1', targetMachineId: 'target-machine', targetPath: '/repo', stateTransfer: 'existing', workspaceAction: { kind: 'none' } },
      signal: controller.signal, ...deps,
    });
    expect(result).toMatchObject({ ok: false, errorCode: 'cancelled' });
    expect(deps.start).not.toHaveBeenCalled();
    expect(deps.abort).not.toHaveBeenCalled();
  });

  it('uses ordinary abort recovery if existing native state disappears after preflight', async () => {
    const { deps } = createDeps({
      checkExistingTarget: vi.fn(async () => ({ ok: true })),
      prepareTarget: vi.fn(async () => ({ ok: false, errorCode: 'existing_session_state_unavailable' })),
      abort: vi.fn(async () => ({ handoffId: 'handoff-1', status: { ...status('staging_target'), status: 'aborted' } })),
    });
    const result = await coordinateTrackedSessionHandoff({
      input: { sessionId: 'session-1', targetMachineId: 'target-machine', targetPath: '/repo', stateTransfer: 'existing' },
      signal: new AbortController().signal, ...deps,
    });
    expect(result).toMatchObject({ ok: false, errorCode: 'existing_session_state_unavailable' });
    expect(deps.abort).toHaveBeenNthCalledWith(1, { machineId: 'target-machine', handoffId: 'handoff-1', reason: 'existing_session_state_unavailable' });
    expect(deps.abort).toHaveBeenNthCalledWith(2, { machineId: 'source-machine', handoffId: 'handoff-1', reason: 'existing_session_state_unavailable' });
    expect(deps.resumeTarget).not.toHaveBeenCalled();
  });

  it('checks the canonical source-path fallback but never guesses a managed target directory', async () => {
    const { deps } = createDeps({ resolveSource: vi.fn(async () => ({
      ok: true, sourceMachineId: 'source-machine', sourceRootPath: '/repo', sessionStorageMode: 'persisted',
    })) });
    const existingInput = { sessionId: 'session-1', targetMachineId: 'target-machine', stateTransfer: 'existing' as const };
    expect(await coordinateTrackedSessionHandoff({ input: existingInput, signal: new AbortController().signal, ...deps })).toMatchObject({ ok: true });
    expect(deps.checkExistingTarget).toHaveBeenCalledWith(expect.objectContaining({ targetPath: '/repo' }), expect.any(AbortSignal));
    deps.start.mockClear();
    deps.checkExistingTarget.mockClear();
    expect(await coordinateTrackedSessionHandoff({ input: { ...existingInput, targetDirectory: { kind: 'managed' } },
      signal: new AbortController().signal, ...deps })).toMatchObject({ ok: false, errorCode: 'existing_session_state_unavailable' });
    expect(deps.start).not.toHaveBeenCalled();
    expect(deps.checkExistingTarget).not.toHaveBeenCalled();
  });

  it('finishes local launch and commit when cancellation arrives after binding begins', async () => {
    const controller = new AbortController();
    const { deps } = createDeps({
      workspaceSyncAdapter: createWorkspaceSyncHandoffAdapter({
        sync: {} as never,
        // Session-only handoff has no target workspace bootstrap transport.
        bootstrap: async () => { throw new Error('Unexpected target workspace bootstrap'); },
      }),
      resumeTarget: async (_request: unknown, signal: AbortSignal) => {
        controller.abort();
        signal.throwIfAborted();
        return { ok: true };
      },
      confirmTarget: async (_request: unknown, signal: AbortSignal) => {
        signal.throwIfAborted();
        return { ok: true };
      },
    });
    const result = await coordinateTrackedSessionHandoff({ input: { sessionId: 'session-1', targetMachineId: 'source-machine', targetPath: '/repo/my-app', workspaceAction: { kind: 'none' } }, signal: controller.signal, ...deps });
    expect(result).toMatchObject({ ok: true, result: { status: { status: 'completed' } } });
    expect(deps.abort).not.toHaveBeenCalled();
    expect(deps.cleanupSource).toHaveBeenCalledOnce();
  });

  it('cancels pending local preparation with one abort of the shared daemon job', async () => {
    const controller = new AbortController();
    const { deps } = createDeps({
      workspaceSyncAdapter: createWorkspaceSyncHandoffAdapter({
        sync: {} as never,
        // Session-only handoff has no target workspace bootstrap transport.
        bootstrap: async () => { throw new Error('Unexpected target workspace bootstrap'); },
      }),
      prepareTarget: async () => { controller.abort(); controller.signal.throwIfAborted(); },
      abort: vi.fn(async () => ({ handoffId: 'handoff-1', status: { ...status('staging_target'), status: 'aborted' } })),
    });
    const result = await coordinateTrackedSessionHandoff({ input: { sessionId: 'session-1', targetMachineId: 'source-machine', targetPath: '/repo/my-app', workspaceAction: { kind: 'none' } }, signal: controller.signal, ...deps });
    expect(result).toMatchObject({ ok: false, errorCode: 'cancelled' });
    expect(deps.abort).toHaveBeenCalledOnce();
    expect(deps.resumeTarget).not.toHaveBeenCalled();
  });

  it('stops before target preparation when the final linked route blocks after source quiescence', async () => {
    const linkStatus = {
      relationshipId: 'source-hub', controllerMachineId: 'hub-machine', state: 'watching' as const,
      alphaPath: '/hub', betaPath: '/source', mode: 'keep_both_in_sync' as const,
      endpointStates: {
        alpha: { connected: true, scanned: true, scanProblemCount: 0, transitionProblemCount: 0 },
        beta: { connected: true, scanned: true, scanProblemCount: 0, transitionProblemCount: 0 },
      },
      conflictCount: 0, lastCycleObservedAtMs: null,
    };
    const firstLink = { relationshipId: 'source-hub', policyDigest: allFilesContentPolicy.policyDigest, status: linkStatus };
    const blockedRoute = {
      ok: false as const,
      errorCode: 'workspace_sync_not_clean',
      completed: [firstLink],
      blockedRelationshipId: 'hub-target',
      blockedStatus: { ...linkStatus, relationshipId: 'hub-target', state: 'conflicted' as const, conflictCount: 1 },
    };
    const prepareBetween = vi.fn()
      .mockResolvedValueOnce({ ok: true, traversed: [firstLink, { ...firstLink, relationshipId: 'hub-target' }] })
      .mockResolvedValueOnce(blockedRoute);
    const workspaceSyncAdapter = createWorkspaceSyncHandoffAdapter({
      sync: {} as never,
      bootstrap: async () => ({ release: async () => undefined }),
      prepareBetween,
    });
    const calls: string[] = [];
    const { deps } = createDeps({
      workspaceSyncAdapter,
      start: vi.fn(async () => {
        calls.push('source-quiesced');
        return { ok: true as const, result: started };
      }),
      prepareTarget: vi.fn(async () => {
        calls.push('target-prepared');
        return prepared;
      }),
    });

    const result = await coordinateTrackedSessionHandoff({
      input: {
        operationId: 'linked-operation', sessionId: 'session-1', targetMachineId: 'target-machine',
        targetPath: '/target/packages/app', workspaceAction: { kind: 'linked_workspace' },
        workspaceSyncSourceWorkspaceRefId: 'source-ref', workspaceSyncTargetWorkspaceRefId: 'target-ref',
        workspaceSyncSourceRootPath: '/source', workspaceSyncTargetRootPath: '/target',
        workspaceSyncTargetSessionRelativeCwd: 'packages/app',
      },
      signal: new AbortController().signal,
      ...deps,
    });
    expect(prepareBetween).toHaveBeenCalledTimes(2);
    expect(calls).toEqual(['source-quiesced']);
    expect(result).toMatchObject({
      ok: false,
      errorCode: 'workspace_sync_partial_route_blocked',
      details: blockedRoute,
    });
    expect(deps.abort).toHaveBeenCalledTimes(2);
  });
  it('prepares daemon-owned relationship creation from roots and host Account scope without pre-created refs', async () => {
    const workspaceSyncAdapter = {
      prepare: vi.fn(async (input: { operationId: string; action: { kind: 'create_relationship' } }) => ({
        kind: input.action.kind,
        operationId: input.operationId,
        relationshipId: 'relationship-created',
        action: input.action,
      })),
      finalize: vi.fn(async (input: { operationId: string }) => ({
        kind: 'create_relationship' as const,
        operationId: input.operationId,
        relationshipId: 'relationship-created',
      })),
      commit: vi.fn(async (input: { operationId: string }) => ({
        kind: 'create_relationship' as const,
        operationId: input.operationId,
        relationshipId: 'relationship-created',
      })),
      abort: vi.fn(async () => undefined),
    };
    const { deps } = createDeps({ workspaceSyncAdapter });

    const result = await coordinateTrackedSessionHandoff({
      input: {
        operationId: 'action-create-1',
        sessionId: 'session-1',
        targetMachineId: 'target-machine',
        accountServerId: 'server-host',
        workspaceAction: {
          kind: 'create_relationship',
          mode: 'keep_synced',
          contentPolicy: allFilesContentPolicy,
          flushBeforeCommit: true,
        },
        workspaceSyncSourceRootPath: '/source/repo',
        workspaceSyncTargetRootPath: '/target/repo',
      },
      signal: new AbortController().signal,
      ...deps,
    });

    expect(result.ok).toBe(true);
    expect(workspaceSyncAdapter.prepare).toHaveBeenCalledWith(expect.objectContaining({
      operationId: 'action-create-1',
      accountServerId: 'server-host',
      sourceRootPath: '/source/repo',
      targetRootPath: '/target/repo',
    }));
    expect(workspaceSyncAdapter.prepare).not.toHaveBeenCalledWith(expect.objectContaining({
      sourceWorkspaceRefId: expect.anything(),
    }));
    expect(deps.prepareTarget).not.toHaveBeenCalledWith(expect.objectContaining({
      workspaceRootPath: expect.anything(),
    }), expect.anything());
  });

  it('owns the full parent sequence and publishes the handoff id before settlement', async () => {
    const { deps, calls } = createDeps();
    const result = await coordinateTrackedSessionHandoff({
      input: { sessionId: 'session-1', targetMachineId: 'target-machine' },
      signal: new AbortController().signal,
      ...deps,
    });

    expect(result).toMatchObject({
      ok: true,
      result: { handoffId: 'handoff-1', workspace: { kind: 'none' } },
    });
    expect(calls).toEqual(['prepare', 'resume', 'confirm', 'commit-target', 'cleanup-source']);
    expect(deps.checkExistingTarget).not.toHaveBeenCalled();
    expect(deps.publishOwnerUpdate).toHaveBeenCalledWith(expect.objectContaining({
      domainRef: { kind: 'handoff', id: 'handoff-1', targetMachineId: 'target-machine' },
    }));
    const phases = deps.publishOwnerUpdate.mock.calls
      .map(([update]) => update.progress?.phase)
      .filter(Boolean);
    expect(phases).toEqual([
      'packaging_session_state',
      'preparing_target',
      'resuming_target',
      'confirming_target',
      'committing_target',
      'cleaning_source',
    ]);
  });

  it('uses an explicitly selected target directory instead of the source-derived path', async () => {
    const { deps } = createDeps();

    await coordinateTrackedSessionHandoff({
      input: {
        sessionId: 'session-1',
        targetMachineId: 'target-machine',
        targetPath: '/home/guest/workspace',
      },
      signal: new AbortController().signal,
      ...deps,
    });

    expect(deps.prepareTarget).toHaveBeenCalledWith(expect.objectContaining({
      targetPath: '/home/guest/workspace',
    }), expect.any(AbortSignal));
  });

  it('polls a pending prepare result and never treats nested ok:false as success', async () => {
    const { deps } = createDeps({
      prepareTarget: vi.fn(async () => ({ handoffId: 'handoff-1', status: status('staging_target') })),
      getPreparedTargetResult: vi.fn()
        .mockResolvedValueOnce({ ok: false, errorCode: 'not_found' })
        .mockResolvedValueOnce(prepared),
    });
    const result = await coordinateTrackedSessionHandoff({
      input: { sessionId: 'session-1', targetMachineId: 'target-machine' },
      signal: new AbortController().signal,
      ...deps,
    });
    expect(result.ok).toBe(true);
    expect(deps.getPreparedTargetResult).toHaveBeenCalledTimes(2);
    expect(deps.wait).toHaveBeenCalledTimes(1);
  });

  it('projects authoritative workspace byte transfer into the parent action operation', async () => {
    const transferStatus = {
      ...status('staging_target'),
      progress: {
        updatedAtMs: 123,
        checkpoint: 'transfer_blobs' as const,
        planned: { totalFiles: 4, totalBytes: 4096 },
        transferred: { files: 2, bytes: 1024, blobs: 1 },
        current: { relativePath: 'src/index.ts' },
        resumable: true,
      },
    };
    const { deps } = createDeps({
      prepareTarget: vi.fn(async () => ({ handoffId: 'handoff-1', status: transferStatus })),
      getPreparedTargetResult: vi.fn()
        .mockResolvedValueOnce({ ok: false, errorCode: 'not_found' })
        .mockResolvedValueOnce(prepared),
      getTargetStatus: vi.fn(async () => ({ handoffId: 'handoff-1', transitionRevision: 1, status: transferStatus })),
    });

    await coordinateTrackedSessionHandoff({
      input: { sessionId: 'session-1', targetMachineId: 'target-machine' },
      signal: new AbortController().signal,
      ...deps,
    });

    expect(deps.publishOwnerUpdate).toHaveBeenCalledWith({
      progress: {
        current: 1024,
        total: 4096,
        phase: 'workspace_transfer_blobs',
        label: 'Transferring workspace · src/index.ts',
      },
    });
  });

  it('projects authoritative session bundle byte transfer into the parent action operation', async () => {
    const transferStatus = {
      ...status('staging_target'),
      progress: {
        updatedAtMs: 123,
        checkpoint: 'import_session',
        planned: { totalBytes: 4096 },
        transferred: { bytes: 1024 },
        current: { phaseDetail: 'transferring_session' },
        resumable: false,
      },
    };
    const { deps } = createDeps({
      prepareTarget: vi.fn(async () => ({ handoffId: 'handoff-1', status: transferStatus })),
      getPreparedTargetResult: vi.fn(async () => prepared),
      getTargetStatus: vi.fn(async () => ({ handoffId: 'handoff-1', transitionRevision: 1, status: transferStatus })),
    });

    await coordinateTrackedSessionHandoff({
      input: { sessionId: 'session-1', targetMachineId: 'target-machine' },
      signal: new AbortController().signal,
      ...deps,
    });

    expect(deps.publishOwnerUpdate).toHaveBeenCalledWith({
      progress: {
        phase: 'session_transfer',
        current: 1024,
        total: 4096,
        label: 'Transferring session data',
      },
    });
  });

  it('waits for explicit user Resume and continues the parent sequence exactly once after recovery', async () => {
    let releaseWait: (() => void) | undefined;
    const waitForResume = new Promise<void>((resolve) => {
      releaseWait = resolve;
    });
    const getPreparedTargetResult = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        errorCode: 'awaiting_user_resume',
        error: 'Prepare-target job is awaiting_user_resume',
      })
      .mockResolvedValueOnce(prepared);
    const { deps, calls } = createDeps({
      prepareTarget: vi.fn(async () => ({
        handoffId: 'handoff-1',
        status: status('staging_target'),
      })),
      getPreparedTargetResult,
      getTargetStatus: vi.fn(async () => ({
        handoffId: 'handoff-1',
        transitionRevision: 7,
        status: {
          ...status('staging_target'),
          jobId: 'prepare_handoff-1',
          status: 'awaiting_user_resume',
        },
      })),
      wait: vi.fn(async () => await waitForResume),
    });

    let settled = false;
    const resultPromise = coordinateTrackedSessionHandoff({
      input: { sessionId: 'session-1', targetMachineId: 'target-machine' },
      signal: new AbortController().signal,
      ...deps,
    }).finally(() => {
      settled = true;
    });

    await vi.waitFor(() => {
      expect(deps.publishOwnerUpdate).toHaveBeenCalledWith({
        progress: {
          phase: 'awaiting_user_resume',
          label: 'Waiting for Resume',
        },
      });
    });
    expect(settled).toBe(false);
    expect(deps.prepareTarget).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([]);

    releaseWait?.();
    const result = await resultPromise;

    expect(result.ok).toBe(true);
    expect(getPreparedTargetResult).toHaveBeenCalledTimes(2);
    expect(calls).toEqual(['resume', 'confirm', 'commit-target', 'cleanup-source']);
    expect(deps.resumeTarget).toHaveBeenCalledTimes(1);
    expect(deps.confirmTarget).toHaveBeenCalledTimes(1);
    expect(deps.commitTarget).toHaveBeenCalledTimes(1);
    expect(deps.cleanupSource).toHaveBeenCalledTimes(1);
  });

  it('fails instead of polling forever when both prepare result and canonical target status are lost', async () => {
    const { deps } = createDeps({
      prepareTarget: vi.fn(async () => ({ ok: false, errorCode: 'not_found', error: 'pending' })),
      getPreparedTargetResult: vi.fn(async () => ({ ok: false, errorCode: 'not_found' })),
      getTargetStatus: vi.fn(async () => ({ ok: false, errorCode: 'not_found' })),
    });

    const result = await coordinateTrackedSessionHandoff({
      input: { sessionId: 'session-1', targetMachineId: 'target-machine' },
      signal: new AbortController().signal,
      ...deps,
    });

    expect(result).toEqual({
      ok: false,
      errorCode: 'not_found',
      error: 'not_found',
    });
    expect(deps.wait).not.toHaveBeenCalled();
    expect(deps.resumeTarget).not.toHaveBeenCalled();
    expect(deps.abort).toHaveBeenCalledTimes(2);
  });

  it('aborts both sides after a target failure', async () => {
    const { deps } = createDeps({
      resumeTarget: vi.fn(async () => ({ ok: false, errorCode: 'resume_failed', error: 'resume_failed' })),
    });
    const result = await coordinateTrackedSessionHandoff({
      input: { sessionId: 'session-1', targetMachineId: 'target-machine' },
      signal: new AbortController().signal,
      ...deps,
    });
    expect(result).toEqual({ ok: false, errorCode: 'resume_failed', error: 'resume_failed' });
    expect(deps.abort).toHaveBeenCalledWith(expect.objectContaining({ machineId: 'target-machine' }));
    expect(deps.abort).toHaveBeenCalledWith(expect.objectContaining({ machineId: 'source-machine' }));
  });

  it('compensates a durably published relationship when target commit fails', async () => {
    const workspaceSyncAdapter = {
      prepare: vi.fn(async (input: { operationId: string; action: { kind: 'create_relationship' } }) => ({
        kind: input.action.kind,
        operationId: input.operationId,
        relationshipId: 'relationship-created',
        action: input.action,
      })),
      finalize: vi.fn(async (input: { operationId: string }) => ({
        kind: 'create_relationship' as const,
        operationId: input.operationId,
        relationshipId: 'relationship-created',
      })),
      commit: vi.fn(async (input: { operationId: string }) => ({
        kind: 'create_relationship' as const,
        operationId: input.operationId,
        relationshipId: 'relationship-created',
      })),
      abort: vi.fn(async () => undefined),
    };
    const { deps } = createDeps({
      workspaceSyncAdapter,
      commitTarget: vi.fn(async () => ({
        ok: false,
        errorCode: 'target_commit_failed',
        error: 'target_commit_failed',
      })),
    });

    const result = await coordinateTrackedSessionHandoff({
      input: {
        operationId: 'action-request-1',
        sessionId: 'session-1',
        targetMachineId: 'target-machine',
        accountServerId: 'server-host',
        workspaceAction: {
          kind: 'create_relationship',
          mode: 'keep_synced',
          contentPolicy: allFilesContentPolicy,
          flushBeforeCommit: true,
        },
        workspaceSyncSourceRootPath: '/source/repo',
        workspaceSyncTargetRootPath: '/target/repo',
      },
      signal: new AbortController().signal,
      ...deps,
    });

    expect(result).toEqual({
      ok: false,
      errorCode: 'target_commit_failed',
      error: 'target_commit_failed',
    });
    expect(workspaceSyncAdapter.commit).not.toHaveBeenCalled();
    expect(workspaceSyncAdapter.abort).toHaveBeenCalledWith(expect.objectContaining({
      operationId: 'action-request-1',
    }));
  });

  it('fails before target preparation when durable relationship publication is rejected', async () => {
    const workspaceSyncAdapter = {
      prepare: vi.fn(async (input: { operationId: string; action: { kind: 'create_relationship' } }) => ({
        kind: input.action.kind,
        operationId: input.operationId,
        relationshipId: 'relationship-created',
        action: input.action,
      })),
      finalize: vi.fn(async () => {
        throw Object.assign(new Error('settings conflict'), { code: 'workspace_sync_settings_conflict' });
      }),
      commit: vi.fn(),
      abort: vi.fn(async () => undefined),
    };
    const { deps } = createDeps({ workspaceSyncAdapter });

    const result = await coordinateTrackedSessionHandoff({
      input: {
        operationId: 'action-create-1',
        sessionId: 'session-1',
        targetMachineId: 'target-machine',
        accountServerId: 'server-host',
        workspaceAction: {
          kind: 'create_relationship',
          mode: 'keep_synced',
          contentPolicy: allFilesContentPolicy,
          flushBeforeCommit: true,
        },
        workspaceSyncSourceRootPath: '/source/repo',
        workspaceSyncTargetRootPath: '/target/repo',
      },
      signal: new AbortController().signal,
      ...deps,
    });

    expect(result).toEqual({ ok: false, errorCode: 'workspace_sync_settings_conflict', error: 'settings conflict' });
    expect(deps.prepareTarget).not.toHaveBeenCalled();
    expect(deps.commitTarget).not.toHaveBeenCalled();
    expect(workspaceSyncAdapter.abort).toHaveBeenCalledOnce();
  });

  it('preserves retry authority when durable relationship publication has an unknown outcome', async () => {
    const workspaceSyncAdapter = {
      prepare: vi.fn(async (input: { operationId: string; action: { kind: 'create_relationship' } }) => ({
        kind: input.action.kind,
        operationId: input.operationId,
        relationshipId: 'relationship-created',
        action: input.action,
      })),
      finalize: vi.fn(async () => {
        throw Object.assign(new Error('settings outcome unknown'), { code: 'indeterminate' });
      }),
      commit: vi.fn(),
      abort: vi.fn(async () => undefined),
    };
    const { deps } = createDeps({ workspaceSyncAdapter });

    const result = await coordinateTrackedSessionHandoff({
      input: {
        operationId: 'action-create-1',
        sessionId: 'session-1',
        targetMachineId: 'target-machine',
        accountServerId: 'server-host',
        workspaceAction: {
          kind: 'create_relationship',
          mode: 'keep_synced',
          contentPolicy: allFilesContentPolicy,
          flushBeforeCommit: true,
        },
        workspaceSyncSourceRootPath: '/source/repo',
        workspaceSyncTargetRootPath: '/target/repo',
      },
      signal: new AbortController().signal,
      ...deps,
    });

    expect(result).toEqual({ ok: false, errorCode: 'indeterminate', error: 'settings outcome unknown' });
    expect(workspaceSyncAdapter.abort).not.toHaveBeenCalled();
    expect(deps.abort).not.toHaveBeenCalled();
    expect(deps.commitTarget).not.toHaveBeenCalled();
  });

  it('finalizes workspace bytes after source quiescence and before target preparation or resume', async () => {
    const calls: string[] = [];
    const workspaceSyncAdapter = {
      prepare: vi.fn(async (input: { operationId: string; action: { kind: 'copy_once' } }) => {
        calls.push('workspace-prepare');
        return {
          kind: input.action.kind,
          operationId: input.operationId,
          action: input.action,
        };
      }),
      finalize: vi.fn(async (input: { operationId: string }) => {
        calls.push('workspace-finalize');
        return { kind: 'copy_once' as const, operationId: input.operationId };
      }),
      commit: vi.fn(async (input: { operationId: string }) => {
        calls.push('workspace-commit');
        return { kind: 'copy_once' as const, operationId: input.operationId };
      }),
      abort: vi.fn(async () => undefined),
    };
    const { deps } = createDeps({
      workspaceSyncAdapter,
      start: vi.fn(async () => {
        calls.push('source-quiesced');
        return { ok: true as const, result: started };
      }),
      prepareTarget: vi.fn(async () => {
        calls.push('target-prepare');
        return prepared;
      }),
      resumeTarget: vi.fn(async () => {
        calls.push('target-resume');
        return { ok: true as const };
      }),
      confirmTarget: vi.fn(async () => {
        calls.push('target-confirm');
        return { ok: true as const };
      }),
      commitTarget: vi.fn(async () => {
        calls.push('target-commit');
        return { handoffId: 'handoff-1', status: status('finalizing', 'completed') };
      }),
    });

    const result = await coordinateTrackedSessionHandoff({
      input: {
        operationId: 'action-request-1',
        sessionId: 'session-1',
        targetMachineId: 'target-machine',
        workspaceAction: {
          kind: 'copy_once',
          contentPolicy: allFilesContentPolicy,
        },
        workspaceSyncSourceRootPath: '/source/repo',
        workspaceSyncTargetRootPath: '/target/repo',
        workspaceSyncSourceWorkspaceRefId: 'source-ref',
        workspaceSyncTargetWorkspaceRefId: 'target-ref',
      },
      signal: new AbortController().signal,
      ...deps,
    });

    expect(result.ok).toBe(true);
    expect(calls).toEqual([
      'workspace-prepare',
      'source-quiesced',
      'workspace-finalize',
      'target-prepare',
      'target-resume',
      'target-confirm',
      'target-commit',
      'workspace-commit',
    ]);
    expect(workspaceSyncAdapter.prepare).toHaveBeenCalledWith(expect.objectContaining({
      operationId: 'action-request-1',
      sourceWorkspaceRefId: 'source-ref',
      targetWorkspaceRefId: 'target-ref',
    }));
  });

  it('releases a prepared workspace when cancellation happens before a handoff id exists', async () => {
    const controller = new AbortController();
    const workspaceSyncAdapter = {
      prepare: vi.fn(async (input: { operationId: string; action: { kind: 'copy_once' } }) => ({
        kind: input.action.kind,
        operationId: input.operationId,
        action: input.action,
      })),
      finalize: vi.fn(),
      commit: vi.fn(),
      abort: vi.fn(async () => undefined),
    };
    const { deps } = createDeps({
      workspaceSyncAdapter,
      start: vi.fn(async () => await new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
      })),
    });
    const operation = coordinateTrackedSessionHandoff({
      input: {
        operationId: 'action-request-before-start',
        sessionId: 'session-1',
        targetMachineId: 'target-machine',
        workspaceAction: {
          kind: 'copy_once',
          contentPolicy: allFilesContentPolicy,
        },
        workspaceSyncSourceRootPath: '/source/repo',
        workspaceSyncTargetRootPath: '/target/repo',
        workspaceSyncSourceWorkspaceRefId: 'source-ref',
        workspaceSyncTargetWorkspaceRefId: 'target-ref',
      },
      signal: controller.signal,
      ...deps,
    });
    await vi.waitFor(() => expect(workspaceSyncAdapter.prepare).toHaveBeenCalledTimes(1));
    controller.abort(new Error('cancel'));

    await expect(operation).resolves.toEqual({ ok: false, errorCode: 'cancelled', error: 'cancelled' });
    expect(workspaceSyncAdapter.abort).toHaveBeenCalledWith(expect.objectContaining({
      operationId: 'action-request-before-start',
    }));
    expect(deps.abort).not.toHaveBeenCalled();
  });

  it('acknowledges cancellation only after both handoff owners report aborted', async () => {
    const controller = new AbortController();
    const { deps } = createDeps({
      prepareTarget: vi.fn(async () => ({ handoffId: 'handoff-1', status: status('staging_target') })),
      getPreparedTargetResult: vi.fn(async () => ({ ok: false, errorCode: 'not_found' })),
      wait: vi.fn(async (signal: AbortSignal) => await new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      })),
      abort: vi.fn(async () => ({
        handoffId: 'handoff-1',
        status: { ...status('staging_target'), status: 'aborted' },
      })),
    });
    const operation = coordinateTrackedSessionHandoff({
      input: { sessionId: 'session-1', targetMachineId: 'target-machine' },
      signal: controller.signal,
      ...deps,
    });
    await vi.waitFor(() => expect(deps.wait).toHaveBeenCalled());
    const reason = new Error('cancel');
    reason.name = 'AbortError';
    controller.abort(reason);

    await expect(operation).resolves.toEqual({ ok: false, errorCode: 'cancelled', error: 'cancelled' });
    expect(deps.abort).toHaveBeenCalledTimes(2);
  });

  it('fails cancellation when either handoff owner does not acknowledge abort', async () => {
    const controller = new AbortController();
    const abort = vi.fn()
      .mockResolvedValueOnce({
        handoffId: 'handoff-1',
        status: { ...status('staging_target'), status: 'aborted' },
      })
      .mockResolvedValueOnce({ ok: false, errorCode: 'not_found' });
    const { deps } = createDeps({
      prepareTarget: vi.fn(async () => ({ handoffId: 'handoff-1', status: status('staging_target') })),
      getPreparedTargetResult: vi.fn(async () => ({ ok: false, errorCode: 'not_found' })),
      wait: vi.fn(async (signal: AbortSignal) => await new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      })),
      abort,
    });
    const operation = coordinateTrackedSessionHandoff({
      input: { sessionId: 'session-1', targetMachineId: 'target-machine' },
      signal: controller.signal,
      ...deps,
    });
    await vi.waitFor(() => expect(deps.wait).toHaveBeenCalled());
    const reason = new Error('cancel');
    reason.name = 'AbortError';
    controller.abort(reason);

    await expect(operation).resolves.toEqual({
      ok: false,
      errorCode: 'session_handoff_cancellation_unconfirmed',
      error: 'session_handoff_cancellation_unconfirmed',
    });
    expect(abort).toHaveBeenCalledTimes(2);
  });

  it('keeps target-commit success when source cleanup returns a nested failure', async () => {
    const { deps } = createDeps({
      cleanupSource: vi.fn(async () => ({ ok: false, errorCode: 'cleanup_failed', error: 'cleanup_failed' })),
    });
    const result = await coordinateTrackedSessionHandoff({
      input: { sessionId: 'session-1', targetMachineId: 'target-machine' },
      signal: new AbortController().signal,
      ...deps,
    });
    expect(result).toMatchObject({
      ok: true,
      result: {
        handoffId: 'handoff-1',
        warning: { code: 'source_cleanup_failed', message: 'cleanup_failed' },
      },
    });
  });

  it.each([
    ['throws', () => { throw new Error('cleanup transport failed'); }],
    ['is cancelled', () => { throw Object.assign(new Error('cancelled during cleanup'), { name: 'AbortError', code: 'cancelled' }); }],
  ])('keeps target-commit success when source cleanup %s', async (_label, cleanup) => {
    const abort = vi.fn(async () => undefined);
    const { deps } = createDeps({
      cleanupSource: vi.fn(async () => cleanup()),
      abort,
    });
    const result = await coordinateTrackedSessionHandoff({
      input: { sessionId: 'session-1', targetMachineId: 'target-machine' },
      signal: new AbortController().signal,
      ...deps,
    });
    expect(result).toMatchObject({
      ok: true,
      result: {
        handoffId: 'handoff-1',
        warning: { code: 'source_cleanup_failed' },
      },
    });
    expect(abort).not.toHaveBeenCalled();
  });

  it('keeps target-commit success when a later progress publication throws', async () => {
    const abort = vi.fn(async () => undefined);
    const publishOwnerUpdate = vi.fn((update: { progress?: { phase?: string } }) => {
      if (update.progress?.phase === 'cleaning_source') {
        throw new Error('progress consumer unavailable');
      }
    });
    const { deps } = createDeps({ abort, publishOwnerUpdate });

    await expect(coordinateTrackedSessionHandoff({
      input: { sessionId: 'session-1', targetMachineId: 'target-machine' },
      signal: new AbortController().signal,
      ...deps,
    })).resolves.toMatchObject({
      ok: true,
      result: {
        handoffId: 'handoff-1',
        warning: { code: 'source_cleanup_failed', message: 'progress consumer unavailable' },
      },
    });
    expect(abort).not.toHaveBeenCalled();
  });

  it('keeps target-commit success when post-publication workspace fence cleanup fails', async () => {
    const workspaceSyncAdapter = {
      prepare: vi.fn(async (input: { operationId: string; action: { kind: 'create_relationship' } }) => ({
        kind: input.action.kind,
        operationId: input.operationId,
        relationshipId: 'relationship-created',
        action: input.action,
      })),
      finalize: vi.fn(async (input: { operationId: string }) => ({
        kind: 'create_relationship' as const,
        operationId: input.operationId,
        relationshipId: 'relationship-created',
      })),
      commit: vi.fn(async () => {
        throw Object.assign(new Error('target workspace authority release failed'), { code: 'peer_unavailable' });
      }),
      abort: vi.fn(async () => undefined),
    };
    const { deps } = createDeps({ workspaceSyncAdapter });

    const result = await coordinateTrackedSessionHandoff({
      input: {
        operationId: 'action-request-1',
        sessionId: 'session-1',
        targetMachineId: 'target-machine',
        accountServerId: 'server-host',
        workspaceAction: {
          kind: 'create_relationship',
          mode: 'keep_synced',
          contentPolicy: allFilesContentPolicy,
          flushBeforeCommit: true,
        },
        workspaceSyncSourceRootPath: '/source/repo',
        workspaceSyncTargetRootPath: '/target/repo',
      },
      signal: new AbortController().signal,
      ...deps,
    });

    // The workspace outcome is the strict terminal result: a newly created
    // relationship, with its own post-commit cleanup debt rather than a
    // source-cleanup warning that never happened.
    expect(result).toEqual({
      ok: true,
      result: {
        handoffId: 'handoff-1',
        status: expect.anything(),
        workspace: {
          kind: 'relationship',
          relationshipId: 'relationship-created',
          created: true,
          cleanupWarning: {
            code: 'peer_unavailable',
            message: 'target workspace authority release failed',
          },
        },
      },
    });
    expect(deps.cleanupSource).toHaveBeenCalledTimes(1);
    expect(workspaceSyncAdapter.abort).not.toHaveBeenCalled();
  });

  it('preserves the primary handoff failure and every workspace abort failure', async () => {
    const terminationFailure = new Error('copy termination failed');
    const fenceFailure = new Error('workspace fence release failed');
    const workspaceSyncAdapter = {
      prepare: vi.fn(async (input: { operationId: string; action: { kind: 'copy_once' } }) => ({
        kind: input.action.kind,
        operationId: input.operationId,
        action: input.action,
      })),
      finalize: vi.fn(),
      commit: vi.fn(),
      abort: vi.fn(async () => {
        throw new AggregateError([terminationFailure, fenceFailure], 'Workspace handoff abort cleanup failed');
      }),
    };
    const { deps } = createDeps({
      workspaceSyncAdapter,
      start: vi.fn(async () => ({
        ok: false as const,
        errorCode: 'session_handoff_start_failed',
        error: 'source stop failed',
      })),
    });

    const result = await coordinateTrackedSessionHandoff({
      input: {
        operationId: 'action-copy-1',
        sessionId: 'session-1',
        targetMachineId: 'target-machine',
        workspaceAction: {
          kind: 'copy_once',
          contentPolicy: allFilesContentPolicy,
        },
        workspaceSyncSourceRootPath: '/source/repo',
        workspaceSyncTargetRootPath: '/target/repo',
        workspaceSyncSourceWorkspaceRefId: 'source-ref',
        workspaceSyncTargetWorkspaceRefId: 'target-ref',
      },
      signal: new AbortController().signal,
      ...deps,
    });

    expect(result).toEqual({
      ok: false,
      errorCode: 'session_handoff_start_failed',
      error: 'source stop failed; workspace cleanup failed: copy termination failed; workspace fence release failed',
    });
    expect(workspaceSyncAdapter.abort).toHaveBeenCalledOnce();
  });
});
