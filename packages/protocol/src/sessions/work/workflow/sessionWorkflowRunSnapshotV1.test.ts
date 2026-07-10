import { describe, expect, it } from 'vitest';

import {
  SESSION_WORKFLOW_RUN_SNAPSHOT_PROJECTION_VERSION,
  SessionWorkflowRunSnapshotV1Schema,
  resolveWorkflowAgentPhaseTitle,
  type SessionWorkflowRunSnapshotV1,
} from './index.js';

function baseRun(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    projectionVersion: SESSION_WORKFLOW_RUN_SNAPSHOT_PROJECTION_VERSION,
    runId: 'wf_demo',
    backendId: 'claude',
    title: 'Demo workflow',
    status: 'active',
    recordRevision: '1',
    updatedAt: 1000,
    totalAgents: 0,
    completedAgents: 0,
    phases: [],
    agents: [],
    ...overrides,
  };
}

describe('SessionWorkflowRunSnapshotV1Schema', () => {
  it('accepts a minimal valid run snapshot with empty phases/agents', () => {
    expect(SessionWorkflowRunSnapshotV1Schema.safeParse(baseRun()).success).toBe(true);
  });

  it('accepts only the canonical interrupted qualifier for synthetically stopped runs', () => {
    expect(SessionWorkflowRunSnapshotV1Schema.safeParse(baseRun({
      status: 'stopped',
      statusReason: 'interrupted',
    })).success).toBe(true);
    expect(SessionWorkflowRunSnapshotV1Schema.safeParse(baseRun({
      status: 'stopped',
      statusReason: 'unknown-reason',
    })).success).toBe(false);
  });

  it('accepts phases and agents with metrics', () => {
    const parsed = SessionWorkflowRunSnapshotV1Schema.safeParse(baseRun({
      status: 'complete',
      workflowToolUseId: 'toolu_1',
      sourceSessionId: 'claude-session-1',
      sourceRevision: 'uuid_5',
      startedAt: 100,
      completedAt: 2000,
      totalAgents: 2,
      completedAgents: 2,
      tokensUsed: 61609,
      toolCalls: 0,
      timeUsedSeconds: 1.655,
      phases: [{ id: 'phase:1', title: 'Demo', order: 1, agentIds: ['agent_1', 'agent_2'] }],
      agents: [
        {
          id: 'agent_1',
          title: 'agent-alpha',
          status: 'complete',
          phaseIndex: 1,
          phaseTitle: 'Demo',
          model: 'claude-opus-4-8[1m]',
          resultPreview: 'alpha',
          tokensUsed: 30805,
          toolCalls: 0,
          timeUsedSeconds: 1.645,
          updatedAt: 900,
        },
        {
          id: 'agent_2',
          title: 'agent-beta',
          status: 'complete',
          phaseIndex: 1,
          phaseTitle: 'Demo',
          model: 'claude-opus-4-8[1m]',
          resultPreview: 'beta',
          tokensUsed: 30804,
          toolCalls: 0,
          timeUsedSeconds: 1.565,
          updatedAt: 950,
        },
      ],
    }));
    expect(parsed.success).toBe(true);
  });

  it('preserves all agent ids and exact counts for a 300-agent multi-phase run', () => {
    const phases = Array.from({ length: 3 }, (_, p) => ({
      id: `phase:${p + 1}`,
      title: `Phase ${p + 1}`,
      order: p + 1,
      agentIds: Array.from({ length: 100 }, (_, a) => `agent_${p * 100 + a}`),
    }));
    const agents = Array.from({ length: 300 }, (_, i) => ({
      id: `agent_${i}`,
      title: `agent-${i}`,
      status: i % 7 === 0 ? 'failed' : 'complete',
      phaseIndex: Math.floor(i / 100) + 1,
      updatedAt: 1000 + i,
    }));
    const parsed = SessionWorkflowRunSnapshotV1Schema.safeParse(baseRun({
      status: 'complete',
      totalAgents: 300,
      completedAgents: 257,
      failedAgents: 43,
      phases,
      agents,
    }));
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const snapshot = parsed.data as SessionWorkflowRunSnapshotV1;
    expect(snapshot.agents).toHaveLength(300);
    expect(snapshot.totalAgents).toBe(300);
    expect(new Set(snapshot.agents.map((a) => a.id)).size).toBe(300);
    expect(snapshot.phases.reduce((sum, phase) => sum + phase.agentIds.length, 0)).toBe(300);
  });

  it('rejects malformed required fields', () => {
    const stalePreProjectionVersion = baseRun();
    delete stalePreProjectionVersion.projectionVersion;
    expect(SessionWorkflowRunSnapshotV1Schema.safeParse(stalePreProjectionVersion).success).toBe(false);
    expect(SessionWorkflowRunSnapshotV1Schema.safeParse(baseRun({ v: 2 })).success).toBe(false);
    expect(SessionWorkflowRunSnapshotV1Schema.safeParse(baseRun({ runId: '' })).success).toBe(false);
    expect(SessionWorkflowRunSnapshotV1Schema.safeParse(baseRun({ status: 'running' })).success).toBe(false);
    expect(SessionWorkflowRunSnapshotV1Schema.safeParse(baseRun({ recordRevision: '' })).success).toBe(false);
    expect(SessionWorkflowRunSnapshotV1Schema.safeParse(baseRun({ recordRevision: 'rev-1' })).success).toBe(false);
    expect(SessionWorkflowRunSnapshotV1Schema.safeParse(baseRun({ totalAgents: -1 })).success).toBe(false);
    expect(SessionWorkflowRunSnapshotV1Schema.safeParse(baseRun({
      agents: [{ id: 'a', title: 'a', status: 'pending' }],
    })).success).toBe(false); // missing agent.updatedAt
  });
});

describe('resolveWorkflowAgentPhaseTitle', () => {
  it('treats phases[] as authoritative over agent-level phaseTitle', () => {
    const snapshot = {
      phases: [{ id: 'phase:1', title: 'Research', order: 1, agentIds: ['a1'] }],
    } as const;
    expect(resolveWorkflowAgentPhaseTitle(snapshot, { id: 'a1', phaseIndex: 1, phaseTitle: 'STALE' })).toBe('Research');
  });

  it('falls back to the agent phaseTitle when no phase row matches', () => {
    const snapshot = { phases: [] } as const;
    expect(resolveWorkflowAgentPhaseTitle(snapshot, { id: 'a1', phaseIndex: 1, phaseTitle: 'Implementation' })).toBe('Implementation');
  });

  it('matches by phase order when membership is not recorded', () => {
    const snapshot = {
      phases: [{ id: 'phase:2', title: 'Review', order: 2, agentIds: [] }],
    } as const;
    expect(resolveWorkflowAgentPhaseTitle(snapshot, { id: 'a9', phaseIndex: 2, phaseTitle: 'STALE' })).toBe('Review');
  });
});
