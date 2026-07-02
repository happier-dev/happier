import { describe, expect, it, vi } from 'vitest';

import type { AgentBackend, AgentMessage, AgentMessageHandler, SessionId } from '@/agent/core/AgentBackend';
import type { ACPMessageData } from '@/api/session/sessionMessageTypes';
import type { ExecutionRunController } from '@/agent/executionRuns/controllers/types';
import { createExecutionRunHostRuntimeFromAgentBackend } from '@/agent/runtime/bridges/executionRun/testkit';
import { executeBoundedBackendRun } from './bounded/loop';
import { startExecutionRun } from './startExecutionRun';
import type { ExecutionRunState } from './executionRunTypes';
import type { ExecutionRunStructuredMeta } from '@/agent/executionRuns/profiles/ExecutionRunIntentProfile';
import { VoiceAgentManager } from '@/agent/voice/agent/VoiceAgentManager';
import { ExecutionBudgetRegistry } from '@/daemon/executionBudget/ExecutionBudgetRegistry';

const TEST_BACKEND_ID = `${'summary'}.${'backend'}` as never;

type AcpCommittedMessage = {
  body: Extract<ACPMessageData, { type: 'message' }>;
  localId: string;
  meta?: Record<string, unknown>;
};

function isAcpCommittedMessage(row: {
  body: ACPMessageData;
  localId: string;
  meta?: Record<string, unknown>;
}): row is AcpCommittedMessage {
  return row.body.type === 'message';
}

function createScmDiffSummaryStreamingBackend(): AgentBackend {
  let handler: AgentMessageHandler | null = null;
  const sessionId: SessionId = 'child_session_1' as SessionId;
  const finalJson = JSON.stringify({
    summaryMarkdown: '## Summary\n\nChanged src/a.ts.',
    risks: ['Shared worktree attribution.'],
    testImpact: 'Unit tests.',
  });

  return {
    async startSession(): Promise<{ sessionId: SessionId }> {
      return { sessionId };
    },
    async sendPrompt(): Promise<void> {
      handler?.({ type: 'model-output', fullText: 'Inspecting checkpoint diff evidence...\n' } as AgentMessage);
      handler?.({ type: 'model-output', fullText: finalJson } as AgentMessage);
    },
    async cancel(): Promise<void> {},
    onMessage(next: AgentMessageHandler): void {
      handler = next;
    },
    async dispose(): Promise<void> {},
    async waitForResponseComplete(): Promise<void> {},
  };
}

function createProvisioningBackend(): AgentBackend {
  return {
    async startSession(): Promise<{ sessionId: SessionId }> {
      return { sessionId: 'child_session_1' as SessionId };
    },
    async sendPrompt(): Promise<void> {},
    async cancel(): Promise<void> {},
    onMessage(): void {},
    async dispose(): Promise<void> {},
    async waitForResponseComplete(): Promise<void> {},
  };
}

describe('startExecutionRun', () => {
  it('finishes cached SCM diff-summary runs without creating a backend runtime', async () => {
    const runs = new Map<string, ExecutionRunState>();
    const controllers = new Map<string, ExecutionRunController>();
    const finishRun = vi.fn((runId: string, next, toolResult, structuredMeta?: ExecutionRunStructuredMeta) => {
      const current = runs.get(runId);
      if (!current) return;
      runs.set(runId, {
        ...current,
        ...next,
        latestToolResult: toolResult.output,
        ...(structuredMeta ? { structuredMeta } : {}),
      });
    });
    const voiceAgentManager = new VoiceAgentManager({
      createRuntime: () => {
        throw new Error('voice runtime should not be used by scm_diff_summary runs');
      },
    });

    try {
      const createRuntime = vi.fn(() => createExecutionRunHostRuntimeFromAgentBackend(createProvisioningBackend()));
      const started = await startExecutionRun({
        params: {
          sessionId: 'session_1',
          intent: 'scm_diff_summary',
          backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
          instructions: 'SCM diff summary cache hit; no generation required.',
          intentInput: {
            cachedOutput: {
              success: true,
              summaryMarkdown: '## Summary\n\nCached checkpoint.',
              sourceKey: 'turnCheckpoint:turn_1:checkpoint.diff_computed',
              checkpointReceiptId: 'checkpoint.diff_computed',
              metadata: {
                source: { kind: 'turnCheckpoint' },
                sourceKey: 'turnCheckpoint:turn_1:checkpoint.diff_computed',
                checkpointReceiptId: 'checkpoint.diff_computed',
              },
            },
          },
          permissionMode: 'read_only',
          retentionPolicy: 'ephemeral',
          runClass: 'bounded',
          ioMode: 'streaming',
        },
        parentProvider: TEST_BACKEND_ID,
        sendAcp: () => {},
        streamedTranscriptSession: null,
        createRuntime,
        getNowMs: () => 1_700_000_000_000,
        budgetRegistry: null,
        runs,
        controllers,
        enqueueMarkerWrite: async () => {},
        writeActivityMarker: async () => {},
        finishRun,
        executeBoundedRun: async () => {
          throw new Error('cached diff summary should not execute bounded generation');
        },
        send: async () => ({ ok: true }),
        voiceAgentManager,
        getDepthByCallId: () => null,
      });

      expect(createRuntime).not.toHaveBeenCalled();
      expect(finishRun).toHaveBeenCalledTimes(1);
      expect(runs.get(started.runId)).toMatchObject({
        status: 'succeeded',
        latestToolResult: {
          success: true,
          summaryMarkdown: '## Summary\n\nCached checkpoint.',
        },
        structuredMeta: {
          kind: 'scm_diff_summary.v1',
          payload: {
            success: true,
            summaryMarkdown: '## Summary\n\nCached checkpoint.',
          },
        },
      });
    } finally {
      await voiceAgentManager.dispose();
    }
  });

  it('starts fresh SCM diff-summary generation when cache bypass is requested', async () => {
    const runs = new Map<string, ExecutionRunState>();
    const controllers = new Map<string, ExecutionRunController>();
    const voiceAgentManager = new VoiceAgentManager({
      createRuntime: () => {
        throw new Error('voice runtime should not be used by scm_diff_summary runs');
      },
    });

    try {
      const createRuntime = vi.fn(() => createExecutionRunHostRuntimeFromAgentBackend(createProvisioningBackend()));
      const executeBoundedRun = vi.fn(async () => {});
      await startExecutionRun({
        params: {
          sessionId: 'session_1',
          intent: 'scm_diff_summary',
          backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
          instructions: 'Regenerate the checkpoint summary.',
          intentInput: {
            cachePolicy: { mode: 'bypass' },
            cachedOutput: {
              success: true,
              summaryMarkdown: '## Summary\n\nStale cached checkpoint.',
              sourceKey: 'turnCheckpoint:turn_1:checkpoint.diff_computed',
              checkpointReceiptId: 'checkpoint.diff_computed',
              metadata: {
                source: { kind: 'turnCheckpoint' },
                sourceKey: 'turnCheckpoint:turn_1:checkpoint.diff_computed',
                checkpointReceiptId: 'checkpoint.diff_computed',
              },
            },
          },
          permissionMode: 'read_only',
          retentionPolicy: 'ephemeral',
          runClass: 'bounded',
          ioMode: 'streaming',
        },
        parentProvider: TEST_BACKEND_ID,
        sendAcp: () => {},
        streamedTranscriptSession: null,
        createRuntime,
        getNowMs: () => 1_700_000_000_000,
        budgetRegistry: null,
        runs,
        controllers,
        enqueueMarkerWrite: async () => {},
        writeActivityMarker: async () => {},
        finishRun: () => {},
        executeBoundedRun,
        send: async () => ({ ok: true }),
        voiceAgentManager,
        getDepthByCallId: () => null,
      });

      expect(createRuntime).toHaveBeenCalledTimes(1);
      await vi.waitFor(() => {
        expect(executeBoundedRun).toHaveBeenCalledTimes(1);
      });
    } finally {
      await voiceAgentManager.dispose();
    }
  });

  it('charges scm_commit_message execution runs to the shared one-shot budget', async () => {
    const budgetRegistry = new ExecutionBudgetRegistry({
      maxConcurrentExecutionRuns: null,
      maxConcurrentOneShotTasks: 1,
    });
    const runs = new Map<string, ExecutionRunState>();
    const controllers = new Map<string, ExecutionRunController>();
    const voiceAgentManager = new VoiceAgentManager({
      createRuntime: () => {
        throw new Error('voice runtime should not be used by scm_commit_message runs');
      },
    });

    const startArgs = {
      params: {
        sessionId: 'parent_session_1',
        intent: 'scm_commit_message',
        backendTarget: { kind: 'builtInAgent', agentId: TEST_BACKEND_ID },
        permissionMode: 'no_tools',
        retentionPolicy: 'ephemeral',
        runClass: 'bounded',
        ioMode: 'request_response',
      },
      parentProvider: TEST_BACKEND_ID,
      sendAcp: () => {},
      streamedTranscriptSession: null,
      createRuntime: () => createExecutionRunHostRuntimeFromAgentBackend(createProvisioningBackend()),
      getNowMs: () => 1_700_000_000_000,
      budgetRegistry,
      runs,
      controllers,
      enqueueMarkerWrite: async () => {},
      writeActivityMarker: async () => {},
      finishRun: () => {},
      executeBoundedRun: async () => {},
      send: async () => ({ ok: true }),
      voiceAgentManager,
      getDepthByCallId: () => null,
    } as const;

    try {
      const first = await startExecutionRun(startArgs);
      expect(first.runId).toMatch(/^run_/);
      expect(budgetRegistry.getInFlightSnapshot()).toEqual({
        executionRuns: 0,
        oneShotTasks: 1,
      });

      await expect(startExecutionRun(startArgs)).rejects.toMatchObject({
        code: 'execution_run_budget_exceeded',
      });
    } finally {
      for (const runId of runs.keys()) {
        budgetRegistry.releaseExecutionRun(runId);
      }
      await voiceAgentManager.dispose();
    }
  });

  it('streams scm_diff_summary progress while keeping summaryMarkdown buffered as final output', async () => {
    const runs = new Map<string, ExecutionRunState>();
    const controllers = new Map<string, ExecutionRunController>();
    const sent: Array<{ body: ACPMessageData; meta?: Record<string, unknown> }> = [];
    const commits: Array<{ body: ACPMessageData; localId: string; meta?: Record<string, unknown> }> = [];
    const voiceAgentManager = new VoiceAgentManager({
      createRuntime: () => {
        throw new Error('voice runtime should not be used by scm_diff_summary runs');
      },
    });
    let finishResolve!: () => void;
    const finished = new Promise<void>((resolve) => {
      finishResolve = resolve;
    });

    try {
      const started = await startExecutionRun({
        params: {
          sessionId: 'parent_session_1',
          intent: 'scm_diff_summary',
          backendTarget: { kind: 'builtInAgent', agentId: TEST_BACKEND_ID },
          instructions: 'Summarize the checkpoint.',
          intentInput: {
            cwd: '/repo',
            source: { kind: 'turnCheckpoint' },
            sourceKey: 'turnCheckpoint:turn_1:checkpoint.diff_computed',
            checkpointReceiptId: 'checkpoint.diff_computed',
            metadata: {
              source: { kind: 'turnCheckpoint' },
              sourceKey: 'turnCheckpoint:turn_1:checkpoint.diff_computed',
              turnId: 'turn_1',
              checkpointReceiptId: 'checkpoint.diff_computed',
              contentConfidence: 'exact',
              attributionScope: 'shared_worktree',
            },
          },
          permissionMode: 'read_only',
          retentionPolicy: 'ephemeral',
          runClass: 'bounded',
          ioMode: 'streaming',
        },
        parentProvider: TEST_BACKEND_ID,
        sendAcp: (_provider, body, opts) => {
          sent.push({ body, meta: opts?.meta });
        },
        streamedTranscriptSession: {
          sendAgentMessageCommitted: async (_provider, body, opts) => {
            commits.push({ body, localId: opts.localId, meta: opts.meta });
          },
        },
        createRuntime: () => createExecutionRunHostRuntimeFromAgentBackend(createScmDiffSummaryStreamingBackend()),
        getNowMs: () => 1_700_000_000_000,
        budgetRegistry: null,
        runs,
        controllers,
        enqueueMarkerWrite: async () => {},
        writeActivityMarker: async () => {},
        finishRun: (runId, next, toolResult, structuredMeta?: ExecutionRunStructuredMeta) => {
          const current = runs.get(runId);
          if (current) {
            runs.set(runId, {
              ...current,
              ...next,
              latestToolResult: toolResult.output,
              ...(structuredMeta ? { structuredMeta } : {}),
            });
          }
          finishResolve();
        },
        executeBoundedRun: (args) =>
          executeBoundedBackendRun({
            ...args,
            controllers,
            sendAcp: (_provider, body, opts) => {
              sent.push({ body, meta: opts?.meta });
            },
            parentProvider: TEST_BACKEND_ID,
            getNowMs: () => 1_700_000_000_001,
            boundedTimeoutMs: null,
            finishRun: (runId, next, toolResult, structuredMeta) => {
              const current = runs.get(runId);
              if (current) {
                runs.set(runId, {
                  ...current,
                  ...next,
                  latestToolResult: toolResult.output,
                  ...(structuredMeta ? { structuredMeta } : {}),
                });
              }
              finishResolve();
            },
          }),
        send: async () => ({ ok: true }),
        voiceAgentManager,
        getDepthByCallId: () => null,
      });

      await finished;

      const finalRun = runs.get(started.runId);
      expect(finalRun?.status).toBe('succeeded');
      expect(finalRun?.latestToolResult).toMatchObject({
        success: true,
        summaryMarkdown: '## Summary\n\nChanged src/a.ts.',
      });

      const sidechainCommits = commits.filter(
        (row): row is AcpCommittedMessage => isAcpCommittedMessage(row) && row.body.sidechainId === started.sidechainId,
      );
      expect(sidechainCommits.length).toBeGreaterThanOrEqual(1);
      const streamedText = sidechainCommits
        .map((row) => row.body.message)
        .join('');
      expect(streamedText).toContain('Inspecting checkpoint diff evidence');
      expect(streamedText).not.toContain('## Summary');
      expect(sidechainCommits[0]?.meta?.happierStreamSegmentV1).toMatchObject({ segmentState: 'streaming' });
      expect(sidechainCommits.at(-1)?.meta?.happierStreamSegmentV1).toMatchObject({ segmentState: 'complete' });

      const nonStreamingMessages = sent.filter(
        (row) => row.body.type === 'message' && row.body.sidechainId === started.sidechainId,
      );
      expect(nonStreamingMessages).toHaveLength(0);
    } finally {
      await voiceAgentManager.dispose();
    }
  });
});
