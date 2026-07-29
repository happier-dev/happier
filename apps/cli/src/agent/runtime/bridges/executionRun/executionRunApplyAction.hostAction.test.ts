import { describe, expect, it } from 'vitest';

import { buildExecutionRunProfileCatalog } from '@/agent/executionRuns/profiles/intentRegistry';
import type { VoiceAgentManager } from '@/agent/voice/agent/VoiceAgentManager';

import { applyExecutionRunAction } from './executionRunApplyAction';
import type { ExecutionRunState } from './executionRunTypes';

function succeededRun(): ExecutionRunState {
  return {
    runId: 'run-1', callId: 'call-1', sidechainId: 'sidechain-1', sessionId: 'session-1', depth: 0,
    intent: 'review', profileId: 'acme.review/review',
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
      sendAcp: () => undefined,
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
      sendAcp: () => undefined,
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
      sendAcp: () => undefined,
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
      sendAcp: () => undefined,
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
