import { describe, expect, it } from 'vitest';
import { readBackendTargetRefV2 } from '@happier-dev/protocol';

import { buildExecutionRunProfileCatalog } from '@/agent/executionRuns/profiles/intentRegistry';
import type { VoiceAgentManager } from '@/agent/voice/agent/VoiceAgentManager';

import { applyExecutionRunAction } from './executionRunApplyAction';
import type { ExecutionRunState } from './executionRunTypes';
import type { ExecutionRunController } from '@/agent/executionRuns/controllers/types';
import { createTestExecutionRunHostRuntime } from './testkit';

function succeededRun(): ExecutionRunState {
  return {
    runId: 'run-1', callId: 'call-1', sidechainId: 'sidechain-1', sessionId: 'session-1', depth: 0,
    intent: 'review', profileId: 'acme.review/review',
    profileSourceCustody: { kind: 'managed', immutableGenerationId: 'immutable-review', installSource: 'archive' },
    backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, backendId: 'claude',
    instructions: 'Review.', permissionMode: 'read_only', retentionPolicy: 'ephemeral',
    runClass: 'bounded', ioMode: 'request_response', status: 'succeeded', startedAtMs: 1, finishedAtMs: 2,
    structuredMeta: { kind: 'review_findings.v2', payload: {
      runRef: { runId: 'run-1', callId: 'call-1', backendId: 'claude' },
      summary: 'One finding', overviewMarkdown: 'One finding', findings: [], questions: [], assumptions: [],
      proposedComments: [{ findingId: 'finding-1', body: 'Fix.', anchor: { kind: 'line', filePath: 'a.ts', line: 1 } }],
      generatedAtMs: 2,
    } },
  };
}

describe('applyExecutionRunAction review host action', () => {
  it('hands a live revalidating authority-free candidate to the host materializer', async () => {
    const run = succeededRun();
    const runs = new Map([[run.runId, run]]);
    const catalog = buildExecutionRunProfileCatalog([{
      pluginId: 'acme.review',
      sourceCustody: { kind: 'managed', immutableGenerationId: 'immutable-review', installSource: 'archive' },
      definition: {
        id: 'review', intent: 'review', title: 'Review', promptAsset: 'review-prompt', compatibleAgents: ['claude'],
        defaults: { retention: 'ephemeral', runClass: 'bounded', io: 'streaming' },
        actions: [{ kind: 'hostAction', actionId: 'reviews.comments.create' }],
      },
    }]);
    const captured: { readCurrent?: () => unknown } = {};

    const result = await applyExecutionRunAction({
      runId: run.runId,
      params: { actionId: 'reviews.comments.create' },
      runs,
      controllers: new Map(),
      voiceAgentManager: {} as VoiceAgentManager,
      startRun: async () => ({ runId: 'unused', callId: 'unused', sidechainId: 'unused' }),
      parentProvider: 'claude',
      profileCatalog: catalog,
      materializeReviewHostAction: async (read) => {
        captured.readCurrent = read;
        return { ok: true, result: { status: 'created', comments: [] } };
      },
    });

    expect(result).toEqual({ ok: true, result: { status: 'created', comments: [] } });
    expect(captured.readCurrent?.()).toEqual(expect.objectContaining({
      actionId: 'reviews.comments.create', sessionId: 'session-1', runId: 'run-1', callId: 'call-1',
      profileId: 'acme.review/review', pluginId: 'acme.review',
      agentId: 'claude',
      proposals: [expect.objectContaining({ findingId: 'finding-1' })],
    }));
    runs.set(run.runId, { ...run, sessionId: null });
    expect(captured.readCurrent?.()).toBeNull();
    runs.set(run.runId, { ...run, status: 'cancelled' });
    expect(captured.readCurrent?.()).toBeNull();
  });

  it('rejects retained proposals whose provider run reference names another backend', async () => {
    const baseRun = succeededRun();
    const run: ExecutionRunState = {
      ...baseRun,
      structuredMeta: { kind: 'review_findings.v2', payload: {
        runRef: { runId: baseRun.runId, callId: baseRun.callId, backendId: 'other-agent' },
        summary: 'One finding', overviewMarkdown: 'One finding', findings: [], questions: [], assumptions: [],
        proposedComments: [{ findingId: 'finding-1', body: 'Fix.', anchor: { kind: 'line', filePath: 'a.ts', line: 1 } }],
        generatedAtMs: 2,
      } },
    };
    const catalog = buildExecutionRunProfileCatalog([{
      pluginId: 'acme.review',
      sourceCustody: { kind: 'managed', immutableGenerationId: 'immutable-review', installSource: 'archive' },
      definition: {
        id: 'review', intent: 'review', title: 'Review', promptAsset: 'review-prompt', compatibleAgents: ['claude'],
        defaults: { retention: 'ephemeral', runClass: 'bounded', io: 'streaming' },
        actions: [{ kind: 'hostAction', actionId: 'reviews.comments.create' }],
      },
    }]);

    const result = await applyExecutionRunAction({
      runId: run.runId,
      params: { actionId: 'reviews.comments.create' },
      runs: new Map([[run.runId, run]]),
      controllers: new Map(),
      voiceAgentManager: {} as VoiceAgentManager,
      startRun: async () => ({ runId: 'unused', callId: 'unused', sidechainId: 'unused' }),
      parentProvider: 'claude',
      profileCatalog: catalog,
      materializeReviewHostAction: async (read) => read()
        ? { ok: true, result: { status: 'created', comments: [] } }
        : { ok: false, errorCode: 'execution_run_host_action_context_unavailable', error: 'Unavailable' },
    });

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'execution_run_host_action_context_unavailable',
    });
  });

  it('rejects retained proposals whose provider run reference names another backend target', async () => {
    const baseRun = succeededRun();
    const run: ExecutionRunState = {
      ...baseRun,
      structuredMeta: { kind: 'review_findings.v2', payload: {
        runRef: {
          runId: baseRun.runId,
          callId: baseRun.callId,
          backendId: baseRun.backendId,
          backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        },
        summary: 'One finding', overviewMarkdown: 'One finding', findings: [], questions: [], assumptions: [],
        proposedComments: [{ findingId: 'finding-1', body: 'Fix.', anchor: { kind: 'line', filePath: 'a.ts', line: 1 } }],
        generatedAtMs: 2,
      } },
    };
    const catalog = buildExecutionRunProfileCatalog([{
      pluginId: 'acme.review',
      sourceCustody: { kind: 'managed', immutableGenerationId: 'immutable-review', installSource: 'archive' },
      definition: {
        id: 'review', intent: 'review', title: 'Review', promptAsset: 'review-prompt', compatibleAgents: ['codex'],
        defaults: { retention: 'ephemeral', runClass: 'bounded', io: 'streaming' },
        actions: [{ kind: 'hostAction', actionId: 'reviews.comments.create' }],
      },
    }]);

    const result = await applyExecutionRunAction({
      runId: run.runId,
      params: { actionId: 'reviews.comments.create' },
      runs: new Map([[run.runId, run]]),
      controllers: new Map(),
      voiceAgentManager: {} as VoiceAgentManager,
      startRun: async () => ({ runId: 'unused', callId: 'unused', sidechainId: 'unused' }),
      parentProvider: 'claude',
      profileCatalog: catalog,
      materializeReviewHostAction: async (read) => read()
        ? { ok: true, result: { status: 'created', comments: [] } }
        : { ok: false, errorCode: 'execution_run_host_action_context_unavailable', error: 'Unavailable' },
    });

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'execution_run_host_action_context_unavailable',
    });
  });

  it('bounds materializer exceptions instead of rejecting the execution-run action', async () => {
    const run = succeededRun();
    const catalog = buildExecutionRunProfileCatalog([{
      pluginId: 'acme.review',
      sourceCustody: { kind: 'managed', immutableGenerationId: 'immutable-review', installSource: 'archive' },
      definition: {
        id: 'review', intent: 'review', title: 'Review', promptAsset: 'review-prompt', compatibleAgents: ['claude'],
        defaults: { retention: 'ephemeral', runClass: 'bounded', io: 'streaming' },
        actions: [{ kind: 'hostAction', actionId: 'reviews.comments.create' }],
      },
    }]);

    const result = await applyExecutionRunAction({
      runId: run.runId,
      params: { actionId: 'reviews.comments.create' },
      runs: new Map([[run.runId, run]]),
      controllers: new Map(),
      voiceAgentManager: {} as VoiceAgentManager,
      startRun: async () => ({ runId: 'unused', callId: 'unused', sidechainId: 'unused' }),
      parentProvider: 'claude',
      profileCatalog: catalog,
      materializeReviewHostAction: async () => {
        throw new Error('sensitive materializer failure');
      },
    });

    expect(result).toEqual({
      ok: false,
      errorCode: 'execution_run_host_action_failed',
      error: 'Review host-action materialization failed',
    });
  });
});

describe('applyExecutionRunAction review follow-up admission', () => {
  it.each([false, true])('admits an idle retained reviewer but keeps an active turn busy (in flight: %s)', async (turnInFlight) => {
    const resumeHandle = {
      kind: 'provider_session.v1' as const,
      backendTarget: readBackendTargetRefV2({ kind: 'builtInAgent', agentId: 'claude' }),
      providerSessionId: 'retained-review-session',
    };
    const controller: ExecutionRunController = {
      kind: 'backend', controllerOccurrenceId: 'current-review',
      backend: { ...createTestExecutionRunHostRuntime(), interaction: {
        kind: 'retained_agent_session.v1',
        capabilities: { open: ['create', 'resume'], delivery: ['newTurn'], cancel: true },
      } },
      backendSupportsResume: true, runtimeId: 'retained-review-session',
      buffer: '', sidechainStreamBuffer: '', sidechainStreamKey: '', streamWriter: null,
      cancelled: false, turnCount: 2, turnEpoch: 2, turnInFlight,
      turnCancelReason: null, turnCancelEpoch: null, admittedLiveInterventions: [],
      admittedLiveInterventionsSignal: null, lastMarkerWriteAtMs: 2,
      terminalPromise: Promise.resolve(), resolveTerminal: () => {},
    };
    const { result, started } = await followUp({
      ...succeededRun(), status: 'running', runClass: 'long_lived', ioMode: 'streaming',
      retentionPolicy: 'resumable', resumeHandle,
    }, controller);
    if (turnInFlight) {
      expect(result).toMatchObject({ ok: false, errorCode: 'execution_run_busy' });
      expect(started).toEqual([]);
    } else {
      expect(result).toMatchObject({ ok: true, result: { runId: 'follow-up' } });
      expect(started).toEqual([expect.objectContaining({ resumeHandle, parentRunId: 'run-1' })]);
    }
  });

  async function followUp(run: ExecutionRunState, controller?: ExecutionRunController, actionId = 'review.follow_up') {
    const started: unknown[] = [];
    const result = await applyExecutionRunAction({
      runId: run.runId,
      params: { actionId, input: actionId === 'review.new_round' ? {} : { messageMarkdown: 'Why?', findingIds: [] } },
      runs: new Map([[run.runId, run]]),
      controllers: new Map(controller ? [[run.runId, controller]] : []),
      voiceAgentManager: {} as VoiceAgentManager,
      // The child provider launch is the external execution boundary. Admission stays real.
      startRun: async (params) => {
        started.push(params);
        return { runId: 'follow-up', callId: 'follow-up-call', sidechainId: 'follow-up-sidechain' };
      },
      parentProvider: 'claude',
    });
    return { result, started };
  }

  it.each(['running', 'cancelled', 'failed', 'timeout'] as const)('refuses a %s review without launching a child', async (status) => {
    const { result, started } = await followUp({ ...succeededRun(), status });
    expect(result).toMatchObject({ ok: false, errorCode: status === 'running' ? 'execution_run_busy' : 'review_follow_up_ended' });
    expect(started).toEqual([]);
  });

  it.each([
    { status: 'running', retentionPolicy: 'ephemeral', code: 'execution_run_busy' },
    { status: 'succeeded', retentionPolicy: 'resumable', code: 'review_follow_up_resume_unavailable' },
  ] as const)('refuses native New round before preparation when $code', async ({ status, retentionPolicy, code }) => {
    const { result, started } = await followUp({ ...succeededRun(), status, retentionPolicy }, undefined, 'review.new_round');
    expect(result).toMatchObject({ ok: false, errorCode: code });
    expect(started).toEqual([]);
  });

  it('refuses a retiring controller even after a successful result', async () => {
    const controller: ExecutionRunController = {
      kind: 'voice_agent', controllerOccurrenceId: 'retiring', voiceAgentId: 'voice', cancelled: true,
      lastMarkerWriteAtMs: 2, terminalPromise: Promise.resolve(), resolveTerminal: () => {},
      transcript: { persistenceMode: 'ephemeral', epoch: 1 },
      externalStreamIdByInternal: new Map(), internalStreamIdByExternal: new Map(),
      pendingTranscriptTurnByExternalStreamId: new Map(), terminalReadByExternalStreamId: new Map(),
      readInFlightByExternalStreamId: new Map(),
    };
    const { result, started } = await followUp(succeededRun(), controller);
    expect(result).toMatchObject({ ok: false, errorCode: 'execution_run_busy' });
    expect(started).toEqual([]);
  });

  it('refuses the built-in-Agent fresh-child fallback for ephemeral reviews', async () => {
    const { result, started } = await followUp(succeededRun());
    expect(result).toMatchObject({ ok: false, errorCode: 'review_follow_up_not_resumable' });
    expect(started).toEqual([]);
  });

  it('refuses resumable reviews with no retained provider session', async () => {
    const { result, started } = await followUp({ ...succeededRun(), retentionPolicy: 'resumable' });
    expect(result).toMatchObject({ ok: false, errorCode: 'review_follow_up_resume_unavailable' });
    expect(started).toEqual([]);
  });

  it('refuses a retained handle for another Agent', async () => {
    const { result, started } = await followUp({
      ...succeededRun(), retentionPolicy: 'resumable',
      resumeHandle: {
        kind: 'provider_session.v1',
        backendTarget: readBackendTargetRefV2({ kind: 'builtInAgent', agentId: 'codex' }),
        providerSessionId: 'other-session',
      },
    });
    expect(result).toMatchObject({ ok: false, errorCode: 'review_follow_up_resume_unavailable' });
    expect(started).toEqual([]);
  });

  it('resumes a succeeded review through its exact retained provider session', async () => {
    const resumeHandle = {
      kind: 'provider_session.v1' as const,
      backendTarget: readBackendTargetRefV2({ kind: 'builtInAgent', agentId: 'claude' }),
      providerSessionId: 'retained-review-session',
    };
    const { result, started } = await followUp({ ...succeededRun(), retentionPolicy: 'resumable', resumeHandle });
    expect(result).toMatchObject({ ok: true, result: { runId: 'follow-up' } });
    expect(started).toEqual([expect.objectContaining({ resumeHandle, retentionPolicy: 'resumable', parentRunId: 'run-1' })]);
  });
});
