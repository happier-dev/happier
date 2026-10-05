import { describe, expect, it, vi } from 'vitest';

import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor';
import type { AgentStartContextV1 } from '../account/settings/admitAgentStartV1';
import { ActionIdSchema } from './actionIds';

const workflowStartContext: AgentStartContextV1 = {
  caller: { kind: 'originless', runId: 'workflow-1', runDepth: 0 },
  baseline: { machineId: 'machine-1', directory: '/repo' },
  ledSubtreeSessionIds: [], workDepthLimit: 4, roles: {}, callerPermissionCeiling: 'read-only',
};

describe('createActionExecutor (review.start)', () => {
  const narrationInventory = { items: [
    { value: 'codex', label: 'Codex', capabilities: { structuredNarration: true } },
    { value: 'claude', label: 'Claude', capabilities: { structuredNarration: true } },
    { value: 'coderabbit', label: 'CodeRabbit', capabilities: { structuredNarration: false } },
  ] };
  it('offers capable narrators without hiding findings-only reviewer choices', async () => {
    const executor = createActionExecutor({ reviewEnginesList: async () => narrationInventory } as ActionExecutorDeps);
    const narrator = await executor.execute('action.options.resolve', {
      actionId: 'review.start', fieldPath: 'narrator.engineId', sessionId: 's1',
    }, { surface: 'ui' });
    expect(narrator).toMatchObject({ ok: true, result: { options: [
      { value: 'codex' }, { value: 'claude' },
    ] } });
    const reviewers = await executor.execute('action.options.resolve', {
      actionId: 'review.start', fieldPath: 'engineIds', sessionId: 's1',
    }, { surface: 'ui' });
    expect(reviewers).toMatchObject({ ok: true, result: { options: [
      { value: 'codex' }, { value: 'claude' }, { value: 'coderabbit' },
    ] } });
  });
  it('retains one capable reviewer for its findings-first narration turn', async () => {
    const executionRunStart = vi.fn<ActionExecutorDeps['executionRunStart']>(async () => ({ runId: 'review-1', callId: 'call-1', sidechainId: 'call-1' }));
    const executionRunAction = vi.fn<ActionExecutorDeps['executionRunAction']>(async () => ({}));
    const executor = createActionExecutor({ executionRunStart, executionRunAction,
      reviewEnginesList: async () => narrationInventory } as ActionExecutorDeps);
    expect(await executor.execute('review.start', { sessionId: 's1', engineIds: ['codex'], instructions: 'Review.',
      outputs: ['walkthrough'], comparisonId: 'comparison-1' }, { surface: 'ui' })).toMatchObject({
      ok: true, result: { narration: { runId: 'review-1', state: 'collecting' } },
    });
    expect(executionRunStart.mock.calls[0]?.[1]).toMatchObject({ runClass: 'long_lived',
      intentInput: { outputs: ['walkthrough'], comparisonId: 'comparison-1', narrator: { engineId: 'codex' } } });
    expect(executionRunAction).not.toHaveBeenCalled();
  });
  it('fans out bounded reviews then admits one narrator from only confirmed runs and launch provenance', async () => {
    const executionRunStart = vi.fn<ActionExecutorDeps['executionRunStart']>(async (_session, input) =>
      input.backendTarget?.kind === 'builtInAgent' && input.backendTarget.agentId === 'claude'
        ? { ok: false, errorCode: 'engine_failed', error: 'Engine failed' }
        : { runId: 'review-1', callId: 'call-1', sidechainId: 'call-1' });
    const executionRunAction = vi.fn<ActionExecutorDeps['executionRunAction']>(async () => ({ ok: true, data: { ok: true, result: {
      runId: 'narrator-1', comparisonId: 'comparison-1', mode: 'seeded_narrator', state: 'collecting',
    } } }));
    const executor = createActionExecutor({ executionRunStart, executionRunAction,
      reviewEnginesList: async () => narrationInventory } as ActionExecutorDeps);
    const result = await executor.execute('review.start', { sessionId: 's1', engineIds: ['codex', 'claude'], instructions: 'Review.',
      outputs: ['walkthrough'], comparisonId: 'comparison-1' }, { surface: 'ui' });
    expect(result).toMatchObject({ ok: true, result: { narration: { runId: 'narrator-1', state: 'collecting' } } });
    expect(executionRunStart.mock.calls.every((call) => call[1].runClass === 'bounded')).toBe(true);
    expect(executionRunStart.mock.calls.every((call) => call[1].intentInput?.outputs === undefined)).toBe(true);
    expect(executionRunAction.mock.calls).toHaveLength(1);
    expect(executionRunAction.mock.calls[0]?.slice(0, 2)).toEqual(['s1', { runId: 'review-1', actionId: 'review.walkthrough', input: {
      reviewRunIds: ['review-1'], comparisonId: 'comparison-1', narrator: { engineId: 'codex' },
      launchFailures: [{ engineId: 'claude', errorCode: 'engine_failed', error: 'Engine failed' }],
    } }]);
  });
  it('preserves explicit narrator model selection without replacing the original reviewer model', async () => {
    const executionRunStart = vi.fn<ActionExecutorDeps['executionRunStart']>(async () => ({ runId: 'review-1', callId: 'call-1', sidechainId: 'call-1' }));
    const executionRunAction = vi.fn<ActionExecutorDeps['executionRunAction']>(async () => ({ ok: true, result: {
      runId: 'narrator-1', comparisonId: 'comparison-1', mode: 'seeded_narrator', state: 'collecting',
    } }));
    const executor = createActionExecutor({ executionRunStart, executionRunAction,
      reviewEnginesList: async () => narrationInventory } as ActionExecutorDeps);
    expect(await executor.execute('review.start', { sessionId: 's1', engineIds: ['codex'], instructions: 'Review.',
      modelId: 'review-model', outputs: ['walkthrough'], comparisonId: 'comparison-1',
      narrator: { engineId: 'codex', modelId: 'narration-model' } }, { surface: 'ui' }))
      .toMatchObject({ ok: true, result: { narration: { runId: 'narrator-1' } } });
    expect(executionRunStart.mock.calls[0]?.[1]).toMatchObject({ runClass: 'bounded', modelId: 'review-model' });
    expect(executionRunAction.mock.calls[0]?.[1].input).toMatchObject({ narrator: { engineId: 'codex', modelId: 'narration-model' } });
  });
  it.each([
    { engineIds: ['codex'] },
    { engineIds: ['coderabbit'], comparisonId: 'comparison-1' },
    { engineIds: ['codex'], comparisonId: 'comparison-1', narrator: { engineId: 'coderabbit' } },
  ])('rejects invalid narration before any reviewer starts: %j', async (selection) => {
    const executionRunStart = vi.fn<ActionExecutorDeps['executionRunStart']>(async () => ({}));
    const executor = createActionExecutor({ executionRunStart, reviewEnginesList: async () => narrationInventory } as ActionExecutorDeps);
    expect(await executor.execute('review.start', { sessionId: 's1', instructions: 'Review.', outputs: ['walkthrough'],
      ...selection }, { surface: 'ui' })).toMatchObject({ ok: false });
    expect(executionRunStart).not.toHaveBeenCalled();
  });
  it('keeps failed reviewer launches truthful and does not create narration without a confirmed run', async () => {
    const executionRunAction = vi.fn<ActionExecutorDeps['executionRunAction']>(async () => ({}));
    const executor = createActionExecutor({ executionRunAction,
      executionRunStart: async () => ({ ok: false, errorCode: 'engine_failed', error: 'Engine failed' }),
      reviewEnginesList: async () => narrationInventory } as ActionExecutorDeps);
    expect(await executor.execute('review.start', { sessionId: 's1', engineIds: ['codex', 'claude'], instructions: 'Review.',
      outputs: ['walkthrough'], comparisonId: 'comparison-1' }, { surface: 'ui' })).toMatchObject({
      ok: true, result: { results: [{ ok: false }, { ok: false }], narration: { state: 'failed' } },
    });
    expect(executionRunAction).not.toHaveBeenCalled();
  });
  it('routes finished-review narration and targeted explanation through the existing Run Action authority', async () => {
    const executionRunAction = vi.fn<ActionExecutorDeps['executionRunAction']>(async (_sessionId, request) => request.actionId === 'review.explain_findings'
      ? { ok: true, result: { refinement: { actionId: 'scm.diffSummary.refine', input: {
        cwd: '/repo', resultId: 'result-1', expectedRevision: 2, output: 'walkthrough', stopIds: ['stop-1'], instructions: 'Explain selected finding.',
      } } } } : { ok: true, runId: 'narrator-1' });
    const executor = createActionExecutor({ executionRunAction,
      scmActionExecute: async () => ({ success: false, errorCode: 'revision_conflict', error: 'Saved result changed', latestRevision: 3 }),
    } as ActionExecutorDeps);
    const walkthrough = await executor.execute(ActionIdSchema.parse('review.walkthrough'), {
      sessionId: 's1', runId: 'review-1', comparisonId: 'comparison-1',
    }, { surface: 'cli' });
    expect(walkthrough).toMatchObject({ ok: true });
    expect(executionRunAction.mock.calls[0]?.slice(0, 2)).toEqual(['s1', { runId: 'review-1', actionId: 'review.walkthrough',
      input: { reviewRunIds: ['review-1'], comparisonId: 'comparison-1' } }]);
    const explanation = await executor.execute(ActionIdSchema.parse('review.explain_findings'), {
      runId: 'review-1', cwd: '/repo', resultId: 'result-1', expectedRevision: 2,
      findingIds: [{ runId: 'review-1', findingId: 'finding-1' }],
    }, { surface: 'mcp', defaultSessionId: 's1' });
    expect(explanation).toMatchObject({ ok: true, result: { success: false, errorCode: 'revision_conflict', latestRevision: 3 } });
    expect(executionRunAction.mock.calls[1]?.slice(0, 2)).toEqual(['s1', { runId: 'review-1', actionId: 'review.explain_findings', input: {
      reviewRunIds: ['review-1'], cwd: '/repo', resultId: 'result-1', expectedRevision: 2,
      findingIds: [{ runId: 'review-1', findingId: 'finding-1' }],
    } }]);
  });
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
