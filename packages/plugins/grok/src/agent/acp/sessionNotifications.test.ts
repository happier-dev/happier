import { describe, expect, it, vi } from 'vitest';

import {
  createGrokSessionNotificationObserver,
  projectGrokWorkflowUpdate,
} from './sessionNotifications.js';

type GrokSessionNotificationObserverContext = Parameters<
  typeof createGrokSessionNotificationObserver
>[0]['context'];

describe('Grok session notifications', () => {
  it('projects the complete workflow update and rejects an older provider revision', async () => {
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
      agent_usage_incomplete: false,
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

    const publishHeadlines = vi.fn(async () => undefined);
    const upsertSystemRecord = vi.fn(async () => ({ revision: '1' }));
    const observer = createGrokSessionNotificationObserver({
      context: {
        session: { services: { workflowActivity: { publishHeadlines } } },
        workState: { publisher: vi.fn(() => ({ publish: vi.fn() })) },
        services: {
          logger: { warn: vi.fn() },
          sessions: {
            current: { upsertSystemRecord, readSystemRecord: vi.fn(async () => null) },
            subagents: { observe: vi.fn() },
          },
        },
      } satisfies GrokSessionNotificationObserverContext,
      now: () => now,
    });
    const extensionContext = { providerSessionId: 'session-1', signal: new AbortController().signal } as never;
    const update = {
      sessionId: 'session-1',
      update: {
        sessionUpdate: 'workflow_updated', run_id: 'run-1', revision: 7, name: 'Ship it', objective: 'Finish',
        status: 'active', elapsed_ms: 1, agents_used: 0, agents_reserved: 0, active_agents: 0,
      },
    };
    await observer(update, extensionContext);
    await observer({ ...update, update: { ...update.update, revision: 6, status: 'failed' } }, extensionContext);
    expect(upsertSystemRecord).toHaveBeenCalledTimes(1);
    expect(publishHeadlines).toHaveBeenCalledTimes(1);
  });

  it('routes subagent lifecycle and goal state into existing host services', async () => {
    const observe = vi.fn(async (input) => input);
    const publish = vi.fn(async () => ({ status: 'applied', revision: '1', sourceSequence: 1 }));
    const observer = createGrokSessionNotificationObserver({
      context: {
        session: { services: { workflowActivity: { publishHeadlines: vi.fn() } } },
        workState: { publisher: vi.fn(() => ({ publish })) },
        services: {
          logger: { warn: vi.fn() },
          sessions: { current: null, subagents: { observe } },
        },
      } satisfies GrokSessionNotificationObserverContext,
      now: () => 2_000,
    });
    const extensionContext = { providerSessionId: 'parent', signal: new AbortController().signal } as never;

    await observer({ sessionId: 'parent', update: {
      sessionUpdate: 'subagent_spawned', subagent_id: 'sub-1', parent_session_id: 'parent',
      child_session_id: 'child-1', subagent_type: 'explore', description: 'Inspect code', model: 'grok-4.5',
      workflow_run_id: 'run-1',
    } }, extensionContext);
    await observer({ sessionId: 'parent', update: {
      sessionUpdate: 'subagent_finished', subagent_id: 'sub-1', child_session_id: 'child-1',
      status: 'completed', tool_calls: 3, turns: 2, duration_ms: 500, tokens_used: 100, output: 'Done',
    } }, extensionContext);
    expect(observe).toHaveBeenNthCalledWith(1, expect.objectContaining({
      observationId: 'grok-native:sub-1', groupId: 'run-1', status: 'running',
    }), expect.anything());
    expect(observe).toHaveBeenNthCalledWith(2, expect.objectContaining({
      observationId: 'grok-native:sub-1', groupId: 'run-1', status: 'completed',
    }), expect.anything());

    await observer({ sessionId: 'parent', update: {
      sessionUpdate: 'goal_updated', goal_id: 'goal-1', objective: 'Ship', status: 'active', phase: 'executing',
      token_budget: 1_000, tokens_used: 250, elapsed_ms: 10_000, total_deliverables: 2,
      completed_deliverables: 1, total_worker_rounds: 1, total_verify_rounds: 0,
    } }, extensionContext);
    await observer({ params: { sessionId: 'parent', update: {
      sessionUpdate: 'goal_updated', goal_id: 'goal-1', objective: 'Ship', status: 'active',
    } } }, extensionContext);
    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({
      items: [expect.objectContaining({
        localId: 'grok-goal:goal-1', kind: 'goal', status: 'active', title: 'Ship', tokenBudget: 1_000,
        tokensUsed: 250, progress: 0.5,
      })],
      primaryLocalId: 'grok-goal:goal-1',
    }), expect.anything());
  });
});
