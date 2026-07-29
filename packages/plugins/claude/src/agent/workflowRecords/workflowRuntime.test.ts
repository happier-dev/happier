import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type {
  SessionMetadataWriteRequestV1,
  SessionSystemRecordReadRequestV1,
  SessionSystemRecordReadResultV1,
  SessionSystemRecordWriteRequestV1,
} from '@happier-dev/plugin-sdk/experimental/sessions';
import type {
  AgentTranscriptFileFollowHandle as TranscriptFileFollowHandleV1,
  AgentTranscriptFileFollowInput as TranscriptFileFollowInputV1,
} from '@happier-dev/plugin-sdk/agent-runtime';

import { createClaudeUnifiedWorkflowRuntime } from './workflowRuntime.js';

/**
 * Integration test for the live bind: observing a workflow transcript row through the runtime must
 * write a durable `activity/workflow_run.v1` system record FIRST (host `writeSystemRecord`) and the
 * compact `sessionWorkflowActivityHeadlineV1` metadata headline SECOND (`writeMetadata`).
 */

function workflowToolUse(params: Readonly<{ id: string; name: string }>): unknown {
  return {
    type: 'assistant',
    session_id: 'claude-session-1',
    uuid: `uuid-${params.id}`,
    message: {
      content: [{
        type: 'tool_use',
        id: params.id,
        name: 'Workflow',
        input: {
          script: `export const meta = { name: '${params.name}', phases: [{ title: 'Verify' }] }`,
        },
      }],
    },
  };
}

function workflowLaunchResult(params: Readonly<{
  toolUseId: string;
  transcriptDir: string;
  providerRunId?: string;
}>): unknown {
  return {
    type: 'user',
    session_id: 'claude-session-1',
    uuid: 'uuid-launch',
    message: {
      content: [{
        type: 'tool_result',
        tool_use_id: params.toolUseId,
        content: `Workflow launched in background.\nTranscript dir: ${params.transcriptDir}`,
      }],
    },
    toolUseResult: {
      status: 'async_launched',
      taskId: 'workflow-task-1',
      taskType: 'local_workflow',
      workflowName: 'Implement Feature',
      transcriptDir: params.transcriptDir,
      ...(params.providerRunId ? { runId: params.providerRunId } : {}),
    },
  };
}

function successfulWorkflowTaskStop(taskId: string): unknown {
  return {
    type: 'user',
    session_id: 'claude-session-1',
    message: {
      content: [{
        type: 'tool_result',
        tool_use_id: 'toolu_task_stop',
        is_error: false,
        content: `Successfully stopped task: ${taskId}`,
      }],
    },
    toolUseResult: {
      message: `Successfully stopped task: ${taskId}`,
      task_id: taskId,
      task_type: 'local_workflow',
    },
  };
}

function taskProgress(params: Readonly<{ toolUseId: string; workflowProgress: unknown[] }>): unknown {
  return {
    type: 'system',
    subtype: 'task_progress',
    task_id: 'w1',
    tool_use_id: params.toolUseId,
    task_type: 'local_workflow',
    session_id: 'claude-session-1',
    workflow_progress: params.workflowProgress,
    uuid: 'uuid-progress',
  };
}

function taskStarted(params: Readonly<{ toolUseId: string; taskId: string }>): unknown {
  return {
    type: 'system',
    subtype: 'task_started',
    task_id: params.taskId,
    tool_use_id: params.toolUseId,
    task_type: 'local_workflow',
    session_id: 'claude-session-1',
  };
}

function taskUpdatedCompleted(params: Readonly<{ taskId: string }>): unknown {
  return {
    type: 'system',
    subtype: 'task_updated',
    task_id: params.taskId,
    patch: { status: 'completed' },
    session_id: 'claude-session-1',
  };
}

const TWO_AGENT_PROGRESS: unknown[] = [
  { type: 'workflow_phase', index: 1, title: 'Research' },
  { type: 'workflow_phase', index: 2, title: 'Implementation' },
  { type: 'workflow_agent', agentId: 'agent_1', label: 'web_search', phaseIndex: 1, phaseTitle: 'Research', state: 'done' },
  { type: 'workflow_agent', agentId: 'agent_2', label: 'coder', phaseIndex: 2, phaseTitle: 'Implementation', state: 'running' },
];

function subagentTask(params: Readonly<{ id: string; parentToolUseId: string }>): unknown {
  return {
    type: 'assistant',
    session_id: 'claude-session-1',
    parent_tool_use_id: params.parentToolUseId,
    uuid: `uuid-${params.id}`,
    message: {
      content: [{
        type: 'tool_use',
        id: params.id,
        name: 'Task',
        input: { description: 'do work', subagent_type: 'general-purpose' },
      }],
    },
  };
}

type SystemRecordCall = SessionSystemRecordWriteRequestV1;

function applyMetadataWrite(
  current: Record<string, unknown>,
  request: SessionMetadataWriteRequestV1,
): Record<string, unknown> {
  if (request.kind === 'set') return { ...request.metadata };
  return { ...request.handler(current) };
}

async function waitForCondition(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => {
      setTimeout(resolve, 5);
    });
  }
  throw new Error('condition was not met');
}

describe('createClaudeUnifiedWorkflowRuntime live bind', () => {
  it('forwards exact live Workflow provider-task terminals through the existing callback', async () => {
    const providerTaskActivities: unknown[] = [];
    const runtime = createClaudeUnifiedWorkflowRuntime({
      backendId: 'claude',
      agentId: 'claude',
      getCurrentClaudeSessionId: () => 'claude-session-1',
      debounceMs: 0,
      writeSystemRecord: async () => {},
      writeMetadata: async () => {},
      onProviderTaskActivity: async (activity) => {
        providerTaskActivities.push(activity);
      },
    });

    runtime.observeTranscriptMessage(workflowToolUse({ id: 'wf-tool-1', name: 'Implement Feature' }));
    runtime.observeTranscriptMessage(workflowLaunchResult({
      toolUseId: 'wf-tool-1',
      transcriptDir: '/tmp/happier-workflow/workflow-provider-run',
      providerRunId: 'workflow-provider-run',
    }));
    runtime.observeTranscriptMessage(successfulWorkflowTaskStop('workflow-task-1'));
    await runtime.flush();

    expect(providerTaskActivities).toContainEqual({
      type: 'terminal',
      terminalStatus: 'stopped',
      sessionId: 'claude-session-1',
      taskId: 'workflow-task-1',
    });
    runtime.dispose();
  });

  it('does not publish provider-task activity from historical Workflow reconstruction', async () => {
    const providerTaskActivities: unknown[] = [];
    const runtime = createClaudeUnifiedWorkflowRuntime({
      backendId: 'claude',
      agentId: 'claude',
      getCurrentClaudeSessionId: () => 'claude-session-1',
      debounceMs: 0,
      writeSystemRecord: async () => {},
      writeMetadata: async () => {},
      onProviderTaskActivity: async (activity) => {
        providerTaskActivities.push(activity);
      },
    });

    runtime.observeTranscriptMessage(
      workflowToolUse({ id: 'wf-tool-1', name: 'Implement Feature' }),
      { historicalReplay: true },
    );
    runtime.observeTranscriptMessage(
      workflowLaunchResult({
        toolUseId: 'wf-tool-1',
        transcriptDir: '/tmp/happier-workflow/workflow-provider-run',
        providerRunId: 'workflow-provider-run',
      }),
      { historicalReplay: true },
    );
    runtime.observeTranscriptMessage(
      successfulWorkflowTaskStop('workflow-task-1'),
      { historicalReplay: true },
    );
    await runtime.flush();

    expect(providerTaskActivities).toEqual([]);
    runtime.dispose();
  });

  it('writes a workflow run system record FIRST and the headline metadata SECOND', async () => {
    const order: string[] = [];
    const systemRecordCalls: SystemRecordCall[] = [];
    let metadata: Record<string, unknown> = {};

    const runtime = createClaudeUnifiedWorkflowRuntime({
      backendId: 'claude',
      agentId: 'claude',
      getCurrentClaudeSessionId: () => 'claude-session-1',
      debounceMs: 0,
      writeSystemRecord: async (request) => {
        order.push(`record:${request.localId}`);
        systemRecordCalls.push(request);
      },
      writeMetadata: async (request) => {
        order.push('headline');
        metadata = applyMetadataWrite(metadata, request);
      },
    });

    runtime.observeTranscriptMessage(workflowToolUse({ id: 'wf-tool-1', name: 'Implement Feature' }));
    runtime.observeTranscriptMessage(taskProgress({
      toolUseId: 'wf-tool-1',
      workflowProgress: TWO_AGENT_PROGRESS,
    }));
    await runtime.flush();

    // Record FIRST, headline SECOND.
    expect(order[0]?.startsWith('record:')).toBe(true);
    expect(order[order.length - 1]).toBe('headline');
    expect(order.indexOf('headline')).toBeGreaterThan(0);

    // The durable record targets the activity namespace + workflow_run kind, keyed by run id.
    expect(systemRecordCalls.length).toBeGreaterThan(0);
    const lastRecord = systemRecordCalls[systemRecordCalls.length - 1]!;
    expect(lastRecord.namespace).toBe('activity');
    expect(lastRecord.kind).toBe('workflow_run.v1');
    expect(lastRecord.localId).toContain('wf-tool-1');

    // The headline rides the LOCKED metadata key and carries no full workflow detail (count-only).
    const headline = metadata.sessionWorkflowActivityHeadlineV1 as
      | { activeRuns: Array<{ runId: string; totalAgents: number }>; primaryRunId?: string | null }
      | undefined;
    expect(headline).toBeDefined();
    expect(headline?.activeRuns.length).toBe(1);
    expect(headline?.activeRuns[0]?.totalAgents).toBe(2);
    expect(headline?.primaryRunId).toBe('wf-tool-1');
    // The headline never embeds agent/phase detail.
    expect(JSON.stringify(headline)).not.toContain('Research');
  });

  it('seeds durable record revision state through the host system-record reader after runtime restart', async () => {
    const systemRecordCalls: SystemRecordCall[] = [];
    const readSystemRecord = vi.fn(async (
      request: SessionSystemRecordReadRequestV1,
    ): Promise<SessionSystemRecordReadResultV1 | null> => request.localId.includes('wf-tool-1')
      ? {
          namespace: 'activity',
          kind: 'workflow_run.v1',
          localId: request.localId,
          payload: {
            v: 1,
            projectionVersion: 1,
            runId: 'wf-tool-1',
            backendId: 'claude',
            agentId: 'claude',
            title: 'Implement Feature',
            status: 'active',
            workflowToolUseId: 'wf-tool-1',
            recordRevision: '7',
            updatedAt: 1,
            totalAgents: 0,
            completedAgents: 0,
            phases: [],
            agents: [],
          },
        }
      : null);

    const runtime = createClaudeUnifiedWorkflowRuntime({
      backendId: 'claude',
      agentId: 'claude',
      getCurrentClaudeSessionId: () => 'claude-session-1',
      debounceMs: 0,
      readSystemRecord,
      writeSystemRecord: async (request) => {
        systemRecordCalls.push(request);
      },
      writeMetadata: async () => {},
    });

    runtime.observeTranscriptMessage(workflowToolUse({ id: 'wf-tool-1', name: 'Implement Feature' }));
    runtime.observeTranscriptMessage(taskProgress({
      toolUseId: 'wf-tool-1',
      workflowProgress: TWO_AGENT_PROGRESS,
    }));
    await runtime.flush();

    expect(readSystemRecord).toHaveBeenCalledWith({
      namespace: 'activity',
      localId: 'activity:workflow_run:v1:wf-tool-1',
      reason: 'claude_workflow_activity_record_readback',
    });
    expect(systemRecordCalls.at(-1)?.payload).toMatchObject({
      runId: 'wf-tool-1',
      // The start snapshot advances 7 -> 8, then the progress snapshot queued behind that
      // in-flight readback advances 8 -> 9. flush() is a true drain barrier and awaits both.
      recordRevision: '9',
    });
    runtime.dispose();
  });

  it('keeps the headline pointing only at runs whose record write succeeded (failure isolation)', async () => {
    const systemRecordLocalIds: string[] = [];
    let metadata: Record<string, unknown> = {};

    const runtime = createClaudeUnifiedWorkflowRuntime({
      backendId: 'claude',
      agentId: 'claude',
      getCurrentClaudeSessionId: () => 'claude-session-1',
      debounceMs: 0,
      writeSystemRecord: async (request) => {
        systemRecordLocalIds.push(request.localId);
        throw new Error('transient record write failure');
      },
      writeMetadata: async (request) => {
        metadata = applyMetadataWrite(metadata, request);
      },
    });

    runtime.observeTranscriptMessage(workflowToolUse({ id: 'wf-tool-1', name: 'Implement Feature' }));
    runtime.observeTranscriptMessage(taskProgress({
      toolUseId: 'wf-tool-1',
      workflowProgress: TWO_AGENT_PROGRESS,
    }));
    await runtime.flush();

    // The record write was attempted...
    expect(systemRecordLocalIds.length).toBeGreaterThan(0);
    // ...but the headline must NOT advertise a run with no durable record behind it.
    const headline = metadata.sessionWorkflowActivityHeadlineV1 as
      | { activeRuns: unknown[]; recentRuns?: unknown[] }
      | undefined;
    expect(headline?.activeRuns ?? []).toHaveLength(0);
    expect(headline?.recentRuns ?? []).toHaveLength(0);
  });

  it('retries headline publishing after a metadata write failure without advancing from tracker input', async () => {
    const systemRecordCalls: SystemRecordCall[] = [];
    let metadata: Record<string, unknown> = {};
    let headlineAttempts = 0;

    const runtime = createClaudeUnifiedWorkflowRuntime({
      backendId: 'claude',
      agentId: 'claude',
      getCurrentClaudeSessionId: () => 'claude-session-1',
      debounceMs: 60_000,
      writeSystemRecord: async (request) => {
        systemRecordCalls.push(request);
      },
      writeMetadata: async (request) => {
        headlineAttempts += 1;
        if (headlineAttempts === 1) {
          throw new Error('headline metadata unavailable');
        }
        metadata = applyMetadataWrite(metadata, request);
      },
    });

    runtime.observeTranscriptMessage(workflowToolUse({ id: 'wf-tool-1', name: 'Implement Feature' }));
    runtime.observeTranscriptMessage(taskProgress({
      toolUseId: 'wf-tool-1',
      workflowProgress: TWO_AGENT_PROGRESS,
    }));

    await waitForCondition(() => headlineAttempts === 1);
    expect(metadata.sessionWorkflowActivityHeadlineV1).toBeUndefined();

    await runtime.flush();

    const headline = metadata.sessionWorkflowActivityHeadlineV1 as
      | { activeRuns: Array<{ runId: string; recordRevision: string }> }
      | undefined;
    const lastRecord = systemRecordCalls.at(-1);
    expect(headline?.activeRuns).toEqual([
      expect.objectContaining({
        runId: 'wf-tool-1',
        recordRevision: lastRecord?.payload.recordRevision,
      }),
    ]);
    expect(lastRecord?.payload).toMatchObject({ runId: 'wf-tool-1' });
    expect(headlineAttempts).toBe(2);
    runtime.dispose();
  });

  it('exposes workflow-owned agent tool-use ids for the CWF4 suppression hook', async () => {
    const runtime = createClaudeUnifiedWorkflowRuntime({
      backendId: 'claude',
      agentId: 'claude',
      getCurrentClaudeSessionId: () => 'claude-session-1',
      debounceMs: 0,
      writeSystemRecord: async () => {},
      writeMetadata: async () => {},
    });

    runtime.observeTranscriptMessage(workflowToolUse({ id: 'wf-tool-1', name: 'Implement Feature' }));
    // A child subagent tool-use whose parent is the workflow run — its tool-use id is workflow-owned.
    runtime.observeTranscriptMessage(subagentTask({ id: 'subagent-tool-1', parentToolUseId: 'wf-tool-1' }));

    const owned = runtime.getWorkflowOwnedAgentToolUseIds();
    expect(owned.has('subagent-tool-1')).toBe(true);
    runtime.dispose();
  });

  it('returns terminal run observations so terminal runtimes can clear workflow blockers', () => {
    const runtime = createClaudeUnifiedWorkflowRuntime({
      backendId: 'claude',
      agentId: 'claude',
      getCurrentClaudeSessionId: () => 'claude-session-1',
      debounceMs: 0,
      writeSystemRecord: async () => {},
      writeMetadata: async () => {},
    });

    runtime.observeTranscriptMessage(workflowToolUse({ id: 'wf-tool-1', name: 'Implement Feature' }));
    runtime.observeTranscriptMessage(taskStarted({ toolUseId: 'wf-tool-1', taskId: 'task-1' }));
    const observation = runtime.observeTranscriptMessage(taskUpdatedCompleted({ taskId: 'task-1' }));

    expect(observation.terminalRunIds).toEqual(['wf-tool-1']);
    expect(observation.statusChangedRunIds).toEqual(['wf-tool-1']);
    runtime.dispose();
  });

  it('reconciles startup crash residue through the normal record-first publisher path', async () => {
    const order: string[] = [];
    const systemRecordCalls: SystemRecordCall[] = [];
    let metadata: Record<string, unknown> = {};
    const runtime = createClaudeUnifiedWorkflowRuntime({
      backendId: 'claude',
      agentId: 'claude',
      getCurrentClaudeSessionId: () => 'claude-session-1',
      debounceMs: 60_000,
      writeSystemRecord: async (request) => {
        order.push('record');
        systemRecordCalls.push(request);
      },
      writeMetadata: async (request) => {
        order.push('headline');
        metadata = applyMetadataWrite(metadata, request);
      },
    });

    await runtime.reconcileStartupInterruptedRuns([{
      runId: 'wf_stale',
      title: 'Stale workflow',
      workflowToolUseId: 'toolu_stale',
      totalAgents: 17,
      completedAgents: 3,
      failedAgents: 2,
      blockedAgents: 1,
    }]);

    expect(order).toEqual(['record', 'headline']);
    expect(systemRecordCalls.at(-1)?.payload).toMatchObject({
      runId: 'wf_stale',
      status: 'stopped',
      statusReason: 'interrupted',
      totalAgents: 17,
      completedAgents: 3,
      failedAgents: 2,
      blockedAgents: 1,
    });
    expect(metadata.sessionWorkflowActivityHeadlineV1).toMatchObject({
      activeRuns: [],
      recentRuns: [expect.objectContaining({
        runId: 'wf_stale',
        status: 'stopped',
        statusReason: 'interrupted',
      })],
    });
    runtime.dispose();
  });

  it('leaves a startup candidate alone when transcript replay already resumed that run', async () => {
    const systemRecordCalls: SystemRecordCall[] = [];
    const runtime = createClaudeUnifiedWorkflowRuntime({
      backendId: 'claude',
      agentId: 'claude',
      getCurrentClaudeSessionId: () => 'claude-session-1',
      debounceMs: 60_000,
      writeSystemRecord: async (request) => {
        systemRecordCalls.push(request);
      },
      writeMetadata: async () => {},
    });
    runtime.observeTranscriptMessage(workflowToolUse({ id: 'wf_resumed', name: 'Resumed workflow' }));

    await runtime.reconcileStartupInterruptedRuns([{
      runId: 'wf_resumed',
      title: 'Resumed workflow',
      totalAgents: 2,
      completedAgents: 0,
    }]);

    await runtime.flush();
    expect(systemRecordCalls.length).toBeGreaterThan(0);
    expect(systemRecordCalls.every((call) => (
      call.payload.status === 'active' && call.payload.statusReason === undefined
    ))).toBe(true);
    runtime.dispose();
  });

  it('automatically reconciles active runs from the persisted startup headline after the grace window', async () => {
    const systemRecordCalls: SystemRecordCall[] = [];
    const runtime = createClaudeUnifiedWorkflowRuntime({
      backendId: 'claude',
      agentId: 'claude',
      getCurrentClaudeSessionId: () => 'claude-session-1',
      initialWorkflowActivityHeadline: {
        v: 1,
        backendId: 'claude',
        updatedAt: 1000,
        primaryRunId: 'wf_stale',
        activeRuns: [{
          runId: 'wf_stale',
          title: 'Stale workflow',
          status: 'active',
          workflowToolUseId: 'toolu_stale',
          updatedAt: 1000,
          recordRevision: '4',
          recordUpdatedAt: 1000,
          totalAgents: 5,
          completedAgents: 2,
        }],
      },
      startupReconcileGraceMs: 0,
      debounceMs: 60_000,
      writeSystemRecord: async (request) => {
        systemRecordCalls.push(request);
      },
      writeMetadata: async () => {},
    });

    await waitForCondition(() => systemRecordCalls.length > 0);

    expect(systemRecordCalls.at(-1)?.payload).toMatchObject({
      runId: 'wf_stale',
      status: 'stopped',
      statusReason: 'interrupted',
      totalAgents: 5,
      completedAgents: 2,
    });
    runtime.dispose();
  });

  it('contains a failed startup metadata flush and retries the stale-run reconciliation', async () => {
    let metadataAttempts = 0;
    let metadata: Record<string, unknown> = {};
    const loggedErrors: Array<{ message: string; error: unknown }> = [];
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);

    const runtime = createClaudeUnifiedWorkflowRuntime({
      backendId: 'claude',
      agentId: 'claude',
      getCurrentClaudeSessionId: () => 'claude-session-1',
      initialWorkflowActivityHeadline: {
        v: 1,
        backendId: 'claude',
        updatedAt: 1000,
        primaryRunId: 'wf_stale',
        activeRuns: [{
          runId: 'wf_stale',
          title: 'Stale workflow',
          status: 'active',
          workflowToolUseId: 'toolu_stale',
          updatedAt: 1000,
          recordRevision: '4',
          recordUpdatedAt: 1000,
          totalAgents: 5,
          completedAgents: 2,
        }],
      },
      startupReconcileGraceMs: 0,
      debounceMs: 5,
      writeSystemRecord: async () => {},
      writeMetadata: async (request) => {
        metadataAttempts += 1;
        if (metadataAttempts === 1) {
          throw new Error('startup headline unavailable');
        }
        metadata = applyMetadataWrite(metadata, request);
      },
      logError: (message, error) => {
        loggedErrors.push({ message, error });
      },
    });

    try {
      await waitForCondition(() => metadataAttempts >= 2);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(unhandled).toEqual([]);
      expect(loggedErrors).toContainEqual({
        message: 'workflow activity publish drain failed (non-fatal)',
        error: expect.objectContaining({ message: 'startup headline unavailable' }),
      });
      expect(metadata.sessionWorkflowActivityHeadlineV1).toMatchObject({
        activeRuns: [],
        recentRuns: [expect.objectContaining({
          runId: 'wf_stale',
          status: 'stopped',
          statusReason: 'interrupted',
        })],
      });
    } finally {
      runtime.dispose();
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('hydrates unified Workflow launch results from the sidecar journal', async () => {
    const transcriptDir = '/tmp/happier-workflow/wf_123';
    const systemRecordCalls: SystemRecordCall[] = [];
    const journalRows = [
      { type: 'started', key: 'lane-1', agentId: 'agent_alpha' },
      { type: 'started', key: 'lane-2', agentId: 'agent_beta' },
      {
        type: 'result',
        key: 'lane-1',
        agentId: 'agent_alpha',
        result: {
          lane: 'alpha-review',
          verdict: 'plan_correct',
          summary: 'Alpha lane finished.',
        },
      },
    ];
    const followedPaths: string[] = [];
    const fileFollow = {
      follow: vi.fn(async (input: TranscriptFileFollowInputV1): Promise<TranscriptFileFollowHandleV1> => {
        followedPaths.push(input.path);
        let drained = false;
        const drainNow = async () => {
          if (drained) return;
          drained = true;
          let sequence = 0;
          for (const row of journalRows) {
            sequence += 1;
            await input.onLine({
              line: JSON.stringify(row),
              sourcePath: input.path,
              sequence,
            });
          }
        };
        return {
          id: 'journal-follow',
          drainNow,
          close: async (options) => {
            if (options?.finalDrain) await drainNow();
          },
        };
      }),
    };

    const runtime = createClaudeUnifiedWorkflowRuntime({
      backendId: 'claude',
      agentId: 'claude',
      getCurrentClaudeSessionId: () => 'claude-session-1',
      debounceMs: 0,
      writeSystemRecord: async (request) => {
        systemRecordCalls.push(request);
      },
      writeMetadata: async () => {},
      fileFollow,
    });

    runtime.observeTranscriptMessage(workflowToolUse({ id: 'wf-tool-1', name: 'Implement Feature' }));
    runtime.observeTranscriptMessage(workflowLaunchResult({ toolUseId: 'wf-tool-1', transcriptDir }));
    await runtime.flush();

    expect(fileFollow.follow).toHaveBeenCalledTimes(1);
    expect(followedPaths).toEqual([join(transcriptDir, 'journal.jsonl')]);
    const lastRecord = systemRecordCalls[systemRecordCalls.length - 1];
    expect(lastRecord?.payload).toMatchObject({
      runId: 'wf-tool-1',
      totalAgents: 2,
      completedAgents: 1,
      agents: [
        { id: 'agent_alpha', title: 'alpha-review', status: 'complete' },
        { id: 'agent_beta', title: 'agent_beta', status: 'active' },
      ],
      phases: [
        { title: 'Verify', agentIds: ['agent_alpha', 'agent_beta'] },
      ],
    });
    expect(JSON.stringify(lastRecord?.payload)).toContain('Alpha lane finished.');
    runtime.dispose();
  });
});
