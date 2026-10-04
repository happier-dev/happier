import { describe, expect, it, vi } from 'vitest';

import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor';
import type { AgentStartContextV1 } from '../account/settings/admitAgentStartV1';

const workflowStartContext: AgentStartContextV1 = {
  caller: { kind: 'originless', runId: 'workflow-1', runDepth: 0 },
  baseline: { machineId: 'machine-1', directory: '/repo' },
  ledSubtreeSessionIds: [], workDepthLimit: 4, roles: {}, callerPermissionCeiling: 'read-only',
};

describe('createActionExecutor (review.start)', () => {
  it('stamps one fresh group on every engine Run, including detached Workflow fanout', async () => {
    const starts: Array<Record<string, unknown>> = [];
    const executor = createActionExecutor({
      executionRunStart: async (_sessionId, input) => {
        starts.push(input);
        return { runId: `run-${starts.length}`, callId: `call-${starts.length}`, sidechainId: `call-${starts.length}` };
      },
      executionRunCheckProtocolV2: async () => ({ ok: true }),
      reviewEnginesList: async () => ({ items: [{ value: 'codex', label: 'Codex' }, { value: 'claude', label: 'Claude' }] }),
    } as ActionExecutorDeps);
    const input = { engineIds: ['codex', 'claude'], instructions: 'Review.', display: { groupId: 'caller-forged' } };
    await executor.execute('review.start', { ...input, sessionId: 's1' }, { surface: 'ui' });
    await executor.execute('review.start', input, {
      surface: 'agent', executionRunTargetMachineId: 'machine-1',
      agentStartContext: workflowStartContext,
      externalActionTarget: { kind: 'machine', machineId: 'machine-1', project: { machineId: 'machine-1', directory: '/repo' } },
      actionCaller: { kind: 'workflowRun', runId: 'workflow-1', authorization: { principal: { kind: 'host' }, admittedPermissionCeiling: 'read-only' } },
    });
    expect(starts).toHaveLength(4);
    const groups = starts.map((start) => (start.display as { groupId?: string } | undefined)?.groupId);
    expect(groups[0]).toEqual(expect.any(String));
    expect(groups[0]).not.toBe('caller-forged');
    expect(groups[1]).toBe(groups[0]);
    expect(groups[2]).toEqual(expect.any(String));
    expect(groups[3]).toBe(groups[2]);
    expect(groups[2]).not.toBe(groups[0]);
  });
  it.each([true, false])('forwards caller notification %s to every launched review engine', async (notifyParentOnCompletion) => {
    const executionRunStart = vi.fn<ActionExecutorDeps['executionRunStart']>(async () => ({ runId: 'run_1', callId: 'call_1', sidechainId: 'call_1' }));
    const executor = createActionExecutor({
      executionRunStart,
      reviewEnginesList: async () => ({ items: [{ value: 'codex', label: 'Codex' }, { value: 'claude', label: 'Claude' }] }),
    } as ActionExecutorDeps);

    const result = await executor.execute('review.start', {
      sessionId: 's1', engineIds: ['codex', 'claude'], instructions: 'Review this.', notifyParentOnCompletion,
    }, { surface: 'ui', defaultSessionId: 's1' });

    expect(result.ok).toBe(true);
    expect(executionRunStart.mock.calls).toHaveLength(2);
    for (const call of executionRunStart.mock.calls) {
      expect(call[0]).toBe('s1');
      expect(call[1]).toMatchObject({ notifyParentOnCompletion, retentionPolicy: 'resumable' });
    }
  });

  it.each([undefined, { kind: 'detached' as const }])('starts an originless workflow review with target %j and carries trusted workflow identity outside input', async (target) => {
    // Execution start/capability adapters are the machine transport boundary.
    const executionRunStart = vi.fn<ActionExecutorDeps['executionRunStart']>(async () => ({ runId: 'review-1', callId: 'call-review', sidechainId: 'call-review' }));
    const executor = createActionExecutor({
      executionRunStart,
      executionRunCheckProtocolV2: async () => ({ ok: true }),
      reviewEnginesList: async () => ({ items: [{ value: 'codex', label: 'Codex' }] }),
    } as ActionExecutorDeps);
    const result = await executor.execute('review.start', {
      ...(target ? { target } : {}), engineIds: ['codex'], instructions: 'Review the workspace.',
      workflowRunId: 'forged-input-id',
    }, {
      surface: 'agent', executionRunTargetMachineId: 'machine-1',
      agentStartContext: workflowStartContext,
      actionRequestId: 'review-request',
      externalActionTarget: { kind: 'machine', machineId: 'machine-1', project: { machineId: 'machine-1', directory: '/repo' } },
      actionCaller: { kind: 'workflowRun', runId: 'workflow-1', authorization: {
        principal: { kind: 'host' }, admittedPermissionCeiling: 'read-only',
      } },
    });
    expect(result).toMatchObject({ ok: true, result: { intent: 'review', sessionId: null } });
    expect(executionRunStart).toHaveBeenCalledWith(null, expect.objectContaining({ intent: 'review', cwd: '/repo' }),
      expect.objectContaining({ workflowRunId: 'workflow-1', targetMachineId: 'machine-1', actionRequestId: 'review-request',
        actionCaller: expect.objectContaining({ kind: 'workflowRun', runId: 'workflow-1' }) }));
  });

  it('preserves a Saved Secret overlay on a current-session review through the canonical Run', async () => {
    const executionRunStart = vi.fn<ActionExecutorDeps['executionRunStart']>(async () => ({ runId: 'run-review', callId: 'call-review', sidechainId: 'call-review' }));
    const executionRunCheckProtocolV2 = vi.fn(async () => ({ ok: true as const }));
    const executor = createActionExecutor({
      executionRunStart,
      reviewEnginesList: async () => ({ items: [{ value: 'codex', label: 'Codex' }] }),
      executionRunCheckProtocolV2,
    } as ActionExecutorDeps);

    await expect(executor.execute('review.start', {
      sessionId: 's1',
      engineIds: ['codex'],
      instructions: 'Review this.',
      runLocation: 'current_session',
      secretReferenceOverlay: {
        v: 1,
        bindings: { OPENAI_API_KEY: { ref: 'happier:shared-secret:v1:shared-1', revision: 7 } },
      },
    }, { surface: 'ui', defaultSessionId: 's1' })).resolves.toMatchObject({
      ok: true,
      result: { results: [{ key: 'codex', ok: true, result: { runId: 'run-review' } }] },
    });
    expect(executionRunCheckProtocolV2).toHaveBeenCalled();
    expect(executionRunStart).toHaveBeenCalledWith('s1', expect.objectContaining({
      secretReferenceOverlay: { v: 1, bindings: { OPENAI_API_KEY: { ref: 'happier:shared-secret:v1:shared-1', revision: 7 } } },
    }), expect.any(Object));
  });

  it('rejects an invalid run payload rather than reporting an inline success', async () => {
    const executor = createActionExecutor({
      executionRunStart: async () => new Map([['unexpected', true]]),
      reviewEnginesList: async () => ({ items: [{ value: 'codex', label: 'Codex' }] }),
    } as ActionExecutorDeps);

    await expect(executor.execute(
      'review.start',
      {
        sessionId: 's1',
        engineIds: ['codex'],
        instructions: 'Review this.',
        runLocation: 'current_session',
      },
      { surface: 'ui', defaultSessionId: 's1' },
    )).resolves.toMatchObject({
      ok: true,
      result: { results: [{ key: 'codex', ok: false }] },
    });
  });

  it('routes current-session reviews through the materializing bounded Run owner', async () => {
    const executionRunStart = vi.fn(async () => ({ runId: 'run_1', callId: 'call_1', sidechainId: 'call_1' }));

    const executor = createActionExecutor({
      executionRunStart,
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
      reviewEnginesList: async () => ({ items: [{ value: 'codex', label: 'Codex' }] }),
      agentsBackendsList: async () => ({ items: [] }),
      agentsModelsList: async () => ({ items: [] }),
      sessionSendMessage: async () => ({}),
      sessionPermissionRespond: async () => ({}),
      sessionUserActionAnswer: async () => ({}),
      sessionModeSet: async () => ({}),
      sessionModesList: async () => ({ items: [] }),
      sessionTargetPrimarySet: async () => ({}),
      sessionTargetTrackedSet: async () => ({}),
      sessionList: async () => ({}),
      sessionActivityGet: async () => ({}),
      sessionRecentMessagesGet: async () => ({}),
      daemonMemorySearch: async () => ({ v: 1, ok: true as const, hits: [] }),
      daemonMemoryGetWindow: async () => ({ v: 1, snippets: [], citations: [] }),
      daemonMemoryEnsureUpToDate: async () => ({ ok: true }),
      resetGlobalVoiceAgent: async () => {},
    });

    await expect(executor.execute(
      'review.start',
      {
        sessionId: 's1',
        engineIds: ['codex'],
        instructions: 'Review this.',
        runLocation: 'current_session',
        changeType: 'uncommitted',
        base: { kind: 'none' },
      },
      { surface: 'ui', defaultSessionId: 's1' },
    )).resolves.toEqual({
      ok: true,
      result: { intent: 'review', sessionId: 's1', results: [{ key: 'codex', ok: true, result: { runId: 'run_1', callId: 'call_1', sidechainId: 'call_1' } }] },
    });

    expect(executionRunStart).toHaveBeenCalledWith('s1', expect.objectContaining({
      intent: 'review', runClass: 'bounded',
      instructions: 'Review this.',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
    }), {});
  });

  it('passes the clamped agent permission mode to current-session review Runs', async () => {
    const executionRunStart = vi.fn(async () => ({ runId: 'run_1', callId: 'call_1', sidechainId: 'call_1' }));

    const executor = createActionExecutor({
      executionRunStart,
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
      reviewEnginesList: async () => ({ items: [{ value: 'codex', label: 'Codex' }] }),
      agentsBackendsList: async () => ({ items: [] }),
      agentsModelsList: async () => ({ items: [] }),
      sessionSendMessage: async () => ({}),
      sessionPermissionRespond: async () => ({}),
      sessionUserActionAnswer: async () => ({}),
      sessionModeSet: async () => ({}),
      sessionModesList: async () => ({ items: [] }),
      sessionTargetPrimarySet: async () => ({}),
      sessionTargetTrackedSet: async () => ({}),
      sessionList: async () => ({}),
      sessionActivityGet: async () => ({}),
      sessionRecentMessagesGet: async () => ({}),
      daemonMemorySearch: async () => ({ v: 1, ok: true as const, hits: [] }),
      daemonMemoryGetWindow: async () => ({ v: 1, snippets: [], citations: [] }),
      daemonMemoryEnsureUpToDate: async () => ({ ok: true }),
      resetGlobalVoiceAgent: async () => {},
    });

    const res = await executor.execute(
      'review.start',
      {
        sessionId: 's1',
        engineIds: ['codex'],
        instructions: 'Review this.',
        runLocation: 'current_session',
        permissionMode: 'safe-yolo',
        changeType: 'uncommitted',
        base: { kind: 'none' },
      },
      {
        surface: 'agent',
        defaultSessionId: 's1',
        callerPermissionMode: 'safe-yolo',
        agentStartContext: {
          caller: { kind: 'session', sessionId: 's1', starterDepth: 0, turnDepth: 0 },
          baseline: { machineId: 'machine-1', directory: '/repo' },
          ledSubtreeSessionIds: [], workDepthLimit: 4, roles: {}, callerPermissionCeiling: 'safe-yolo',
        },
      },
    );

    expect(res.ok).toBe(true);
    expect(executionRunStart).toHaveBeenCalledWith('s1', expect.objectContaining({ permissionMode: 'workspace_write' }), expect.any(Object));
  });

  it('starts a plugin Agent review through the detached host review run', async () => {
    const executionRunStart = vi.fn(async () => ({ runId: 'run_1', callId: 'call_1', sidechainId: 'call_1' }));
    const pluginAgentId = 'acme.review/reviewer';

    const executor = createActionExecutor({
      executionRunStart,
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
      reviewEnginesList: async () => ({ items: [{ value: pluginAgentId, label: 'Acme Reviewer' }] }),
      agentsBackendsList: async () => ({ items: [] }),
      agentsModelsList: async () => ({ items: [] }),
      sessionSendMessage: async () => ({}),
      sessionPermissionRespond: async () => ({}),
      sessionUserActionAnswer: async () => ({}),
      sessionModeSet: async () => ({}),
      sessionModesList: async () => ({ items: [] }),
      sessionTargetPrimarySet: async () => ({}),
      sessionTargetTrackedSet: async () => ({}),
      sessionList: async () => ({}),
      sessionActivityGet: async () => ({}),
      sessionRecentMessagesGet: async () => ({}),
      daemonMemorySearch: async () => ({ v: 1, ok: true as const, hits: [] }),
      daemonMemoryGetWindow: async () => ({ v: 1, snippets: [], citations: [] }),
      daemonMemoryEnsureUpToDate: async () => ({ ok: true }),
      resetGlobalVoiceAgent: async () => {},
    });

    const res = await executor.execute(
      'review.start' as any,
      {
        sessionId: 's1',
        engineIds: [pluginAgentId],
        instructions: 'Review this.',
        permissionMode: 'read_only',
        changeType: 'committed',
        base: { kind: 'none' },
      },
      { surface: 'ui', defaultSessionId: 's1' },
    );

    expect(res.ok).toBe(true);
    expect(executionRunStart).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({
        intent: 'review',
        backendTarget: { kind: 'builtInAgent', agentId: pluginAgentId },
        retentionPolicy: 'resumable',
        ioMode: 'streaming',
        intentInput: expect.objectContaining({ engineId: pluginAgentId }),
      }),
      {},
    );
  });

  it('starts a configured ACP review using its concrete inventory target', async () => {
    const executionRunStart = vi.fn(async () => ({ runId: 'run_acp', callId: 'call_acp', sidechainId: 'call_acp' }));
    const targetKey = 'backend:review-bot:configured:review-bot';
    const executor = createActionExecutor({
      executionRunStart,
      reviewEnginesList: async () => ({ items: [{ value: targetKey, label: 'Review Bot' }] }),
    } as ActionExecutorDeps);

    const result = await executor.execute('review.start', {
      sessionId: 's1', engineIds: [targetKey], instructions: 'Review this.',
    }, { surface: 'ui', defaultSessionId: 's1' });

    expect(result).toMatchObject({
      ok: true,
      result: { results: [{ key: targetKey, ok: true }] },
    });
    expect(executionRunStart).toHaveBeenCalledWith('s1', expect.objectContaining({
      intent: 'review',
      backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
      retentionPolicy: 'resumable',
    }), {});
  });

  it('marks malformed execution-run start payloads as failed fanout items', async () => {
    const executionRunStart = vi.fn(async () => ({ error: 'Unable to resolve a default base branch for CodeRabbit review.' }));

    const executor = createActionExecutor({
      executionRunStart,
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
      reviewEnginesList: async () => ({ items: [{ value: 'coderabbit', label: 'CodeRabbit' }] }),
      agentsBackendsList: async () => ({ items: [] }),
      agentsModelsList: async () => ({ items: [] }),
      sessionSendMessage: async () => ({}),
      sessionPermissionRespond: async () => ({}),
      sessionUserActionAnswer: async () => ({}),
      sessionModeSet: async () => ({}),
      sessionModesList: async () => ({ items: [] }),
      sessionTargetPrimarySet: async () => ({}),
      sessionTargetTrackedSet: async () => ({}),
      sessionList: async () => ({}),
      sessionActivityGet: async () => ({}),
      sessionRecentMessagesGet: async () => ({}),
      daemonMemorySearch: async () => ({ v: 1, ok: true as const, hits: [] }),
      daemonMemoryGetWindow: async () => ({ v: 1, snippets: [], citations: [] }),
      daemonMemoryEnsureUpToDate: async () => ({ ok: true }),
      resetGlobalVoiceAgent: async () => {},
    });

    const res = await executor.execute(
      'review.start' as any,
      {
        sessionId: 's1',
        engineIds: ['coderabbit'],
        instructions: 'Review this.',
        permissionMode: 'read_only',
        changeType: 'committed',
        base: { kind: 'none' },
      },
      { surface: 'ui', defaultSessionId: 's1' },
    );

    expect(res).toEqual({
      ok: true,
      result: {
        intent: 'review',
        sessionId: 's1',
        results: [
          {
            key: 'coderabbit',
            ok: false,
            error: 'Unable to resolve a default base branch for CodeRabbit review.',
            details: { executionRunStart: { v: 1, runCreation: 'outcomeUnknown' } },
          },
        ],
      },
    });
  });

  it('does not launch review runs for unavailable engines', async () => {
    const executionRunStart = vi.fn(async () => ({ runId: 'run_1', callId: 'call_1', sidechainId: 'call_1' }));

    const reviewEnginesList = vi.fn(async () => ({ items: [{ value: 'claude', label: 'Claude' }] }));

    const executor = createActionExecutor({
      executionRunStart,
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
      reviewEnginesList,
      agentsBackendsList: async () => ({ items: [] }),
      agentsModelsList: async () => ({ items: [] }),
      sessionSendMessage: async () => ({}),
      sessionPermissionRespond: async () => ({}),
      sessionUserActionAnswer: async () => ({}),
      sessionModeSet: async () => ({}),
      sessionModesList: async () => ({ items: [] }),
      sessionTargetPrimarySet: async () => ({}),
      sessionTargetTrackedSet: async () => ({}),
      sessionList: async () => ({}),
      sessionActivityGet: async () => ({}),
      sessionRecentMessagesGet: async () => ({}),
      daemonMemorySearch: async () => ({ v: 1, ok: true as const, hits: [] }),
      daemonMemoryGetWindow: async () => ({ v: 1, snippets: [], citations: [] }),
      daemonMemoryEnsureUpToDate: async () => ({ ok: true }),
      resetGlobalVoiceAgent: async () => {},
    });

    const res = await executor.execute(
      'review.start' as any,
      {
        sessionId: 's1',
        engineIds: ['coderabbit'],
        instructions: 'Review this.',
        permissionMode: 'read_only',
        changeType: 'committed',
        base: { kind: 'none' },
        selectedPaths: ['src/auth.ts'],
      },
      { surface: 'ui', defaultSessionId: 's1' },
    );

    expect(executionRunStart).not.toHaveBeenCalled();
    expect(reviewEnginesList).toHaveBeenCalledWith({
      sessionId: 's1',
      includeDisabled: false,
      scope: 'paths',
    });
    expect(res).toEqual({
      ok: true,
      result: {
        intent: 'review',
        sessionId: 's1',
        results: [
          {
            key: 'coderabbit',
            ok: false,
            errorCode: 'review_engine_unavailable',
            error: 'review_engine_unavailable',
            details: { executionRunStart: { v: 1, runCreation: 'noRunCreated' } },
          },
        ],
      },
    });
  });
});
