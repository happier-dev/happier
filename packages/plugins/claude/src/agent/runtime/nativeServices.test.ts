import { describe, expect, it, vi } from 'vitest';
import type { AgentSessionRuntimeContext } from '@happier-dev/plugin-sdk/agent-runtime';

import { createClaudeUnifiedWorkflowRuntime } from '../workflowRecords/workflowRuntime.js';
import {
  createClaudeNativeAgentSdkContext,
  createClaudeNativeGoalWorkStatePublisher,
} from './nativeServices.js';

function workflowToolUse(): unknown {
  return {
    type: 'assistant',
    session_id: 'claude-session-native',
    uuid: 'uuid-workflow-native',
    message: {
      content: [{
        type: 'tool_use',
        id: 'workflow-native',
        name: 'Workflow',
        input: {
          script: "export const meta = { name: 'Native workflow', phases: [{ title: 'Implement' }] }",
        },
      }],
    },
  };
}

function workflowProgress(): unknown {
  return {
    type: 'system',
    subtype: 'task_progress',
    task_id: 'workflow-task-native',
    tool_use_id: 'workflow-native',
    task_type: 'local_workflow',
    session_id: 'claude-session-native',
    workflow_progress: [
      { type: 'workflow_phase', index: 1, title: 'Implement' },
      {
        type: 'workflow_agent',
        agentId: 'agent-native',
        label: 'coder',
        phaseIndex: 1,
        phaseTitle: 'Implement',
        state: 'running',
      },
    ],
    uuid: 'uuid-progress-native',
  };
}

describe('createClaudeNativeAgentSdkContext', () => {
  it('publishes Claude goal snapshots through the declared native work-state source', async () => {
    const publish = vi.fn(async () => ({
      status: 'applied' as const,
      revision: 'revision-1',
      sourceSequence: 1,
    }));
    const publisher = vi.fn(() => ({ publish }));
    const context = { workState: { publisher } } as unknown as AgentSessionRuntimeContext;
    const publishGoal = createClaudeNativeGoalWorkStatePublisher(context);

    publishGoal({
      v: 1,
      backendId: 'claude',
      agentId: 'claude',
      updatedAt: 123,
      primaryItemId: 'goal:claude',
      items: [{
        id: 'goal:claude',
        kind: 'goal',
        origin: 'vendor',
        status: 'active',
        title: 'Ship native Claude',
        backendId: 'claude',
        agentId: 'claude',
        vendorRef: 'goal-revision-1',
        tokensUsed: 42,
        updatedAt: 123,
      }],
    });

    await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(1));
    expect(publisher).toHaveBeenCalledWith('goals');
    expect(publish).toHaveBeenCalledWith({
      sourceSequence: 1,
      observedAtMs: 123,
      primaryLocalId: 'goal:claude',
      items: [{
        localId: 'goal:claude',
        kind: 'goal',
        origin: 'vendor',
        status: 'active',
        title: 'Ship native Claude',
        providerRef: 'goal-revision-1',
        tokensUsed: 42,
        updatedAtMs: 123,
      }],
    });
  });

  it('delegates typed workflow records through the session-scoped native system-record service', async () => {
    const write = vi.fn(async () => undefined);
    const read = vi.fn(async () => ({
      namespace: 'activity' as const,
      kind: 'workflow_run.v1' as const,
      localId: 'workflow:wf-1',
      payload: {
        v: 1,
        projectionVersion: 1,
        runId: 'wf-1',
        backendId: 'claude',
        agentId: 'claude',
        title: 'Implement feature',
        status: 'active',
        recordRevision: '7',
        updatedAt: 1,
        totalAgents: 0,
        completedAgents: 0,
        phases: [],
        agents: [],
      },
    }));
    const context = {
      services: {
        logger: {
          debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
        },
        exec: {},
      },
      session: {
        services: {
          systemRecords: { write, read },
        },
      },
    } as unknown as AgentSessionRuntimeContext;
    const native = createClaudeNativeAgentSdkContext(context, context);
    const request = {
      namespace: 'activity' as const,
      kind: 'workflow_run.v1' as const,
      localId: 'workflow:wf-1',
      payload: (await read()).payload,
      reason: 'claude_workflow_activity_record',
    };

    await expect(native.sessions.current.writeSystemRecord?.(request)).resolves.toBeUndefined();
    await expect(native.sessions.current.readSystemRecord?.({
      namespace: 'activity',
      localId: 'workflow:wf-1',
      reason: 'claude_workflow_activity_record_readback',
    })).resolves.toMatchObject({ kind: 'workflow_run.v1', localId: 'workflow:wf-1' });

    expect(write).toHaveBeenCalledWith({
      namespace: 'activity',
      kind: 'workflow_run.v1',
      localId: 'workflow:wf-1',
      payload: request.payload,
    });
    expect(read).toHaveBeenCalledWith({ namespace: 'activity', localId: 'workflow:wf-1' });
  });

  it('publishes the workflow record before its compact headline through the semantic native service', async () => {
    const order: string[] = [];
    const headlineWrites: unknown[] = [];
    const context = {
      services: {
        logger: {
          debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
        },
        exec: {},
      },
      session: {
        services: {
          systemRecords: {
            write: vi.fn(async () => { order.push('record'); }),
            read: vi.fn(async () => null),
          },
          workflowActivity: {
            publishHeadline: vi.fn(async (headline: unknown) => {
              order.push('headline');
              headlineWrites.push(headline);
            }),
          },
        },
      },
    } as unknown as AgentSessionRuntimeContext;
    const native = createClaudeNativeAgentSdkContext(context, context);
    const runtime = createClaudeUnifiedWorkflowRuntime({
      backendId: 'claude',
      agentId: 'claude',
      getCurrentClaudeSessionId: () => 'claude-session-native',
      debounceMs: 0,
      writeSystemRecord: async (request) => {
        await native.sessions.current.writeSystemRecord?.(request);
      },
      writeMetadata: async (request) => {
        await native.sessions.current.writeMetadata(request);
      },
    });

    runtime.observeTranscriptMessage(workflowToolUse());
    runtime.observeTranscriptMessage(workflowProgress());
    await runtime.flush();

    expect(order[0]).toBe('record');
    expect(order[order.length - 1]).toBe('headline');
    expect(headlineWrites.length).toBeGreaterThan(0);
    expect(headlineWrites[headlineWrites.length - 1]).toMatchObject({
      v: 1,
      backendId: 'claude',
      primaryRunId: 'workflow-native',
      activeRuns: [{ runId: 'workflow-native', totalAgents: 1 }],
    });
    expect(JSON.stringify(headlineWrites[headlineWrites.length - 1])).not.toContain('workflow_agent');
    for (let index = 0; index < order.length; index += 1) {
      if (order[index] === 'headline') expect(order[index - 1]).toBe('record');
    }
    runtime.dispose();
  });

  it('rejects every native legacy metadata request except the locked workflow headline projection', async () => {
    const publishHeadline = vi.fn(async () => undefined);
    const context = {
      services: {
        logger: {
          debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
        },
        exec: {},
      },
      session: {
        services: {
          workflowActivity: { publishHeadline },
        },
      },
    } as unknown as AgentSessionRuntimeContext;
    const native = createClaudeNativeAgentSdkContext(context, context);

    await expect(native.sessions.current.writeMetadata({
      kind: 'update',
      handler: (current) => ({ ...current, arbitrary: true }),
      reason: 'claude_arbitrary_metadata',
    })).rejects.toThrow(/unavailable/u);
    expect(publishHeadline).not.toHaveBeenCalled();
  });
});
