import { describe, expect, it, vi } from 'vitest';

import type { AcpExtensionHandlerContext } from '@/agent/acp/AcpBackend';
import {
  createGrokSessionNotificationObserver,
  projectGrokWorkflowUpdate,
} from './sessionNotifications';

function context(sessionId = 'parent'): AcpExtensionHandlerContext {
  return {
    method: 'x.ai/session_notification',
    sessionId,
    signal: new AbortController().signal,
    agentName: 'grok',
  };
}

describe('Grok ACP session notifications', () => {
  it('projects complete workflow metadata and rejects an older provider revision', async () => {
    const now = 1_000_000;
    expect(projectGrokWorkflowUpdate({
      sessionUpdate: 'workflow_updated',
      run_id: 'run-1',
      revision: 7,
      name: 'Ship it',
      objective: 'Finish the integration',
      status: 'active',
      phases: [{ title: 'Build', state: 'active' }],
      agent_budget: 8,
      agents_used: 2,
      agents_reserved: 1,
      agents_remaining: 5,
      elapsed_ms: 10_000,
      active_agents: 1,
      agents: [{
        agent_id: 'agent-1',
        label: 'Builder',
        phase: 'Build',
        model: 'grok-4.5',
        state: 'running',
        tokens_used: 123,
        duration_ms: 4_000,
      }],
      last_event: 'tool',
      last_event_detail: 'editing',
    }, { now })).toMatchObject({
      runId: 'run-1',
      backendId: 'grok',
      sourceRevision: '7',
      title: 'Ship it',
      status: 'active',
      startedAt: 990_000,
      totalAgents: 3,
      completedAgents: 0,
      phases: [{ id: 'phase:0', title: 'Build', order: 0, agentIds: ['agent-1'] }],
      agents: [{
        id: 'agent-1',
        title: 'Builder',
        status: 'active',
        phaseIndex: 0,
        phaseTitle: 'Build',
        model: 'grok-4.5',
        tokensUsed: 123,
        timeUsedSeconds: 4,
      }],
      objective: 'Finish the integration',
      agentBudget: 8,
      agentsReserved: 1,
      agentsRemaining: 5,
      lastEvent: 'tool',
      lastEventDetail: 'editing',
    });

    const publishWorkflowSnapshot = vi.fn(async () => true);
    const observer = createGrokSessionNotificationObserver({
      publishWorkflowSnapshot,
      publishGoalWorkState: vi.fn(),
      now: () => now,
    });
    const update = {
      sessionId: 'parent',
      update: {
        sessionUpdate: 'workflow_updated',
        run_id: 'run-1',
        revision: 7,
        name: 'Ship it',
        objective: 'Finish',
        status: 'active',
      },
    };
    await observer(update, context());
    await observer({ ...update, update: { ...update.update, revision: 6, status: 'failed' } }, context());

    expect(publishWorkflowSnapshot).toHaveBeenCalledTimes(1);
  });

  it('serializes direct and wrapped goal updates into the existing work-state contract', async () => {
    const publishGoalWorkState = vi.fn(async () => undefined);
    const observer = createGrokSessionNotificationObserver({
      publishWorkflowSnapshot: vi.fn(),
      publishGoalWorkState,
      now: () => 2_000,
    });
    const update = {
      sessionId: 'parent',
      update: {
        sessionUpdate: 'goal_updated',
        goal_id: 'goal-1',
        objective: 'Ship',
        status: 'active',
        token_budget: 1_000,
        tokens_used: 250,
        elapsed_ms: 10_000,
        total_deliverables: 2,
        completed_deliverables: 1,
      },
    };

    await Promise.all([
      observer(update, context()),
      observer({ method: '_x.ai/session_notification', params: update }, context()),
      observer({ params: update }, { ...context(), method: '_x.ai/session/update' }),
    ]);

    expect(publishGoalWorkState).toHaveBeenCalledTimes(3);
    expect(publishGoalWorkState).toHaveBeenLastCalledWith(expect.objectContaining({
      v: 1,
      backendId: 'grok',
      agentId: 'grok',
      items: [expect.objectContaining({
        id: 'grok.goal:goal-1',
        kind: 'goal',
        origin: 'vendor',
        status: 'active',
        title: 'Ship',
        tokenBudget: 1_000,
        tokensUsed: 250,
        progress: 0.5,
      })],
      primaryItemId: 'grok.goal:goal-1',
    }));
  });

  it('ignores notifications for a different bound provider session', async () => {
    const publishWorkflowSnapshot = vi.fn();
    const publishGoalWorkState = vi.fn();
    const observer = createGrokSessionNotificationObserver({
      publishWorkflowSnapshot,
      publishGoalWorkState,
    });

    await observer({
      sessionId: 'other',
      update: {
        sessionUpdate: 'goal_updated',
        goal_id: 'goal-1',
        objective: 'Ship',
        status: 'active',
      },
    }, context('parent'));

    expect(publishWorkflowSnapshot).not.toHaveBeenCalled();
    expect(publishGoalWorkState).not.toHaveBeenCalled();
  });

  it('projects standalone subagent lifecycle updates through the existing workflow activity owner', async () => {
    let now = 3_000;
    const publishWorkflowSnapshot = vi.fn(async () => true);
    const observer = createGrokSessionNotificationObserver({
      publishWorkflowSnapshot,
      publishGoalWorkState: vi.fn(),
      now: () => now,
    });

    await observer({
      sessionId: 'parent',
      update: {
        sessionUpdate: 'subagent_spawned',
        subagent_id: 'child-1',
        child_session_id: 'child-session-1',
        subagent_type: 'explore',
        description: 'Inspect the ACP integration',
        model: 'grok-4.5',
      },
    }, context());
    now += 100;
    await observer({
      sessionId: 'parent',
      update: {
        sessionUpdate: 'subagent_progress',
        subagent_id: 'child-1',
        duration_ms: 100,
        tokens_used: 120,
        tool_call_count: 2,
      },
    }, context());
    now += 400;
    await observer({
      sessionId: 'parent',
      update: {
        sessionUpdate: 'subagent_finished',
        subagent_id: 'child-1',
        status: 'completed',
        duration_ms: 500,
        tokens_used: 180,
        tool_calls: 3,
        output: 'Found the integration seam',
      },
    }, context());

    expect(publishWorkflowSnapshot).toHaveBeenCalledTimes(3);
    expect(publishWorkflowSnapshot).toHaveBeenLastCalledWith(expect.objectContaining({
      runId: 'implicit:grok-agent-activity',
      title: 'Agent activity',
      status: 'complete',
      totalAgents: 1,
      completedAgents: 1,
      tokensUsed: 180,
      toolCalls: 3,
      agents: [expect.objectContaining({
        id: 'child-1',
        title: 'Inspect the ACP integration',
        status: 'complete',
        model: 'grok-4.5',
        tokensUsed: 180,
        toolCalls: 3,
        timeUsedSeconds: 0.5,
        resultPreview: 'Found the integration seam',
      })],
    }), 3);
  });

  it('does not duplicate workflow-owned subagents into the standalone activity run', async () => {
    const publishWorkflowSnapshot = vi.fn(async () => true);
    const observer = createGrokSessionNotificationObserver({
      publishWorkflowSnapshot,
      publishGoalWorkState: vi.fn(),
    });

    await observer({
      sessionId: 'parent',
      update: {
        sessionUpdate: 'subagent_spawned',
        subagent_id: 'workflow-child',
        workflow_run_id: 'workflow-1',
      },
    }, context());
    await observer({
      sessionId: 'parent',
      update: {
        sessionUpdate: 'subagent_finished',
        subagent_id: 'workflow-child',
        status: 'completed',
      },
    }, context());

    expect(publishWorkflowSnapshot).not.toHaveBeenCalled();
  });
});
